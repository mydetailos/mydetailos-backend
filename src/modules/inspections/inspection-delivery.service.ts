import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import { isOrganizationExpiredOrInactive } from "../../lib/subscription-lock.js";
import type { BranchScope } from "../../lib/data-scope.js";
import { prisma } from "../../lib/prisma.js";
import { readPrivateInspectionAsset } from "../../services/object-storage.service.js";
import { sendViaResend } from "../../services/resend-send.js";
import { sendWhatsAppInspectionDocument, isTwilioWhatsAppEnabled } from "../../services/twilio-sms.service.js";
import { signedInspectionDocumentUrl } from "./inspection-document-access.service.js";

type SendChannel = "WHATSAPP" | "EMAIL";

function sendItem(row: {
  id: string;
  organizationId: string;
  reportId: string;
  revision: number;
  requestId: string;
  channel: string;
  recipient: string;
  status: string;
  providerMessageId: string | null;
  providerError: string | null;
  sentBy: string;
  sentAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    reportId: row.reportId,
    revision: row.revision,
    requestId: row.requestId,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    providerMessageId: row.providerMessageId,
    providerError: row.providerError,
    sentBy: row.sentBy,
    sentAt: row.sentAt,
    updatedAt: row.updatedAt,
  };
}

function textValue(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function healthLabel(value: unknown): string {
  const raw = textValue(value, "N/A");
  if (raw === "N/A") return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function vehicleLabel(snapshot: Record<string, unknown>): string {
  const registration = textValue(snapshot.vehicleRegistration ?? snapshot.registrationNumber, "");
  const model = textValue(
    snapshot.vehicleMakeModel,
    [snapshot.vehicleMake, snapshot.vehicleModel].filter((part) => typeof part === "string" && part.trim()).join(" ")
  );
  if (registration && model) return `${registration} (${model})`;
  return registration || model || "your vehicle";
}

/** Variables for approved template `inspection_report_v2`. */
function inspectionTemplateVariables(input: {
  documentUrl: string;
  customerName: string;
  vehicle: string;
  reportNumber: string;
  workshopName: string;
  overallHealth: string;
  address: string;
  phone: string;
}): Record<string, string> {
  return {
    "1": input.documentUrl,
    "2": input.customerName,
    "3": input.vehicle,
    "4": input.reportNumber,
    "5": input.workshopName,
    "6": input.overallHealth,
    "7": input.address,
    "8": input.phone,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function normalizeTwilioStatus(status: string): "QUEUED" | "SENT" | "FAILED" {
  const normalized = status.toLowerCase();
  if (["failed", "undelivered", "canceled"].includes(normalized)) return "FAILED";
  if (normalized === "sent") return "SENT";
  return "QUEUED";
}

export async function sendInspectionReport(input: {
  scope: BranchScope;
  actorId: string;
  reportId: string;
  revision: number;
  requestId: string;
  channel: SendChannel;
  recipient: string;
}) {
  const existing = await prisma.inspectionSendLog.findFirst({
    where: {
      organizationId: input.scope.organizationId,
      requestId: input.requestId,
      ...(input.scope.allowedBranchIds === null ? {} : { report: { branchId: { in: input.scope.allowedBranchIds } } }),
    },
  });
  if (existing) {
    if (existing.reportId !== input.reportId || existing.revision !== input.revision ||
      existing.channel !== input.channel || existing.recipient !== input.recipient) {
      throw AppError.conflict("This request ID was already used for a different send.");
    }
    return sendItem(existing);
  }

  const report = await prisma.inspectionReport.findFirst({
    where: {
      id: input.reportId,
      organizationId: input.scope.organizationId,
      status: "FINAL",
      revision: input.revision,
      deletedAt: null,
      ...(input.scope.allowedBranchIds === null ? {} : { branchId: { in: input.scope.allowedBranchIds } }),
    },
  });
  if (!report) throw AppError.conflict("Only an accessible finalized revision can be sent.");

  const [version, org] = await Promise.all([
    prisma.inspectionReportVersion.findUnique({
      where: { reportId_revision: { reportId: report.id, revision: input.revision } },
    }),
    prisma.organization.findUnique({
      where: { id: input.scope.organizationId },
      select: {
        isActive: true,
        subscription: {
          select: { status: true, expiresAt: true, currentPeriodEnd: true },
        },
      },
    }),
  ]);
  if (!version?.documentKey) throw AppError.conflict("The finalized inspection PDF is unavailable.");

  if (!org || !org.isActive) {
    throw AppError.forbidden("Inspection PDF sending is blocked because the organization is inactive.");
  }

  const sub = org.subscription;
  if (sub) {
    const expiresAt = sub.expiresAt ?? sub.currentPeriodEnd;
    if (
      isOrganizationExpiredOrInactive({
        orgIsActive: org.isActive,
        subscriptionStatus: sub.status,
        expiresAt,
      })
    ) {
      throw AppError.forbidden("Inspection PDF sending is blocked because the organization subscription has expired.");
    }
  }

  let log;
  try {
    log = await prisma.inspectionSendLog.create({
      data: {
        organizationId: input.scope.organizationId,
        reportId: report.id,
        revision: input.revision,
        requestId: input.requestId,
        channel: input.channel,
        recipient: input.recipient,
        status: "QUEUED",
        documentKey: version.documentKey,
        sentBy: input.actorId,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const raced = await prisma.inspectionSendLog.findUnique({
      where: { organizationId_requestId: { organizationId: input.scope.organizationId, requestId: input.requestId } },
    });
    if (!raced) throw error;
    if (raced.reportId !== input.reportId || raced.revision !== input.revision ||
      raced.channel !== input.channel || raced.recipient !== input.recipient) {
      throw AppError.conflict("This request ID was already used for a different send.");
    }
    return sendItem(raced);
  }

  try {
    const pdf = await readPrivateInspectionAsset(version.documentKey);
    if (!pdf) throw new Error("The canonical inspection PDF could not be read from private storage.");
    const snapshot = version.data && typeof version.data === "object" ? version.data as Record<string, unknown> : {};
    const reportNumber = String(report.reportNumber);
    const customerName = textValue(snapshot.customerName, "Customer");
    const branding = snapshot.organizationBranding && typeof snapshot.organizationBranding === "object"
      ? snapshot.organizationBranding as Record<string, unknown>
      : {};

    if (input.channel === "EMAIL") {
      const result = await sendViaResend({
        to: [input.recipient],
        subject: `Vehicle inspection report ${reportNumber}`,
        html: `<p>Hello ${escapeHtml(customerName)},</p><p>Your finalized vehicle inspection report is attached.</p><p>Report ${escapeHtml(reportNumber)}, revision ${input.revision}.</p>`,
        text: `Your finalized vehicle inspection report is attached. Report ${reportNumber}, revision ${input.revision}.`,
        attachments: [{ filename: `inspection-${reportNumber}-r${input.revision}.pdf`, content: pdf.toString("base64") }],
        tags: [{ name: "inspection_send_id", value: log.id }],
      });
      if (!result.ok) throw new Error(result.detail);
      if (!result.id) throw new Error("Email provider did not return a message ID for delivery tracking.");
      await prisma.inspectionSendLog.updateMany({
        where: { id: log.id, status: "QUEUED" },
        data: { status: "SENT", providerMessageId: result.id ?? null, providerError: null },
      });
      const sent = await prisma.inspectionSendLog.findUniqueOrThrow({ where: { id: log.id } });
      return sendItem(sent);
    }

    const apiOrigin = env.API_PUBLIC_ORIGIN?.replace(/\/+$/, "");
    const templateSid = env.TWILIO_INSPECTION_TEMPLATE_SID?.trim();
    if (!apiOrigin || !env.TWILIO_AUTH_TOKEN || !isTwilioWhatsAppEnabled()) {
      throw new Error("WhatsApp inspection delivery requires API_PUBLIC_ORIGIN, Twilio auth token, and an enabled sender.");
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
    const documentUrl = signedInspectionDocumentUrl(apiOrigin, version.id, expiresAt);
    const callback = new URL("/api/webhooks/inspection-whatsapp", apiOrigin);
    callback.searchParams.set("sendLogId", log.id);
    const provider = await sendWhatsAppInspectionDocument({
      to: input.recipient,
      documentUrl,
      reportNumber,
      customerName,
      statusCallbackUrl: callback.toString(),
      ...(templateSid
        ? {
            contentSid: templateSid,
            contentVariables: inspectionTemplateVariables({
              documentUrl,
              customerName,
              vehicle: vehicleLabel(snapshot),
              reportNumber,
              workshopName: textValue(branding.businessName, "My Detail OS"),
              overallHealth: healthLabel(snapshot.computedOverallRating),
              address: textValue(branding.businessAddress, textValue(snapshot.branchAddress, "N/A")),
              phone: textValue(branding.businessPhone, textValue(branding.businessWhatsApp, "the workshop")),
            }),
          }
        : {}),
    });
    if (provider.twilioErrorCode) throw new Error(provider.twilioErrorMessage ?? `Twilio error ${provider.twilioErrorCode}`);
    await prisma.inspectionSendLog.updateMany({
      where: { id: log.id, status: "QUEUED" },
      data: {
        status: normalizeTwilioStatus(provider.status),
        providerMessageId: provider.sid,
        providerError: null,
      },
    });
    const sent = await prisma.inspectionSendLog.findUniqueOrThrow({ where: { id: log.id } });
    return sendItem(sent);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const failed = await prisma.inspectionSendLog.update({
      where: { id: log.id },
      data: { status: "FAILED", providerError: message },
    });
    return sendItem(failed);
  }
}

export async function updateInspectionWhatsAppStatus(input: {
  sendLogId: string;
  providerMessageId: string;
  providerStatus: string;
  providerError?: string;
}) {
  const normalized = input.providerStatus.toLowerCase();
  const status = ["delivered", "read"].includes(normalized)
    ? "DELIVERED"
    : ["sent"].includes(normalized)
      ? "SENT"
      : ["failed", "undelivered", "canceled"].includes(normalized)
        ? "FAILED"
        : "QUEUED";
  const existing = await prisma.inspectionSendLog.findUnique({ where: { id: input.sendLogId } });
  if (!existing || existing.channel !== "WHATSAPP") return false;
  if (existing.providerMessageId && existing.providerMessageId !== input.providerMessageId) return false;
  const allowed = status === "FAILED"
    ? { status: { in: ["QUEUED", "SENT"] } }
    : status === "DELIVERED"
      ? { status: { in: ["QUEUED", "SENT"] } }
      : { status: "QUEUED" };
  const updated = await prisma.inspectionSendLog.updateMany({
    where: { id: existing.id, ...allowed },
    data: {
      status,
      providerMessageId: input.providerMessageId,
      providerError: input.providerError?.slice(0, 2000) ?? null,
    },
  });
  return updated.count === 1;
}

export async function updateInspectionEmailStatus(input: {
  providerMessageId: string;
  sendLogId?: string;
  eventType: string;
  error?: string;
}) {
  const event = input.eventType.toLowerCase();
  const status = event === "email.delivered"
    ? "DELIVERED"
    : ["email.bounced", "email.failed", "email.complained"].includes(event)
      ? "FAILED"
      : event === "email.sent"
        ? "SENT"
        : null;
  if (!status) return false;
  const updated = await prisma.inspectionSendLog.updateMany({
    where: {
      ...(input.sendLogId ? { id: input.sendLogId } : { providerMessageId: input.providerMessageId }),
      channel: "EMAIL",
      ...(input.sendLogId ? { OR: [{ providerMessageId: null }, { providerMessageId: input.providerMessageId }] } : {}),
      status: { in: status === "SENT" ? ["QUEUED"] : ["QUEUED", "SENT"] },
    },
    data: {
      status,
      providerMessageId: input.providerMessageId,
      providerError: status === "FAILED" ? input.error?.slice(0, 2000) ?? event : null,
    },
  });
  return updated.count === 1;
}
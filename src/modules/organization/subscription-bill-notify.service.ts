import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { isTwilioWhatsAppEnabled, sendWhatsAppMessage } from "../../services/twilio-sms.service.js";
import { writePlatformAuditLog } from "../../lib/platform-audit.js";

export function resolveFrontendBaseUrl(): string {
  if (process.env.FRONTEND_URL?.trim()) {
    return process.env.FRONTEND_URL.trim().replace(/\/$/, "");
  }
  if (process.env.PUBLIC_APP_URL?.trim()) {
    return process.env.PUBLIC_APP_URL.trim().replace(/\/$/, "");
  }
  const origins = (env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const prodOrigin = origins.find((o) => !o.includes("localhost") && !o.includes("127.0.0.1"));
  if (prodOrigin) return prodOrigin;
  return "https://app.mydetailos.com";
}

export type CompactBillPayload = {
  id: string;
  bn: string;
  on: string;
  pn: string;
  tm: number;
  tl: string;
  ps: string;
  pe: string;
  ba: number;
  eb: number;
  eu: number;
  ob: number;
  rd: number;
  gp: number;
  ga: number;
  ta: number;
  am: number;
  cu: string;
  st: string;
  tr: string | null;
  ca: string;
};

export function buildSubscriptionInvoiceUrl(
  bill: {
    id: string;
    billNumber: string;
    planName: string;
    termMonths: number;
    termLabel: string;
    periodStart?: Date | string | null;
    periodEnd?: Date | string | null;
    baseAmount?: number | null;
    extraBranchCost?: number | null;
    extraUserCost?: number | null;
    onboardingFee?: number | null;
    referralDiscount?: number | null;
    gstPercent?: number | null;
    gstAmount?: number | null;
    totalAmount?: number | null;
    amount?: number | null;
    currency?: string | null;
    paymentStatus?: string | null;
    txnReference?: string | null;
    createdAt?: Date | string | null;
    organizationName?: string | null;
  },
  orgName?: string
): string {
  const compactBill: CompactBillPayload = {
    id: bill.id,
    bn: bill.billNumber,
    on: orgName || bill.organizationName || "Workshop",
    pn: bill.planName,
    tm: bill.termMonths,
    tl: bill.termLabel,
    ps: bill.periodStart ? new Date(bill.periodStart).toISOString() : "",
    pe: bill.periodEnd ? new Date(bill.periodEnd).toISOString() : "",
    ba: bill.baseAmount ?? 0,
    eb: bill.extraBranchCost || 0,
    eu: bill.extraUserCost || 0,
    ob: bill.onboardingFee || 0,
    rd: bill.referralDiscount || 0,
    gp: bill.gstPercent || 18,
    ga: bill.gstAmount || 0,
    ta: bill.totalAmount ?? bill.amount ?? 0,
    am: bill.amount ?? bill.totalAmount ?? 0,
    cu: bill.currency || "INR",
    st: bill.paymentStatus || "PAID",
    tr: bill.txnReference || null,
    ca: bill.createdAt ? new Date(bill.createdAt).toISOString() : new Date().toISOString(),
  };

  const raw = JSON.stringify(compactBill);
  const hashData = Buffer.from(raw, "utf-8").toString("base64");
  const frontendBaseUrl = resolveFrontendBaseUrl();
  return `${frontendBaseUrl}/subscription-invoice/${encodeURIComponent(bill.id)}#data=${hashData}`;
}

export function buildSubscriptionBillWhatsAppMessage(opts: {
  bill: {
    id: string;
    billNumber: string;
    planName: string;
    termMonths: number;
    termLabel: string;
    periodStart?: Date | string | null;
    periodEnd?: Date | string | null;
    baseAmount?: number | null;
    extraBranchCost?: number | null;
    extraUserCost?: number | null;
    onboardingFee?: number | null;
    referralDiscount?: number | null;
    gstPercent?: number | null;
    gstAmount?: number | null;
    totalAmount?: number | null;
    amount?: number | null;
    currency?: string | null;
    createdAt?: Date | string | null;
  };
  organizationName: string;
  recipientName?: string | null;
  paymentStatus?: string | null;
  txnReference?: string | null;
}): string {
  const invoiceUrl = buildSubscriptionInvoiceUrl(
    {
      ...opts.bill,
      paymentStatus: opts.paymentStatus || "PAID",
      txnReference: opts.txnReference || null,
    },
    opts.organizationName
  );

  const createdAtDate = opts.bill.createdAt ? new Date(opts.bill.createdAt) : new Date();
  const formattedDate = createdAtDate.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const totalAmount = opts.bill.totalAmount ?? opts.bill.amount ?? 0;
  const statusLabel =
    opts.paymentStatus === "FAILED"
      ? "Failed"
      : opts.paymentStatus === "PENDING"
        ? "Pending"
        : "Paid ✓";

  return [
    "🧾 Tax Invoice / Subscription Bill",
    "Platform: MY DETAIL OS",
    `Organization: ${opts.organizationName}`,
    "",
    `Dear ${opts.recipientName?.trim() || "Customer"},`,
    "",
    "Here are the details for your subscription bill:",
    `* Bill #: ${opts.bill.billNumber}`,
    `* Plan: ${opts.bill.planName} (${opts.bill.termLabel})`,
    `* Total Amount: ₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    `* Payment Status: ${statusLabel}`,
    `* Billing Date: ${formattedDate}`,
    "",
    "📎 *View & Download Tax Invoice:*",
    invoiceUrl,
    "",
    "Thank you for choosing MY DETAIL OS!",
    "Issued by: Samriddhi Agencies",
  ].join("\n");
}

export async function sendSubscriptionBillWhatsAppNotification(
  billId: string,
  opts?: {
    phone?: string;
    customMessage?: string;
    actor?: string;
  }
): Promise<{
  ok: boolean;
  gatewayEnabled: boolean;
  phone?: string;
  sid?: string;
  status?: string;
  directUrl?: string;
  message?: string;
}> {
  const bill = await prisma.subscriptionBill.findUnique({
    where: { id: billId },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          users: {
            where: { role: "SUPER_ADMIN" },
            select: { phone: true, name: true },
            take: 1,
            orderBy: { id: "asc" },
          },
          subscription: { select: { contactPhone: true } },
        },
      },
      payment: { select: { status: true, txnReference: true } },
    },
  });

  if (!bill) {
    return {
      ok: false,
      gatewayEnabled: false,
      message: "Bill not found",
    };
  }

  const targetPhone =
    opts?.phone?.trim() ||
    bill.organization.users[0]?.phone ||
    bill.organization.subscription?.contactPhone;

  if (!targetPhone) {
    return {
      ok: false,
      gatewayEnabled: false,
      message: "No phone number available for this organization.",
    };
  }

  const defaultMsg = buildSubscriptionBillWhatsAppMessage({
    bill,
    organizationName: bill.organization.name,
    recipientName: bill.organization.users[0]?.name,
    paymentStatus: bill.payment?.status || "PAID",
    txnReference: bill.payment?.txnReference || null,
  });

  const text = opts?.customMessage?.trim() || defaultMsg;

  const cleanDigits = targetPhone.replace(/\D/g, "");
  const directUrl = `https://wa.me/${cleanDigits}?text=${encodeURIComponent(text)}`;

  if (!isTwilioWhatsAppEnabled()) {
    return {
      ok: false,
      gatewayEnabled: false,
      directUrl,
      phone: targetPhone,
      message: "Twilio WhatsApp gateway is not configured on server. Open WhatsApp directly.",
    };
  }

  const result = await sendWhatsAppMessage(targetPhone, text);

  await writePlatformAuditLog({
    organizationId: bill.organizationId,
    actor: opts?.actor ?? "system",
    action: "bills.whatsapp_sent",
    before: null,
    after: {
      billId: bill.id,
      billNumber: bill.billNumber,
      to: targetPhone,
      sid: result.sid,
      status: result.status,
      automated: !opts?.customMessage,
    },
  });

  if (
    result.twilioErrorCode === 63016 ||
    result.status === "undelivered" ||
    result.status === "failed"
  ) {
    return {
      ok: false,
      gatewayEnabled: true,
      directUrl,
      phone: targetPhone,
      sid: result.sid,
      status: result.status,
      message:
        "Outside 24-hour WhatsApp messaging window. Meta requires a customer-initiated message or a registered template. Click to send directly via WhatsApp.",
    };
  }

  return {
    ok: true,
    gatewayEnabled: true,
    phone: targetPhone,
    sid: result.sid,
    status: result.status,
    message: text,
  };
}

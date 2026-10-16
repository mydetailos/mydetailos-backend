/**
 * Sends the customer's portal login credentials via WhatsApp after account creation
 * (or password reset). Never throws — failures are logged to the `communications`
 * collection so support staff can see delivery status, but the caller (customer
 * create/update flow) must never fail because a WhatsApp send failed.
 */
import { prisma } from "../../lib/prisma.js";
import { SINGLETON_ENTITY_ID, singletonStorageEntityId } from "../../constants/json-collections.js";
import { env } from "../../config/env.js";
import {
  isTwilioWhatsAppEnabled,
  sendWhatsAppMessage,
  whatsappTemplateOrBody,
} from "../../services/twilio-sms.service.js";
import {
  buildCustomerCredentialsWhatsAppMessage,
  customerCredentialsTemplateVariables,
} from "../../lib/customer-credentials-whatsapp.js";
import { upsertCollectionItem } from "../collections/app-json-store.js";
import { ensureOrganizationHasSlug } from "../../lib/ensure-organization-slug.js";

async function resolveBusinessName(organizationId: string): Promise<string> {
  const row = await prisma.appJsonRow.findFirst({
    where: {
      collection: "appSettings",
      organizationId,
      OR: [
        { entityId: singletonStorageEntityId(organizationId) },
        { entityId: SINGLETON_ENTITY_ID },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: { payload: true },
  });
  const payload = row?.payload as Record<string, unknown> | undefined;
  const name = typeof payload?.businessName === "string" ? payload.businessName.trim() : "";
  if (name) return name;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  return org?.name?.trim() || "My Detail OS";
}

async function logWhatsAppAttempt(opts: {
  organizationId: string;
  customerId: string;
  phone: string;
  body: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}): Promise<void> {
  const id = `msg-cred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await upsertCollectionItem(
    "communications",
    id,
    {
      id,
      type: "whatsapp",
      recipient: opts.phone,
      subject: "Customer portal credentials",
      body: opts.body,
      status: opts.status,
      error: opts.error ?? null,
      customerId: opts.customerId,
      createdAt: new Date().toISOString(),
    },
    opts.organizationId
  ).catch(() => {});
}

export interface SendCustomerCredentialsResult {
  sent: boolean;
  reason?: string;
}

/**
 * Resolves the workshop frontend origin for customer portal links.
 * Always prefers `app.mydetailos.com` (or port 3002 locally) over `www.mydetailos.com`.
 */
function resolveCustomerPortalOrigin(): string {
  if (process.env.WORKSHOP_APP_ORIGIN?.trim()) {
    return process.env.WORKSHOP_APP_ORIGIN.trim().replace(/\/$/, "");
  }
  const origins = (env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);

  // 1. Prefer explicit workshop app origin (app.mydetailos.com or port 3002)
  const workshopOrigin = origins.find(
    (o) => o.includes("app.mydetailos.com") || o.includes(":3002")
  );
  if (workshopOrigin) return workshopOrigin;

  // 2. Next, prefer any origin that is NOT the marketing website (www.mydetailos.com / port 3003)
  const nonMarketing = origins.find(
    (o) => !o.includes("www.mydetailos.com") && !o.includes("website") && !o.includes(":3003")
  );
  if (nonMarketing) return nonMarketing;

  // 3. Safe fallback: app.mydetailos.com in production, or first origin
  return process.env.NODE_ENV === "production" ? "https://app.mydetailos.com" : origins[0] || "http://localhost:3002";
}

/** Tenant-aware customer portal login URL: /{orgSlug}/customer/login */
async function resolveCustomerPortalLoginUrl(organizationId: string): Promise<string> {
  const origin = resolveCustomerPortalOrigin();
  const org = await ensureOrganizationHasSlug(organizationId);
  const slug = org?.slug?.trim().toLowerCase();
  if (slug) return `${origin}/${slug}/customer/login`;
  return `${origin}/customer/login`;
}

/** Awaited by the caller so the API response can report whether the send succeeded. */
export async function sendCustomerCredentialsWhatsApp(opts: {
  organizationId: string;
  customerId: string;
  customerName: string;
  phone: string;
  plainPassword: string;
}): Promise<SendCustomerCredentialsResult> {
  const businessName = await resolveBusinessName(opts.organizationId);
  const customerPortalUrl = await resolveCustomerPortalLoginUrl(opts.organizationId);
  const message = buildCustomerCredentialsWhatsAppMessage({
    customerName: opts.customerName,
    phone: opts.phone,
    password: opts.plainPassword,
    businessName,
    customerPortalUrl,
  });

  if (!isTwilioWhatsAppEnabled()) {
    const reason = "WhatsApp is not configured (TWILIO_WHATSAPP_FROM unset)";
    await logWhatsAppAttempt({
      organizationId: opts.organizationId,
      customerId: opts.customerId,
      phone: opts.phone,
      body: message,
      status: "skipped",
      error: reason,
    });
    return { sent: false, reason };
  }

  const templateVariables = customerCredentialsTemplateVariables({
    customerName: opts.customerName,
    businessName,
    phone: opts.phone,
    customerPortalUrl,
  });

  const contentSid =
    env.TWILIO_CUSTOMER_WELCOME_CONTENT_SID?.trim() ||
    env.TWILIO_CUSTOMER_PORTAL_TEMPLATE_SID?.trim() ||
    "HXa15928c2342c1604e358f8152a79dd45";

  try {
    const result = await sendWhatsAppMessage(opts.phone, {
      contentSid,
      contentVariables: templateVariables,
    });
    if (
      result.status === "failed" ||
      result.status === "undelivered" ||
      (typeof result.twilioErrorCode === "number" && result.twilioErrorCode > 0)
    ) {
      const reason =
        result.twilioErrorMessage ||
        `Twilio delivery failed (status: ${result.status}${result.twilioErrorCode ? `, code: ${result.twilioErrorCode}` : ""})`;
      await logWhatsAppAttempt({
        organizationId: opts.organizationId,
        customerId: opts.customerId,
        phone: opts.phone,
        body: message,
        status: "failed",
        error: reason,
      });
      return { sent: false, reason };
    }
    await logWhatsAppAttempt({
      organizationId: opts.organizationId,
      customerId: opts.customerId,
      phone: opts.phone,
      body: message,
      status: "sent",
    });
    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await logWhatsAppAttempt({
      organizationId: opts.organizationId,
      customerId: opts.customerId,
      phone: opts.phone,
      body: message,
      status: "failed",
      error: reason,
    });
    return { sent: false, reason };
  }
}

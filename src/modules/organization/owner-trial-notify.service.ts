import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildOwnerPlanActivatedSmsMessage,
  buildOwnerPlanActivatedWhatsAppMessage,
  buildOwnerTrialStartedSmsMessage,
  buildOwnerTrialStartedWhatsAppMessage,
  ownerPlanActivatedTemplateVariables,
  ownerPlanActivatedCtaTemplateVariables,
  ownerTrialStartedTemplateVariables,
  ownerTrialExpiredTemplateVariables,
  buildOwnerTrialExpiredWhatsAppMessage,
  ownerSubscriptionExpiredTemplateVariables,
  buildOwnerSubscriptionExpiredWhatsAppMessage,
  ownerTrialExpiringReminderTemplateVariables,
  buildOwnerTrialExpiringReminderWhatsAppMessage,
  ownerSubscriptionExpiringReminderTemplateVariables,
  buildOwnerSubscriptionExpiringReminderWhatsAppMessage,
} from "../../lib/owner-trial-whatsapp.js";
import { isResendConfigured, sendViaResend } from "../../services/resend-send.js";
import { buildSubscriptionInvoiceUrl } from "./subscription-bill-notify.service.js";
import {
  isTwilioSmsEnabled,
  isTwilioWhatsAppEnabled,
  normalizePhoneToE164,
  sendTransactionalSms,
  sendWhatsAppMessage,
  whatsappTemplateOrBody,
  type WhatsAppTemplateSend,
} from "../../services/twilio-sms.service.js";

export type OwnerTrialNotifyResult = {
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
  errors: Partial<Record<"email" | "sms" | "whatsapp", string>>;
};

function loginUrl(): string {
  if (process.env.PUBLIC_APP_URL?.trim()) {
    const base = process.env.PUBLIC_APP_URL.trim().replace(/\/$/, "");
    return base.endsWith("/login") ? base : `${base}/login`;
  }
  const raw = (env.FRONTEND_ORIGIN || "").trim();
  const first = raw.split(",")[0]?.trim().replace(/\/$/, "");
  if (first && !first.includes("localhost") && !first.includes("127.0.0.1")) {
    return first.endsWith("/login") ? first : `${first}/login`;
  }
  return "https://mydetailos.com/login";
}

function publicPortalUrl(): string {
  return loginUrl();
}

function friendlyNotifyError(channel: "email" | "sms" | "whatsapp", raw: string): string {
  const d = raw.toLowerCase();
  if (channel === "email" && (d.includes("only send testing emails") || d.includes("verify a domain"))) {
    return "Resend test mode can only email the account owner. Verify a domain at resend.com/domains to email customers.";
  }
  return raw;
}

function waFailed(result: {
  status?: string;
  twilioErrorCode?: number | null;
  twilioErrorMessage?: string | null;
}): string | null {
  const code = result.twilioErrorCode;
  const status = result.status ?? "";
  if ((typeof code === "number" && code > 0) || status === "failed" || status === "undelivered") {
    return (
      result.twilioErrorMessage ||
      `Twilio WhatsApp ${status || "failed"}${code ? ` (${code})` : ""}`
    );
  }
  return null;
}

/** Best-effort: email + SMS + WhatsApp trial welcome. Never throws. */
export async function notifyOwnerTrialStarted(opts: {
  ownerName: string;
  email: string;
  phone: string;
  temporaryPassword?: string;
  trialDays: number;
}): Promise<OwnerTrialNotifyResult> {
  const sent: OwnerTrialNotifyResult = { email: false, sms: false, whatsapp: false, errors: {} };
  const login = loginUrl();
  const waBody = buildOwnerTrialStartedWhatsAppMessage({
    ownerName: opts.ownerName,
    trialDays: opts.trialDays,
    loginUrl: login,
    email: opts.email,
    temporaryPassword: opts.temporaryPassword,
  });
  const smsBody = buildOwnerTrialStartedSmsMessage({
    ownerName: opts.ownerName,
    trialDays: opts.trialDays,
    loginUrl: login,
    email: opts.email,
    temporaryPassword: opts.temporaryPassword,
  });

  // Email notification on trial signup removed — notification is WhatsApp only.

  if (opts.phone && isTwilioSmsEnabled()) {
    try {
      await sendTransactionalSms(normalizePhoneToE164(opts.phone), smsBody);
      sent.sms = true;
    } catch (err) {
      sent.errors.sms = err instanceof Error ? err.message : "SMS send failed";
    }
  } else if (!isTwilioSmsEnabled()) {
    sent.errors.sms = "Twilio SMS is not configured";
  }

  if (opts.phone && isTwilioWhatsAppEnabled()) {
    try {
      const result = await sendWhatsAppMessage(
        opts.phone,
        whatsappTemplateOrBody(
          env.TWILIO_OWNER_TRIAL_STARTED_TEMPLATE_SID,
          ownerTrialStartedTemplateVariables({
            ownerName: opts.ownerName,
            trialDays: opts.trialDays,
          }),
          waBody
        )
      );
      const fail = waFailed(result);
      if (fail) {
        sent.errors.whatsapp = fail;
      } else {
        sent.whatsapp = true;
      }
    } catch (err) {
      sent.errors.whatsapp = err instanceof Error ? err.message : "WhatsApp send failed";
    }
  } else if (!isTwilioWhatsAppEnabled()) {
    sent.errors.whatsapp = "Twilio WhatsApp is not configured";
  }

  console.info("[trial-notify]", {
    email: sent.email,
    sms: sent.sms,
    whatsapp: sent.whatsapp,
    errors: sent.errors,
    toEmail: opts.email,
    toPhone: opts.phone,
  });

  return sent;
}

async function sendOwnerChannels(opts: {
  email: string;
  phone: string;
  waBody: string;
  waPayload?: string | WhatsAppTemplateSend;
  waFallbackPayload?: string | WhatsAppTemplateSend;
  smsBody: string;
  emailSubject: string;
  logTag: string;
}): Promise<OwnerTrialNotifyResult> {
  const sent: OwnerTrialNotifyResult = { email: false, sms: false, whatsapp: false, errors: {} };

  if (isResendConfigured()) {
    try {
      const r = await sendViaResend({
        to: [opts.email],
        subject: opts.emailSubject,
        html: `<p>${opts.waBody.replace(/\n/g, "<br/>")}</p>`,
        text: opts.waBody,
      });
      sent.email = r.ok;
      if (!r.ok) {
        sent.errors.email = friendlyNotifyError(
          "email",
          "detail" in r ? r.detail : "Email send failed"
        );
      }
    } catch (err) {
      sent.errors.email = err instanceof Error ? err.message : "Email send failed";
    }
  } else {
    sent.errors.email = "RESEND_API_KEY is not set";
  }

  if (opts.phone && isTwilioSmsEnabled()) {
    try {
      await sendTransactionalSms(normalizePhoneToE164(opts.phone), opts.smsBody);
      sent.sms = true;
    } catch (err) {
      sent.errors.sms = err instanceof Error ? err.message : "SMS send failed";
    }
  } else if (!isTwilioSmsEnabled()) {
    sent.errors.sms = "Twilio SMS is not configured";
  }

  if (opts.phone && isTwilioWhatsAppEnabled()) {
    try {
      let result = await sendWhatsAppMessage(opts.phone, opts.waPayload ?? opts.waBody);
      let fail = waFailed(result);
      if (fail && opts.waFallbackPayload) {
        console.warn(`[${opts.logTag}] Primary WhatsApp template failed (${fail}), trying fallback template`);
        result = await sendWhatsAppMessage(opts.phone, opts.waFallbackPayload);
        fail = waFailed(result);
      }
      if (fail) sent.errors.whatsapp = fail;
      else sent.whatsapp = true;
    } catch (err) {
      if (opts.waFallbackPayload) {
        try {
          const fallbackRes = await sendWhatsAppMessage(opts.phone, opts.waFallbackPayload);
          const fail = waFailed(fallbackRes);
          if (fail) sent.errors.whatsapp = fail;
          else sent.whatsapp = true;
        } catch (fErr) {
          sent.errors.whatsapp = fErr instanceof Error ? fErr.message : "WhatsApp send failed";
        }
      } else {
        sent.errors.whatsapp = err instanceof Error ? err.message : "WhatsApp send failed";
      }
    }
  } else if (!isTwilioWhatsAppEnabled()) {
    sent.errors.whatsapp = "Twilio WhatsApp is not configured";
  }

  console.info(`[${opts.logTag}]`, {
    email: sent.email,
    sms: sent.sms,
    whatsapp: sent.whatsapp,
    errors: sent.errors,
    toEmail: opts.email,
    toPhone: opts.phone,
  });
  return sent;
}

async function findOrgOwner(organizationId: string) {
  return prisma.user.findFirst({
    where: {
      organizationId,
      role: { in: ["SUPER_ADMIN", "ADMIN"] },
    },
    orderBy: { id: "asc" },
    select: { name: true, email: true, phone: true },
  });
}

/** After Razorpay/admin verifies a plan upgrade, renewal, or add-on as PAID. */
export async function notifyOwnerPlanActivated(opts: {
  organizationId: string;
  organizationName: string;
  planName: string;
  termLabel: string;
  amount: number;
  expiresAt?: Date | string | null;
  kind: "upgrade" | "renewal" | "addon";
  extraBranches?: number;
  extraUsers?: number;
  billNumber?: string | null;
  billId?: string | null;
  invoiceUrl?: string | null;
}): Promise<OwnerTrialNotifyResult | null> {
  const owner = await findOrgOwner(opts.organizationId);
  if (!owner?.email && !owner?.phone) return null;

  const login = loginUrl();
  const expiresLabel =
    opts.expiresAt instanceof Date
      ? opts.expiresAt.toISOString().slice(0, 10)
      : opts.expiresAt
        ? String(opts.expiresAt).slice(0, 10)
        : null;

  let resolvedBillId = opts.billId ?? null;
  let invoiceUrl = opts.invoiceUrl;
  if (!invoiceUrl && opts.billId) {
    try {
      const bill = await prisma.subscriptionBill.findUnique({
        where: { id: opts.billId },
        include: { payment: { select: { status: true, txnReference: true } } },
      });
      if (bill) {
        resolvedBillId = bill.id;
        invoiceUrl = buildSubscriptionInvoiceUrl(
          {
            ...bill,
            paymentStatus: bill.payment?.status || "PAID",
            txnReference: bill.payment?.txnReference || null,
          },
          opts.organizationName
        );
      }
    } catch {
      /* ignore lookup failure */
    }
  } else if (!invoiceUrl && opts.billNumber) {
    try {
      const bill = await prisma.subscriptionBill.findFirst({
        where: { organizationId: opts.organizationId, billNumber: opts.billNumber },
        include: { payment: { select: { status: true, txnReference: true } } },
        orderBy: { createdAt: "desc" },
      });
      if (bill) {
        resolvedBillId = bill.id;
        invoiceUrl = buildSubscriptionInvoiceUrl(
          {
            ...bill,
            paymentStatus: bill.payment?.status || "PAID",
            txnReference: bill.payment?.txnReference || null,
          },
          opts.organizationName
        );
      }
    } catch {
      /* ignore lookup failure */
    }
  }

  const waBody = buildOwnerPlanActivatedWhatsAppMessage({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    planName: opts.planName,
    termLabel: opts.termLabel,
    amount: opts.amount,
    loginUrl: login,
    expiresAt: expiresLabel,
    kind: opts.kind,
    extraBranches: opts.extraBranches,
    extraUsers: opts.extraUsers,
    billNumber: opts.billNumber,
    invoiceUrl,
  });
  const smsBody = buildOwnerPlanActivatedSmsMessage({
    ownerName: owner?.name || "there",
    planName: opts.planName,
    amount: opts.amount,
    loginUrl: invoiceUrl || login,
    kind: opts.kind,
    extraBranches: opts.extraBranches,
    extraUsers: opts.extraUsers,
  });
  const subject =
    opts.kind === "upgrade"
      ? `Your MY DETAIL OS ${opts.planName} plan is active`
      : opts.kind === "addon"
        ? `Your MY DETAIL OS extra branches / users are active`
        : `Your MY DETAIL OS subscription was renewed`;

  const templateVars = ownerPlanActivatedTemplateVariables({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    planName: opts.planName,
    termLabel: opts.termLabel,
    amount: opts.amount,
    loginUrl: login,
    expiresAt: expiresLabel,
    billNumber: opts.billNumber,
    invoiceUrl,
  });

  const ctaTemplateVars = ownerPlanActivatedCtaTemplateVariables({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    planName: opts.planName,
    termLabel: opts.termLabel,
    amount: opts.amount,
    loginUrl: login,
    expiresAt: expiresLabel,
    billNumber: opts.billNumber,
    billId: resolvedBillId || opts.billId,
  });

  const preferredCtaSid =
    env.TWILIO_OWNER_PLAN_ACTIVATED_CTA_TEMPLATE_SID ||
    "HXfbf3b4948abc69e59bf39ec8f4c78f79";
  const fallbackTextSid =
    env.TWILIO_OWNER_PLAN_ACTIVATED_BILL_TEMPLATE_SID ||
    "HX519e8ed8ae401b9607430c373c2e9c43";

  const waPayload = whatsappTemplateOrBody(preferredCtaSid, ctaTemplateVars, waBody);
  const waFallbackPayload =
    fallbackTextSid && fallbackTextSid !== preferredCtaSid
      ? whatsappTemplateOrBody(fallbackTextSid, templateVars, waBody)
      : undefined;

  return sendOwnerChannels({
    email: owner?.email || "",
    phone: owner?.phone || "",
    waBody,
    waPayload,
    waFallbackPayload,
    smsBody,
    emailSubject: subject,
    logTag: "plan-activated-notify",
  });
}

/** When an organization's trial expires. */
export async function notifyOwnerTrialExpired(opts: {
  organizationId: string;
  organizationName: string;
  expirationDate: string;
}): Promise<OwnerTrialNotifyResult> {
  const owner = await findOrgOwner(opts.organizationId);
  const portal = publicPortalUrl();
  const waBody = buildOwnerTrialExpiredWhatsAppMessage({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    expirationDate: opts.expirationDate,
    upgradeUrl: portal,
  });

  return sendOwnerChannels({
    email: owner?.email || "",
    phone: owner?.phone || "",
    waBody,
    waPayload: whatsappTemplateOrBody(
      env.TWILIO_OWNER_TRIAL_EXPIRED_TEMPLATE_SID,
      ownerTrialExpiredTemplateVariables({
        ownerName: owner?.name || "there",
        organizationName: opts.organizationName,
        expirationDate: opts.expirationDate,
        upgradeUrl: portal,
      }),
      waBody
    ),
    smsBody: `Hi ${owner?.name || "there"}, your free trial for ${opts.organizationName} on My Detail OS has expired. Upgrade: ${portal}`,
    emailSubject: `Your My Detail OS free trial has expired`,
    logTag: "trial-expired-notify",
  });
}

/** When an organization's subscription expires. */
export async function notifyOwnerSubscriptionExpired(opts: {
  organizationId: string;
  organizationName: string;
  planName: string;
  expirationDate: string;
}): Promise<OwnerTrialNotifyResult> {
  const owner = await findOrgOwner(opts.organizationId);
  const portal = publicPortalUrl();
  const waBody = buildOwnerSubscriptionExpiredWhatsAppMessage({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    planName: opts.planName,
    expirationDate: opts.expirationDate,
    renewalUrl: portal,
  });

  return sendOwnerChannels({
    email: owner?.email || "",
    phone: owner?.phone || "",
    waBody,
    waPayload: whatsappTemplateOrBody(
      env.TWILIO_OWNER_SUBSCRIPTION_EXPIRED_TEMPLATE_SID,
      ownerSubscriptionExpiredTemplateVariables({
        ownerName: owner?.name || "there",
        organizationName: opts.organizationName,
        planName: opts.planName,
        expirationDate: opts.expirationDate,
        renewalUrl: portal,
      }),
      waBody
    ),
    smsBody: `Hi ${owner?.name || "there"}, your ${opts.planName} subscription for ${opts.organizationName} on My Detail OS has expired. Renew: ${portal}`,
    emailSubject: `Your My Detail OS subscription has expired`,
    logTag: "subscription-expired-notify",
  });
}

/** Reminder sent before an organization's trial expires (e.g. 3 days or 1 day before). */
export async function notifyOwnerTrialExpiringReminder(opts: {
  organizationId: string;
  organizationName: string;
  timeRemaining: string;
  expirationDate: string;
}): Promise<OwnerTrialNotifyResult> {
  const owner = await findOrgOwner(opts.organizationId);
  const portal = publicPortalUrl();
  const waBody = buildOwnerTrialExpiringReminderWhatsAppMessage({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    timeRemaining: opts.timeRemaining,
    expirationDate: opts.expirationDate,
    upgradeUrl: portal,
  });

  return sendOwnerChannels({
    email: owner?.email || "",
    phone: owner?.phone || "",
    waBody,
    waPayload: whatsappTemplateOrBody(
      env.TWILIO_OWNER_TRIAL_EXPIRING_REMINDER_TEMPLATE_SID,
      ownerTrialExpiringReminderTemplateVariables({
        ownerName: owner?.name || "there",
        organizationName: opts.organizationName,
        timeRemaining: opts.timeRemaining,
        expirationDate: opts.expirationDate,
        upgradeUrl: portal,
      }),
      waBody
    ),
    smsBody: `Hi ${owner?.name || "there"}, friendly reminder: your free trial for ${opts.organizationName} on My Detail OS is expiring in ${opts.timeRemaining}. Upgrade: ${portal}`,
    emailSubject: `Your My Detail OS free trial is expiring in ${opts.timeRemaining}`,
    logTag: "trial-expiring-reminder-notify",
  });
}

/** Reminder sent before an organization's subscription expires (e.g. 7 days or 3 days before). */
export async function notifyOwnerSubscriptionExpiringReminder(opts: {
  organizationId: string;
  organizationName: string;
  planName: string;
  timeRemaining: string;
  expirationDate: string;
}): Promise<OwnerTrialNotifyResult> {
  const owner = await findOrgOwner(opts.organizationId);
  const portal = publicPortalUrl();
  const waBody = buildOwnerSubscriptionExpiringReminderWhatsAppMessage({
    ownerName: owner?.name || "there",
    organizationName: opts.organizationName,
    planName: opts.planName,
    timeRemaining: opts.timeRemaining,
    expirationDate: opts.expirationDate,
    renewalUrl: portal,
  });

  return sendOwnerChannels({
    email: owner?.email || "",
    phone: owner?.phone || "",
    waBody,
    waPayload: whatsappTemplateOrBody(
      env.TWILIO_OWNER_SUBSCRIPTION_EXPIRING_REMINDER_TEMPLATE_SID,
      ownerSubscriptionExpiringReminderTemplateVariables({
        ownerName: owner?.name || "there",
        organizationName: opts.organizationName,
        planName: opts.planName,
        timeRemaining: opts.timeRemaining,
        expirationDate: opts.expirationDate,
        renewalUrl: portal,
      }),
      waBody
    ),
    smsBody: `Hi ${owner?.name || "there"}, friendly reminder: your ${opts.planName} subscription for ${opts.organizationName} on My Detail OS is expiring in ${opts.timeRemaining}. Renew: ${portal}`,
    emailSubject: `Your My Detail OS subscription is expiring in ${opts.timeRemaining}`,
    logTag: "subscription-expiring-reminder-notify",
  });
}

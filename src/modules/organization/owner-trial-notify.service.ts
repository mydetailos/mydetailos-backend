import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildOwnerPlanActivatedSmsMessage,
  buildOwnerPlanActivatedWhatsAppMessage,
  buildOwnerTrialStartedSmsMessage,
  buildOwnerTrialStartedWhatsAppMessage,
  ownerPlanActivatedTemplateVariables,
  ownerTrialStartedTemplateVariables,
} from "../../lib/owner-trial-whatsapp.js";
import { isResendConfigured, sendViaResend } from "../../services/resend-send.js";
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
  const raw = (env.FRONTEND_ORIGIN || "http://localhost:3000").trim();
  return raw.split(",")[0]!.trim().replace(/\/$/, "") || "http://localhost:3000";
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
      const result = await sendWhatsAppMessage(opts.phone, opts.waPayload ?? opts.waBody);
      const fail = waFailed(result);
      if (fail) sent.errors.whatsapp = fail;
      else sent.whatsapp = true;
    } catch (err) {
      sent.errors.whatsapp = err instanceof Error ? err.message : "WhatsApp send failed";
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
}): Promise<OwnerTrialNotifyResult | null> {
  const owner = await prisma.user.findFirst({
    where: {
      organizationId: opts.organizationId,
      role: { in: ["SUPER_ADMIN", "ADMIN"] },
    },
    orderBy: { id: "asc" },
    select: { name: true, email: true, phone: true },
  });
  if (!owner?.email && !owner?.phone) return null;

  const login = loginUrl();
  const expiresLabel =
    opts.expiresAt instanceof Date
      ? opts.expiresAt.toISOString().slice(0, 10)
      : opts.expiresAt
        ? String(opts.expiresAt).slice(0, 10)
        : null;
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
  });
  const smsBody = buildOwnerPlanActivatedSmsMessage({
    ownerName: owner?.name || "there",
    planName: opts.planName,
    amount: opts.amount,
    loginUrl: login,
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

  return sendOwnerChannels({
    email: owner?.email || "",
    phone: owner?.phone || "",
    waBody,
    waPayload: whatsappTemplateOrBody(
      env.TWILIO_OWNER_PLAN_ACTIVATED_TEMPLATE_SID,
      ownerPlanActivatedTemplateVariables({
        ownerName: owner?.name || "there",
        organizationName: opts.organizationName,
        planName: opts.planName,
        termLabel: opts.termLabel,
        amount: opts.amount,
        loginUrl: login,
        expiresAt: expiresLabel,
        billNumber: opts.billNumber,
      }),
      waBody
    ),
    smsBody,
    emailSubject: subject,
    logTag: "plan-activated-notify",
  });
}

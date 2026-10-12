import twilio from "twilio";
import { env } from "../config/env.js";
import { splitWhatsAppMessage } from "./whatsapp-message-split.js";

let client: ReturnType<typeof twilio> | null = null;

function isTwilioConfigured(): boolean {
  const account = Boolean(env.TWILIO_ACCOUNT_SID?.trim());
  const token = Boolean(env.TWILIO_AUTH_TOKEN?.trim());
  const apiKey = Boolean(
    env.TWILIO_API_KEY_SID?.trim() && env.TWILIO_API_KEY_SECRET?.trim()
  );
  return account && (token || apiKey);
}

function getClient() {
  if (!client) {
    const accountSid = env.TWILIO_ACCOUNT_SID!.trim();
    const keySid = env.TWILIO_API_KEY_SID?.trim();
    const keySecret = env.TWILIO_API_KEY_SECRET?.trim();
    if (keySid && keySecret) {
      client = twilio(keySid, keySecret, { accountSid });
    } else {
      const token = env.TWILIO_AUTH_TOKEN?.trim();
      if (!token) {
        throw new Error(
          "Twilio: set TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET"
        );
      }
      client = twilio(accountSid, token);
    }
  }
  return client;
}

export function isTwilioSmsEnabled(): boolean {
  const from = Boolean(env.TWILIO_FROM_NUMBER?.trim());
  return isTwilioConfigured() && from;
}

/** WhatsApp uses the same Twilio account; sender is the WhatsApp-enabled number (sandbox or approved). */
export function isTwilioWhatsAppEnabled(): boolean {
  const from = Boolean(env.TWILIO_WHATSAPP_FROM?.trim());
  return isTwilioConfigured() && from;
}

/** National number without country code (e.g. 10 digits for India). */
export function toE164(nationalDigits: string): string {
  const raw = (env.TWILIO_TO_NUMBER_PREFIX ?? "+91").trim();
  const prefix = raw.startsWith("+") ? raw : `+${raw}`;
  const digits = nationalDigits.replace(/\D/g, "");
  return `${prefix}${digits}`;
}

/** Normalize UI / customer phone to E.164 for Twilio (SMS or WhatsApp). */
export function normalizePhoneToE164(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return `+${digits}`;
  }
  if (digits.length >= 12 && digits.startsWith("91")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return toE164(digits);
  }
  if (digits.length > 10) {
    return `+${digits}`;
  }
  return toE164(digits);
}

function whatsappChannelAddress(raw: string): string {
  const t = raw.trim();
  if (/^whatsapp:/i.test(t)) return t;
  const inner = t.startsWith("+") ? `+${t.replace(/\D/g, "")}` : `+${t.replace(/\D/g, "")}`;
  return `whatsapp:${inner}`;
}

/** E.164 → `whatsapp:+…` as Twilio expects for WhatsApp `to` / `from`. */
export function toTwilioWhatsAppAddress(phoneInput: string): string {
  return whatsappChannelAddress(normalizePhoneToE164(phoneInput));
}

export async function sendWhatsAppInspectionDocument(params: {
  to: string;
  documentUrl: string;
  reportNumber: string;
  customerName: string;
  statusCallbackUrl: string;
  contentSid?: string;
  /** Keys match `inspection_report_v2`: 1 PDF URL, 2 name, 3 vehicle, 4 report, 5 workshop, 6 health, 7 address, 8 phone. */
  contentVariables?: Record<string, string>;
}): Promise<TwilioWhatsAppSendResult> {
  if (!isTwilioWhatsAppEnabled()) throw new Error("Twilio WhatsApp is not configured.");
  const from = whatsappChannelAddress(env.TWILIO_WHATSAPP_FROM!.trim());
  const templateContent = params.contentSid
    ? {
        contentSid: params.contentSid,
        contentVariables: JSON.stringify(
          params.contentVariables ?? {
            1: params.documentUrl,
            2: params.customerName,
            3: "your vehicle",
            4: params.reportNumber,
            5: "My Detail OS",
            6: "N/A",
            7: "N/A",
            8: "the workshop",
          }
        ),
      }
    : {
        body: `Vehicle inspection report ${params.reportNumber} for ${params.customerName}`,
        mediaUrl: [params.documentUrl],
      };
  const message = await getClient().messages.create({
    from,
    to: toTwilioWhatsAppAddress(params.to),
    ...templateContent,
    statusCallback: params.statusCallbackUrl,
  });
  return {
    sid: message.sid,
    status: message.status ?? "queued",
    twilioErrorCode: typeof message.errorCode === "number" ? message.errorCode : null,
    twilioErrorMessage: (message.errorMessage as string | null) ?? null,
  };
}

export function verifyTwilioWebhookSignature(url: string, params: Record<string, string>, signature: string): boolean {
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken || !signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

export async function sendLoginOtpSms(
  e164To: string,
  code: string
): Promise<{ sid: string; status: string }> {
  const from = env.TWILIO_FROM_NUMBER!.trim();
  const msg = await getClient().messages.create({
    body: `Your My Detail OS login code is ${code}. Valid 10 minutes. Do not share this code.`,
    from,
    to: e164To,
  });
  return { sid: msg.sid, status: msg.status ?? "unknown" };
}

/** Reuse for appointment/reminder SMS once Twilio is configured. */
export async function sendTransactionalSms(e164To: string, messageBody: string): Promise<void> {
  if (!isTwilioSmsEnabled()) {
    throw new Error(
      "Twilio is not configured (set TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, and either TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET)"
    );
  }
  await getClient().messages.create({
    body: messageBody,
    from: env.TWILIO_FROM_NUMBER!.trim(),
    to: e164To,
  });
}

/** Approved WhatsApp template (Content API) — use outside session / for utility messages. */
export type WhatsAppTemplateSend = {
  contentSid: string;
  /** Twilio expects JSON like `{ "1": "…", "2": "…" }` — string keys must match template variables. */
  contentVariables?: Record<string, string>;
};

/** Use an approved Content SID when set; otherwise free-form body (24-hour session only). */
export function whatsappTemplateOrBody(
  contentSid: string | undefined,
  contentVariables: Record<string, string>,
  fallbackBody: string
): string | WhatsAppTemplateSend {
  const sid = contentSid?.trim();
  if (!sid) return fallbackBody;
  return { contentSid: sid, contentVariables };
}

export type TwilioWhatsAppSendResult = {
  sid: string;
  status: string;
  /** Populated after a short refresh when Twilio reports a delivery/API error */
  twilioErrorCode?: number | null;
  twilioErrorMessage?: string | null;
};

async function fetchMessageOutcome(sid: string): Promise<{
  status?: string;
  errorCode?: number | null;
  errorMessage?: string | null;
}> {
  const client = getClient();
  /** Twilio often leaves error fields empty until the message leaves `queued`. */
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 500 : 2000));
    const m = await client.messages(sid).fetch();
    const errorCode = m.errorCode ?? null;
    const errorMessage = (m.errorMessage as string | null) ?? null;
    const status = m.status ?? undefined;
    const terminalFail =
      status === "undelivered" ||
      status === "failed" ||
      (typeof errorCode === "number" && errorCode > 0) ||
      (errorMessage != null && errorMessage.length > 0);
    const terminalOk = status === "delivered" || status === "read" || status === "sent";
    if (terminalFail || terminalOk || (status && status !== "queued" && status !== "accepted")) {
      return { status, errorCode, errorMessage };
    }
  }
  return {};
}

/**
 * Send WhatsApp via Twilio.
 * - Pass a string for a free-form `body` (session / sandbox).
 * - Pass `{ contentSid, contentVariables }` for an approved template (matches Twilio Console Content).
 */
export async function sendWhatsAppMessage(
  toPhoneInput: string,
  messageBodyOrTemplate: string | WhatsAppTemplateSend
): Promise<TwilioWhatsAppSendResult> {
  if (!isTwilioWhatsAppEnabled()) {
    throw new Error(
      "Twilio WhatsApp is not configured (set TWILIO_WHATSAPP_FROM=whatsapp:+… with the same account credentials as SMS)"
    );
  }
  const to = toTwilioWhatsAppAddress(toPhoneInput);
  const from = whatsappChannelAddress(env.TWILIO_WHATSAPP_FROM!.trim());

  const isTemplate = typeof messageBodyOrTemplate === "object" && messageBodyOrTemplate !== null;

  if (isTemplate) {
    const msg = await getClient().messages.create({
      from,
      to,
      contentSid: messageBodyOrTemplate.contentSid.trim(),
      ...(messageBodyOrTemplate.contentVariables &&
      Object.keys(messageBodyOrTemplate.contentVariables).length > 0
        ? {
            contentVariables: JSON.stringify(messageBodyOrTemplate.contentVariables),
          }
        : {}),
    });
    const out: TwilioWhatsAppSendResult = {
      sid: msg.sid,
      status: msg.status ?? "unknown",
      twilioErrorCode: typeof msg.errorCode === "number" ? msg.errorCode : null,
      twilioErrorMessage: (msg.errorMessage as string | null) ?? null,
    };
    const later = await fetchMessageOutcome(msg.sid);
    if (later.status) out.status = later.status;
    if (later.errorCode !== undefined && later.errorCode !== null) out.twilioErrorCode = later.errorCode;
    if (later.errorMessage !== undefined && later.errorMessage) out.twilioErrorMessage = later.errorMessage;
    if (process.env.NODE_ENV !== "production") {
      const err =
        out.twilioErrorCode != null && out.twilioErrorCode !== 0
          ? ` error=${out.twilioErrorCode} ${out.twilioErrorMessage ?? ""}`
          : "";
      console.info(`[twilio/whatsapp] sid=${out.sid} status=${out.status} from=${from} to=${to}${err}`);
    }
    return out;
  }

  const parts = splitWhatsAppMessage(messageBodyOrTemplate);
  let out: TwilioWhatsAppSendResult = {
    sid: "",
    status: "unknown",
  };

  for (let i = 0; i < parts.length; i++) {
    const msg = await getClient().messages.create({
      from,
      to,
      body: parts[i]!,
    });
    out = {
      sid: msg.sid,
      status: msg.status ?? "unknown",
      twilioErrorCode: typeof msg.errorCode === "number" ? msg.errorCode : null,
      twilioErrorMessage: (msg.errorMessage as string | null) ?? null,
    };
    const later = await fetchMessageOutcome(msg.sid);
    if (later.status) out.status = later.status;
    if (later.errorCode !== undefined && later.errorCode !== null) out.twilioErrorCode = later.errorCode;
    if (later.errorMessage !== undefined && later.errorMessage) out.twilioErrorMessage = later.errorMessage;

    if (process.env.NODE_ENV !== "production") {
      const err =
        out.twilioErrorCode != null && out.twilioErrorCode !== 0
          ? ` error=${out.twilioErrorCode} ${out.twilioErrorMessage ?? ""}`
          : "";
      const partTag = parts.length > 1 ? ` part=${i + 1}/${parts.length}` : "";
      console.info(
        `[twilio/whatsapp] sid=${out.sid} status=${out.status} from=${from} to=${to}${partTag}${err}`
      );
    }

    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  return out;
}

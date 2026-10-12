import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  isTwilioSmsEnabled,
  isTwilioWhatsAppEnabled,
  normalizePhoneToE164,
  sendTransactionalSms,
  sendWhatsAppMessage,
  toTwilioWhatsAppAddress,
  verifyTwilioWebhookSignature,
} from "../services/twilio-sms.service.js";
import { isResendConfigured, sendViaResend } from "../services/resend-send.js";
import { prisma } from "../lib/prisma.js";
import { upsertCollectionItem } from "../services/collection.service.js";

async function logMessage(params: {
  type: "whatsapp" | "email" | "sms";
  recipient: string;
  subject?: string;
  body: string;
  status: string;
  providerMessageId?: string;
  error?: string;
  organizationId?: string;
}) {
  try {
    let customer: any = null;
    const orgId = params.organizationId;
    const allCustomers = await prisma.customer.findMany({
      where: orgId ? { organizationId: orgId } : undefined,
    });
    if (params.type === "email") {
      const normEmail = params.recipient.trim().toLowerCase();
      customer = allCustomers.find((c) => c.email.trim().toLowerCase() === normEmail) || null;
    } else {
      const normPhone = params.recipient.replace(/\D/g, "").slice(-10);
      customer = allCustomers.find((c) => c.phone.replace(/\D/g, "").slice(-10) === normPhone) || null;
    }

    const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const messagePayload = {
      id,
      type: params.type,
      recipient: params.recipient,
      subject: params.subject || null,
      body: params.body,
      status: params.status,
      ...(params.providerMessageId ? { providerMessageId: params.providerMessageId } : {}),
      error: params.error || null,
      customerId: customer?.id || null,
      customerName: customer?.name || null,
      createdAt: new Date().toISOString(),
    };

    if (orgId) {
      await upsertCollectionItem("communications", id, messagePayload, orgId);
    }
    return messagePayload;
  } catch (err) {
    console.error("Failed to log message delivery:", err);
    return null;
  }
}


const postWhatsAppSchema = z
  .object({
    phone: z.string().min(8).max(32),
    /** Free-form body (session messages / sandbox). Split server-side when >1600 chars. */
    message: z.string().min(1).max(16_384).optional(),
    /** Twilio Content Template SID (HX…). Mutually exclusive with `message`. */
    contentSid: z.string().min(1).optional(),
    /** Template variables; serialized to JSON for Twilio (e.g. { "1": "22 July 2026", "2": "3:15pm" }). */
    contentVariables: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((val, ctx) => {
    const hasBody = Boolean(val.message?.trim());
    const hasTpl = Boolean(val.contentSid?.trim());
    const msg =
      "Provide exactly one of: `message` (plain text) or `contentSid` (approved WhatsApp template from Twilio Content).";
    if (hasBody && hasTpl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ["contentSid"] });
    } else if (!hasBody && !hasTpl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ["message"] });
    }
  });

const emailAttachmentSchema = z.object({
  filename: z.string().min(1).max(200),
  /** Base64-encoded PDF (or other file) for Resend `attachments`. */
  content: z.string().min(1).max(8_000_000),
});

const postTransactionalEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(600_000),
  text: z.string().max(50_000).optional(),
  attachments: z.array(emailAttachmentSchema).max(5).optional(),
});

/** Authenticated transactional email (Resend) — e.g. tax invoice HTML from the billing UI. */
export async function postTransactionalEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const body = postTransactionalEmailSchema.parse(req.body);
    if (!isResendConfigured()) {
      res.status(503).json({
        data: null,
        error: {
          message:
            "Email is not configured. Set RESEND_API_KEY on the API server (same as password reset). Optionally set MAIL_FROM to your verified domain sender.",
          code: "RESEND_NOT_CONFIGURED",
        },
      });
      return;
    }
    const out = await sendViaResend({
      to: [body.to],
      subject: body.subject,
      html: body.html,
      text: body.text,
      attachments: body.attachments,
    });
    if (!out.ok) {
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "email",
        recipient: body.to,
        subject: body.subject,
        body: body.html,
        status: "failed",
        error: out.detail,
      });
      res.status(502).json({
        data: { ok: false, message: msgLog },
        error: {
          message: out.detail,
          code: "RESEND_SEND_FAILED",
        },
      });
      return;
    }
    const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
      type: "email",
      recipient: body.to,
      subject: body.subject,
      body: body.html,
      status: "sent",
    });
    res.json({ data: { ok: true as const, message: msgLog }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function postWhatsApp(req: Request, res: Response, next: NextFunction) {
  try {
    const body = postWhatsAppSchema.parse(req.body);
    if (!isTwilioWhatsAppEnabled()) {
      res.status(503).json({
        data: null,
        error: {
          message:
            "WhatsApp is not configured. Set TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886 for the sandbox) alongside your Twilio account credentials.",
          code: "WHATSAPP_NOT_CONFIGURED",
        },
      });
      return;
    }
    let bodyText = body.message || "";
    if (!bodyText && body.contentSid) {
      bodyText = `Template: ${body.contentSid} with variables: ${JSON.stringify(body.contentVariables || {})}`;
    }
    try {
      if (body.message) {
        await sendWhatsAppMessage(body.phone, body.message);
      } else {
        await sendWhatsAppMessage(body.phone, {
          contentSid: body.contentSid!,
          contentVariables: body.contentVariables,
        });
      }
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "whatsapp",
        recipient: body.phone,
        body: bodyText,
        status: "sent",
      });
      res.json({ data: { ok: true as const, message: msgLog }, error: null });
    } catch (err: any) {
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "whatsapp",
        recipient: body.phone,
        body: bodyText,
        status: "failed",
        error: err?.message || String(err),
      });
      res.status(502).json({
        data: { ok: false, message: msgLog },
        error: {
          message: err?.message || String(err),
          code: "WHATSAPP_SEND_FAILED",
        },
      });
    }
  } catch (e) {
    next(e);
  }
}

const testPhoneSchema = z.object({
  phone: z.string().min(8).max(32),
});

const TEST_SMS_BODY =
  "My Detail OS — test SMS. If you received this, Twilio SMS is working. Replies are not monitored.";

const TEST_WHATSAPP_BODY =
  "My Detail OS — test WhatsApp. If you received this, Twilio WhatsApp is working. Replies are not monitored.";

export async function postSmsStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const callbackUrl = env.TWILIO_SMS_STATUS_CALLBACK_URL;
    if (!callbackUrl || !env.TWILIO_AUTH_TOKEN) {
      res.status(503).json({ data: null, error: { message: "SMS callback verification is not configured", code: "SMS_CALLBACK_NOT_CONFIGURED" } });
      return;
    }
    const params = z.record(z.string(), z.string()).parse(req.body);
    const signature = String(req.headers["x-twilio-signature"] ?? "");
    if (!verifyTwilioWebhookSignature(callbackUrl, params, signature) || params.AccountSid !== env.TWILIO_ACCOUNT_SID) {
      res.status(403).json({ data: null, error: { message: "Invalid provider webhook signature", code: "SMS_CALLBACK_FORBIDDEN" } });
      return;
    }
    const payload = z.object({
      MessageSid: z.string().regex(/^SM[0-9a-fA-F]{32}$/),
      MessageStatus: z.enum(["accepted", "scheduled", "queued", "sending", "sent", "delivered", "undelivered", "failed", "canceled"]),
      ErrorCode: z.string().regex(/^\d*$/).optional(),
    }).parse(params);
    console.info(`[twilio/sms] sid=${payload.MessageSid} status=${payload.MessageStatus}${payload.ErrorCode ? ` error=${payload.ErrorCode}` : ""}`);
    res.status(200).end();
  } catch (error) {
    next(error);
  }
}

/** Authenticated smoke test for transactional SMS (Twilio). */
export async function postSmsTest(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone } = testPhoneSchema.parse(req.body);
    if (!isTwilioSmsEnabled()) {
      res.status(503).json({
        data: null,
        error: {
          message:
            "SMS not configured. Set Twilio credentials and TWILIO_SMS_MESSAGING_SERVICE_SID, TWILIO_SMS_FROM, or TWILIO_FROM_NUMBER on the API server.",
          code: "SMS_NOT_CONFIGURED",
        },
      });
      return;
    }
    const to = normalizePhoneToE164(phone);
    const text = env.TWILIO_SMS_TEST_BODY ?? TEST_SMS_BODY;
    try {
      const result = await sendTransactionalSms(to, text);
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "sms",
        recipient: to,
        body: text,
        status: result.status,
        providerMessageId: result.sid,
      });
      res.json({ data: { ok: true as const, message: msgLog, sid: result.sid, status: result.status }, error: null });
    } catch (err: any) {
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "sms",
        recipient: to,
        body: text,
        status: "failed",
        error: err?.message || String(err),
      });
      res.status(502).json({
        data: { ok: false, message: msgLog },
        error: {
          message: err?.message || String(err),
          code: "SMS_SEND_FAILED",
        },
      });
    }
  } catch (e) {
    next(e);
  }
}

/** Authenticated smoke test for WhatsApp (same payload shape as production `/whatsapp`). */
export async function postWhatsAppTest(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone } = testPhoneSchema.parse(req.body);
    if (!isTwilioWhatsAppEnabled()) {
      res.status(503).json({
        data: null,
        error: {
          message:
            "WhatsApp not configured. Set TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886 for Twilio sandbox) with the same account credentials as SMS.",
          code: "WHATSAPP_NOT_CONFIGURED",
        },
      });
      return;
    }
    try {
      const result = await sendWhatsAppMessage(phone, TEST_WHATSAPP_BODY);
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "whatsapp",
        recipient: phone,
        body: TEST_WHATSAPP_BODY,
        status: "sent",
      });
      res.json({
        data: {
          ok: true as const,
          message: msgLog,
          twilioMessageSid: result.sid,
          twilioStatus: result.status,
          whatsappTo: toTwilioWhatsAppAddress(phone),
          twilioErrorCode: result.twilioErrorCode ?? null,
          twilioErrorMessage: result.twilioErrorMessage ?? null,
        },
        error: null,
      });
    } catch (err: any) {
      const msgLog = await logMessage({
      organizationId: req.auth?.organizationId,
        type: "whatsapp",
        recipient: phone,
        body: TEST_WHATSAPP_BODY,
        status: "failed",
        error: err?.message || String(err),
      });
      res.status(502).json({
        data: { ok: false, message: msgLog },
        error: {
          message: err?.message || String(err),
          code: "WHATSAPP_SEND_FAILED",
        },
      });
    }
  } catch (e) {
    next(e);
  }
}

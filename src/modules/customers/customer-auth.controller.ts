import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  authenticateCustomer,
  signCustomerAuthToken,
  setCustomerPassword,
  findCustomerByPhoneAndOrg,
  markCustomerLoggedIn,
} from "./customer-auth.service.js";
import { getCustomerById } from "./customer.service.js";
import { customerPasswordSchema } from "../../lib/password-policy.js";
import { getOrganizationBySlug } from "../../services/organization-public.service.js";
import { env } from "../../config/env.js";
import {
  checkOtpSendRateLimits,
  issueCustomerOtp,
  verifyAndConsumeCustomerOtp,
  clearCustomerOtpForPhone,
  isDemoLoginOtp,
} from "../auth/login-otp.service.js";
import {
  isTwilioWhatsAppOtpEnabled,
  sendLoginOtpWhatsApp,
  isTwilioSmsEnabled,
  sendLoginOtpSms,
  toE164,
} from "../../services/twilio-sms.service.js";

function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(fwd) && fwd[0]) return String(fwd[0]);
  return req.ip || "unknown";
}

const customerOtpSendSchema = z
  .object({
    phone: z.string().regex(/^\d{10}$/, "Must be a 10-digit mobile number"),
    organizationSlug: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    channel: z.enum(["whatsapp", "sms"]).optional(),
  })
  .refine((v) => Boolean(v.organizationSlug?.trim() || v.organizationId?.trim()), {
    message: "organizationSlug or organizationId is required",
    path: ["organizationSlug"],
  });

const loginSchema = z
  .object({
    phone: z.string().min(1),
    password: z.string().optional(),
    otp: z.string().optional(),
    /** Preferred: resolve tenant from public slug (URL). */
    organizationSlug: z.string().min(1).optional(),
    /** Alternate: explicit org id when already resolved server-side. */
    organizationId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.password?.trim() || v.otp?.trim()), {
    message: "Password or OTP is required",
    path: ["password"],
  })
  .refine((v) => Boolean(v.organizationSlug?.trim() || v.organizationId?.trim()), {
    message: "organizationSlug or organizationId is required",
    path: ["organizationSlug"],
  });

const setPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: customerPasswordSchema,
});

/** POST /api/auth/customer/otp/send — send 6-digit WhatsApp OTP for customer portal login */
export async function postCustomerSendOtp(req: Request, res: Response, next: NextFunction) {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    const body = customerOtpSendSchema.parse(req.body);
    const clientIp = getClientIp(req);

    let organizationId = body.organizationId?.trim() || "";
    if (body.organizationSlug?.trim()) {
      const org = await getOrganizationBySlug(body.organizationSlug.trim());
      if (!org.isActive) {
        res.status(403).json({ data: null, error: { message: "This organization is inactive." } });
        return;
      }
      organizationId = org.id;
    }
    if (!organizationId) {
      res.status(400).json({
        data: null,
        error: { message: "organizationSlug or organizationId is required" },
      });
      return;
    }

    // 1. Customer existence check in this tenant
    const customer = await findCustomerByPhoneAndOrg(body.phone, organizationId);
    if (!customer) {
      res.status(404).json({
        data: null,
        error: { message: "No customer account found with this mobile number in this workshop." },
      });
      return;
    }
    if (customer.isInactive) {
      res.status(403).json({
        data: null,
        error: { message: "Your customer account is inactive. Please contact the workshop." },
      });
      return;
    }

    // 2. Rate limiting & resend cooldown check
    const rateCheck = checkOtpSendRateLimits(body.phone, clientIp);
    if (!rateCheck.allowed) {
      res.status(429).json({
        data: null,
        error: {
          message: rateCheck.message,
          code: rateCheck.reason,
          retryAfterSeconds: rateCheck.retryAfterSeconds,
        },
      });
      return;
    }

    // 3. Determine delivery channel (prefer WhatsApp)
    const smsAllowed = env.OTP_SMS_ENABLED !== false;
    const requestedChannel =
      body.channel ?? (env.OTP_DELIVERY_CHANNEL !== "auto" ? env.OTP_DELIVERY_CHANNEL : undefined);

    let chosenChannel: "whatsapp" | "sms" | "log_only";
    if (requestedChannel === "whatsapp") {
      chosenChannel = "whatsapp";
    } else if (requestedChannel === "sms") {
      if (!smsAllowed) {
        res.status(503).json({
          data: null,
          error: {
            message:
              "SMS OTP delivery is currently disabled while regulatory approval is pending. Please use WhatsApp.",
            code: "SMS_DISABLED",
          },
        });
        return;
      }
      chosenChannel = "sms";
    } else {
      if (isTwilioWhatsAppOtpEnabled()) {
        chosenChannel = "whatsapp";
      } else if (smsAllowed && isTwilioSmsEnabled()) {
        chosenChannel = "sms";
      } else {
        chosenChannel = "log_only";
      }
    }

    // 4. Validate channel configuration
    if (chosenChannel === "whatsapp" && !isTwilioWhatsAppOtpEnabled()) {
      res.status(503).json({
        data: null,
        error: {
          message: "WhatsApp OTP is not configured on this server.",
          code: "WHATSAPP_NOT_CONFIGURED",
        },
      });
      return;
    }

    if (chosenChannel === "sms" && !isTwilioSmsEnabled()) {
      if (isProduction) {
        res.status(503).json({
          data: null,
          error: {
            message: "SMS OTP is not configured on this server.",
            code: "SMS_NOT_CONFIGURED",
          },
        });
        return;
      }
      chosenChannel = "log_only";
    }

    if (chosenChannel === "log_only" && isProduction) {
      res.status(503).json({
        data: null,
        error: {
          message: "OTP delivery is not configured on this server. Contact your administrator.",
          code: "OTP_NOT_CONFIGURED",
        },
      });
      return;
    }

    // 5. Issue 6-digit customer OTP
    const code = issueCustomerOtp(body.phone, organizationId, clientIp);
    const e164 = toE164(body.phone);
    let delivery: "whatsapp" | "sms" | "log_only" = chosenChannel;

    // 6. Deliver OTP — strict separation, NEVER fall back to SMS on WhatsApp error!
    if (chosenChannel === "whatsapp") {
      try {
        await sendLoginOtpWhatsApp(e164, code);
        delivery = "whatsapp";
      } catch (err) {
        clearCustomerOtpForPhone(body.phone, organizationId);
        if (!isProduction) {
          console.error(
            "[customer/otp] WhatsApp send failed:",
            err instanceof Error ? err.message : err
          );
        }
        res.status(503).json({
          data: null,
          error: {
            message: "Failed to send verification code via WhatsApp. Please try again in a few moments.",
            code: "WHATSAPP_DELIVERY_FAILED",
          },
        });
        return;
      }
    } else if (chosenChannel === "sms") {
      try {
        await sendLoginOtpSms(e164, code);
        delivery = "sms";
      } catch (err) {
        clearCustomerOtpForPhone(body.phone, organizationId);
        if (!isProduction) {
          console.error("[customer/otp] Twilio SMS send failed:", err);
        }
        res.status(503).json({
          data: null,
          error: {
            message: "Could not send SMS verification code. Please try again later.",
            code: "SMS_DELIVERY_FAILED",
          },
        });
        return;
      }
    }

    res.json({
      data: {
        ok: true as const,
        delivery,
        ...(delivery === "whatsapp" && {
          hint: "OTP sent to your WhatsApp number.",
        }),
        ...(delivery === "sms" && {
          hint: "OTP sent to your mobile number via SMS.",
        }),
        ...(delivery === "log_only" && {
          hint: !isProduction
            ? "Messaging not configured — dev mode."
            : "OTP service is not configured for this server. Contact your administrator.",
        }),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

/** POST /api/auth/customer/login — tenant-scoped (password or OTP). */
export async function postCustomerLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const body = loginSchema.parse(req.body);
    let organizationId = body.organizationId?.trim() || "";
    if (body.organizationSlug?.trim()) {
      const org = await getOrganizationBySlug(body.organizationSlug.trim());
      if (!org.isActive) {
        res.status(403).json({ data: null, error: { message: "This organization is inactive." } });
        return;
      }
      organizationId = org.id;
    }
    if (!organizationId) {
      res.status(400).json({
        data: null,
        error: { message: "organizationSlug or organizationId is required" },
      });
      return;
    }

    const normPhone = body.phone.replace(/\D/g, "").slice(-10);

    // Flow 1: OTP Login
    if (body.otp?.trim()) {
      const entered = body.otp.replace(/\D/g, "");
      if (entered.length < 4) {
        res.status(401).json({ data: null, error: { message: "Invalid or expired OTP" } });
        return;
      }

      const demoValid = isDemoLoginOtp(entered);
      if (demoValid) {
        clearCustomerOtpForPhone(normPhone, organizationId);
      } else {
        const verifyResult = verifyAndConsumeCustomerOtp(normPhone, organizationId, entered);
        if (verifyResult.status === "MAX_ATTEMPTS_EXCEEDED") {
          res.status(401).json({
            data: null,
            error: {
              message: "Too many incorrect attempts. This OTP has been invalidated. Please request a new code.",
              code: "MAX_ATTEMPTS_EXCEEDED",
            },
          });
          return;
        }
        if (verifyResult.status === "EXPIRED") {
          res.status(401).json({
            data: null,
            error: { message: "OTP has expired. Please request a new code.", code: "OTP_EXPIRED" },
          });
          return;
        }
        if (verifyResult.status === "INCORRECT") {
          res.status(401).json({
            data: null,
            error: {
              message: `Invalid OTP. ${verifyResult.remainingAttempts} attempt(s) remaining.`,
              code: "INVALID_OTP",
            },
          });
          return;
        }
        if (verifyResult.status !== "VALID") {
          res.status(401).json({
            data: null,
            error: { message: "Invalid or expired OTP", code: "INVALID_OR_EXPIRED" },
          });
          return;
        }
      }

      const customer = await findCustomerByPhoneAndOrg(normPhone, organizationId);
      if (!customer || customer.isInactive) {
        res.status(401).json({
          data: null,
          error: { message: "No active customer account found for this mobile number." },
        });
        return;
      }

      markCustomerLoggedIn(customer.id);
      const accessToken = signCustomerAuthToken(customer);
      const user = await getCustomerById(customer.id, customer.organizationId);

      res.json({ data: { accessToken, user }, error: null });
      return;
    }

    // Flow 2: Password Login
    const customer = await authenticateCustomer(body.phone, body.password!, organizationId);
    if (!customer) {
      res.status(401).json({ data: null, error: { message: "Invalid phone or password" } });
      return;
    }
    if (customer.organizationId !== organizationId) {
      res.status(401).json({ data: null, error: { message: "Invalid phone or password" } });
      return;
    }

    const accessToken = signCustomerAuthToken(customer);
    const user = await getCustomerById(customer.id, customer.organizationId);

    res.json({ data: { accessToken, user }, error: null });
  } catch (e) {
    next(e);
  }
}

/** GET /api/auth/customer/me */
export async function getCustomerMe(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth?.customerId || !req.auth.organizationId) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const user = await getCustomerById(req.auth.customerId, req.auth.organizationId);
    if (!user) {
      res.status(404).json({ data: null, error: { message: "Customer not found" } });
      return;
    }
    res.json({ data: { user }, error: null });
  } catch (e) {
    next(e);
  }
}

/** POST /api/auth/customer/logout — stateless JWT; client discards the token. */
export async function postCustomerLogout(_req: Request, res: Response) {
  res.json({ data: { ok: true }, error: null });
}

/**
 * POST /api/auth/customer/set-password
 * Lets a logged-in customer change their password whenever they want (optional,
 * not forced). Requires their current password to prevent a stolen/expired
 * token from being used to silently take over the account.
 * Note: this endpoint requires an authenticated session (Bearer token). A true
 * unauthenticated "forgot password" flow (no active session) would need OTP/SMS
 * verification, which is not implemented yet.
 */
export async function postCustomerSetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth?.customerId || !req.auth.organizationId) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = setPasswordSchema.parse(req.body);
    const updated = await setCustomerPassword(
      req.auth.customerId,
      req.auth.organizationId,
      body.currentPassword,
      body.newPassword
    );
    if (!updated) {
      res.status(401).json({ data: null, error: { message: "Current password is incorrect." } });
      return;
    }
    const user = await getCustomerById(updated.id, updated.organizationId);
    res.json({ data: { user }, error: null });
  } catch (e) {
    next(e);
  }
}

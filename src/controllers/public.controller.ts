import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { calculateSubscriptionPricing } from "../lib/subscription-pricing.js";
import {
  REFERRER_POINTS_ON_PAID,
  resolvePlatformReferral,
} from "../lib/platform-referral.js";
import {
  getEffectivePlanCatalogFromDb,
  getPlatformSettings,
  getResolvedSubscriptionPricing,
} from "../lib/platform-settings.js";
import { isAllowedTerm } from "../lib/plan-catalog.js";
import { AppHttpError } from "../lib/app-http-error.js";
import { strongPasswordSchema } from "../lib/password-policy.js";
import { provisionOrganization } from "../modules/organization/organization-provision.service.js";
import { env } from "../config/env.js";
import {
  checkOtpSendRateLimits,
  issueSignupOtp,
  verifyAndConsumeSignupOtp,
  clearSignupOtpForPhone,
  findActiveUserByTenDigitPhone,
  isDemoLoginOtp,
} from "../modules/auth/login-otp.service.js";
import {
  isTwilioWhatsAppOtpEnabled,
  sendLoginOtpWhatsApp,
  isTwilioSmsEnabled,
  sendLoginOtpSms,
  toE164,
} from "../services/twilio-sms.service.js";

type LimiterState = { count: number; resetAt: number };

const inMemoryLimiter = new Map<string, LimiterState>();

function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(fwd) && fwd[0]) return String(fwd[0]);
  return req.ip || "unknown";
}

function enforceRateLimit(req: Request, scope: string, maxPerWindow: number, windowMs: number): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const key = `${scope}:${ip}`;
  const existing = inMemoryLimiter.get(key);

  if (!existing || now >= existing.resetAt) {
    inMemoryLimiter.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= maxPerWindow) {
    return false;
  }

  existing.count += 1;
  inMemoryLimiter.set(key, existing);
  return true;
}

async function resolveLeadOrganizationId(): Promise<string | null> {
  const byDefaultId = await prisma.organization.findUnique({
    where: { id: "org-default" },
    select: { id: true },
  });
  if (byDefaultId?.id) return byDefaultId.id;

  const first = await prisma.organization.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return first?.id ?? null;
}

/** Self-serve trial signup — provisions org + owner + HQ + TRIAL. */
const signupSchema = z
  .object({
    // Website fields
    businessName: z.string().min(1).max(160).optional(),
    ownerName: z.string().min(1).max(120).optional(),
    // Legacy lead-capture aliases
    companyName: z.string().min(1).max(160).optional(),
    name: z.string().min(1).max(120).optional(),
    email: z.string().email(),
    phone: z.string().min(7).max(20),
    password: strongPasswordSchema,
    branchName: z.string().min(1).max(120).optional(),
    planCode: z.string().min(2).max(24).optional(),
    referralCode: z.string().max(32).nullable().optional(),
    message: z.string().max(2000).optional(),
    source: z.string().max(80).optional(),
    otp: z.string().min(4).max(16).optional(),
  })
  .superRefine((val, ctx) => {
    const business = (val.businessName ?? val.companyName ?? "").trim();
    const owner = (val.ownerName ?? val.name ?? "").trim();
    if (!business) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Business name is required.", path: ["businessName"] });
    }
    if (!owner) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Owner name is required.", path: ["ownerName"] });
    }
  });

const signupOtpSendSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Must be a 10-digit mobile number"),
  email: z.string().email().optional(),
  channel: z.enum(["whatsapp", "sms"]).optional(),
});

const contactSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(20).optional(),
  businessName: z.string().max(160).optional(),
  subject: z.string().max(200).optional(),
  message: z.string().min(1).max(2000),
  source: z.string().max(80).optional(),
});

const publicPricingSchema = z.object({
  planCode: z.string().min(2).max(24).transform((s) => s.trim().toUpperCase().replace(/[\s-]+/g, "_")).default("STARTER"),
  termMonths: z.union([z.literal(1), z.literal(3), z.literal(12), z.literal(24), z.literal(36), z.literal(60)]),
  extraBranches: z.number().int().nonnegative().default(0),
  extraUsers: z.number().int().nonnegative().default(0),
  referralCode: z.string().max(32).nullable().optional(),
  isFirstSubscription: z.boolean().optional(),
});

export async function postPublicSignupSendOtp(req: Request, res: Response, next: NextFunction) {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    const body = signupOtpSendSchema.parse(req.body);
    const clientIp = getClientIp(req);

    // 1. Check if an account with this mobile number already exists
    const existingPhoneUser = await findActiveUserByTenDigitPhone(body.phone);
    if (existingPhoneUser) {
      res.status(409).json({
        data: null,
        error: {
          message: "An account with this mobile number already exists. Please log in.",
          code: "PHONE_EXISTS",
        },
      });
      return;
    }

    // 2. Check if an account with this email already exists (if email is provided)
    if (body.email?.trim()) {
      const existingEmailUser = await prisma.user.findUnique({
        where: { email: body.email.trim().toLowerCase() },
        select: { id: true },
      });
      if (existingEmailUser) {
        res.status(409).json({
          data: null,
          error: {
            message: "An account with this email already exists. Please log in.",
            code: "EMAIL_EXISTS",
          },
        });
        return;
      }
    }

    // 3. Rate limiting & resend cooldown check
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

    // 4. Determine delivery channel (default to WhatsApp)
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

    // 5. Validate chosen channel configuration
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

    // 6. Issue 6-digit signup OTP
    const code = issueSignupOtp(body.phone, clientIp);
    const e164 = toE164(body.phone);
    let delivery: "whatsapp" | "sms" | "log_only" = chosenChannel;

    // 7. Deliver OTP — strict separation, NEVER fall back to SMS on WhatsApp error!
    if (chosenChannel === "whatsapp") {
      try {
        await sendLoginOtpWhatsApp(e164, code);
        delivery = "whatsapp";
      } catch (err) {
        clearSignupOtpForPhone(body.phone);
        if (!isProduction) {
          console.error(
            "[public/signup/otp] WhatsApp send failed:",
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
        clearSignupOtpForPhone(body.phone);
        if (!isProduction) {
          console.error("[public/signup/otp] Twilio SMS send failed:", err);
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

    const bypassDisabled = process.env.LOGIN_OTP_DEMO_CODE === "";
    const demoBypassCode =
      bypassDisabled || isProduction
        ? undefined
        : (process.env.LOGIN_OTP_DEMO_CODE ?? "1234");
    const isDev = !isProduction;

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
          hint: isDev
            ? demoBypassCode !== undefined
              ? "Messaging not configured — use the dev bypass code."
              : "Messaging not configured — demo bypass disabled."
            : "OTP service is not configured for this server. Contact your administrator.",
          ...(isDev && demoBypassCode !== undefined ? { devDemoCode: demoBypassCode } : {}),
        }),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function postPublicSignup(req: Request, res: Response, next: NextFunction) {
  try {
    if (!enforceRateLimit(req, "public-signup", 5, 10 * 60_000)) {
      res.status(429).json({
        data: null,
        error: { message: "Too many signup requests. Please try again in a few minutes." },
      });
      return;
    }

    const body = signupSchema.parse(req.body ?? {});

    // Verify OTP
    const enteredOtp = (body.otp ?? "").trim();
    if (!enteredOtp) {
      res.status(400).json({
        data: null,
        error: { message: "Verification code (OTP) is required.", code: "OTP_REQUIRED" },
      });
      return;
    }

    const phoneDigits = body.phone.replace(/\D/g, "");
    const phoneTen = phoneDigits.slice(-10);

    const demoValid = isDemoLoginOtp(enteredOtp);
    if (demoValid) {
      clearSignupOtpForPhone(phoneTen);
    } else {
      const verifyResult = verifyAndConsumeSignupOtp(phoneTen, enteredOtp);
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
    const businessName = (body.businessName ?? body.companyName ?? "").trim();
    const ownerName = (body.ownerName ?? body.name ?? "").trim();

    if (body.referralCode?.trim()) {
      const resolved = await resolvePlatformReferral({ raw: body.referralCode });
      if (resolved.message) {
        throw new AppHttpError(400, resolved.message, "INVALID_REFERRAL");
      }
    }

    const provisioned = await provisionOrganization({
      businessName,
      ownerName,
      email: body.email,
      phone: body.phone,
      password: body.password,
      branchName: body.branchName,
      planCode: body.planCode,
      referralCode: body.referralCode ?? null,
      source: body.source ?? "public_website",
      actor: `public:${getClientIp(req)}`,
    });

    // Best-effort CRM lead row (does not block signup if lead org is missing).
    try {
      const leadOrgId = await resolveLeadOrganizationId();
      if (leadOrgId) {
        const id = `signup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await prisma.appJsonRow.create({
          data: {
            collection: "publicSignups",
            entityId: id,
            organizationId: leadOrgId,
            payload: {
              id,
              organizationId: provisioned.organizationId,
              businessName,
              ownerName,
              email: body.email.trim().toLowerCase(),
              phone: body.phone.trim(),
              message: body.message,
              source: body.source ?? "public_website",
              createdAt: new Date().toISOString(),
              ip: getClientIp(req),
              userAgent: req.headers["user-agent"] ?? null,
            },
          },
        });
      }
    } catch {
      /* non-fatal */
    }

    res.status(201).json({
      data: {
        accessToken: provisioned.accessToken,
        user: provisioned.user,
        organizationId: provisioned.organizationId,
        organization: provisioned.organization,
        branch: provisioned.branch,
        subscription: provisioned.subscription,
      },
      error: null,
    });
  } catch (e) {
    if (e instanceof AppHttpError) {
      res.status(e.status).json({
        data: null,
        error: { message: e.message, code: e.code },
      });
      return;
    }
    next(e);
  }
}

export async function postPublicContact(req: Request, res: Response, next: NextFunction) {
  try {
    if (!enforceRateLimit(req, "public-contact", 20, 10 * 60_000)) {
      res.status(429).json({
        data: null,
        error: { message: "Too many contact requests. Please try again in a few minutes." },
      });
      return;
    }

    const body = contactSchema.parse(req.body ?? {});
    const organizationId = await resolveLeadOrganizationId();
    if (!organizationId) {
      res.status(503).json({
        data: null,
        error: { message: "Service is temporarily unavailable." },
      });
      return;
    }

    const id = `contact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.appJsonRow.create({
      data: {
        collection: "publicContacts",
        entityId: id,
        organizationId,
        payload: {
          id,
          ...body,
          email: body.email?.trim().toLowerCase(),
          phone: body.phone?.trim(),
          createdAt: new Date().toISOString(),
          ip: getClientIp(req),
          userAgent: req.headers["user-agent"] ?? null,
        },
      },
    });

    res.status(201).json({
      data: {
        ok: true,
        id,
        message: "Thanks for reaching out. Our team will follow up shortly.",
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function postPublicPricingQuote(req: Request, res: Response, next: NextFunction) {
  try {
    if (!enforceRateLimit(req, "public-pricing", 60, 10 * 60_000)) {
      res.status(429).json({
        data: null,
        error: { message: "Too many pricing quote requests. Please try again shortly." },
      });
      return;
    }

    const body = publicPricingSchema.parse(req.body ?? {});
    const [catalog, pricing] = await Promise.all([
      getEffectivePlanCatalogFromDb(),
      getResolvedSubscriptionPricing(),
    ]);
    const plan = catalog.find((p) => p.planCode === body.planCode);
    if (!plan || !plan.publicVisible) {
      res.status(404).json({
        data: null,
        error: { message: "Plan not found or not available.", code: "PLAN_NOT_FOUND" },
      });
      return;
    }
    if (!isAllowedTerm(body.termMonths, plan.allowedTerms)) {
      res.status(400).json({
        data: null,
        error: {
          message: `Term ${body.termMonths} months is not available for this plan.`,
          code: "TERM_NOT_ALLOWED",
        },
      });
      return;
    }
    const resolvedReferral = await resolvePlatformReferral({
      raw: body.referralCode ?? null,
    });
    const breakdown = calculateSubscriptionPricing({
      planCode: plan.planCode,
      planName: plan.planName,
      limits: plan.limits,
      isFirstSubscription: body.isFirstSubscription ?? true,
      pricing,
      resolvedReferral,
      payload: {
        termMonths: body.termMonths,
        extraBranches: body.extraBranches,
        extraUsers: body.extraUsers,
        referralCode: resolvedReferral.code ?? body.referralCode ?? null,
      },
    });

    res.json({ data: { breakdown }, error: null });
  } catch (e) {
    next(e);
  }
}


export async function getPublicPlans(_req: Request, res: Response, next: NextFunction) {
  try {
    const [catalog, pricing, settings] = await Promise.all([
      getEffectivePlanCatalogFromDb(),
      getResolvedSubscriptionPricing(),
      getPlatformSettings(),
    ]);
    const plans = catalog
      .filter((p) => p.publicVisible)
      .map((p) => {
        const annualBase = pricing.termBasePrices[12] * (pricing.planMultipliers[p.planCode] ?? 1);
        return {
          planCode: p.planCode,
          planName: p.planName,
          limits: p.limits,
          allowedTerms: p.allowedTerms,
          annualPrice: Math.round(annualBase * 100) / 100,
          currency: pricing.currency,
          gstPercent: pricing.gstPercent,
        };
      });
    res.json({
      data: {
        plans,
        trialDaysDefault: settings.trialDaysDefault,
        pricing: {
          currency: pricing.currency,
          gstPercent: pricing.gstPercent,
          termBasePrices: pricing.termBasePrices,
          planMultipliers: pricing.planMultipliers,
          addOns: pricing.addOns,
          source: pricing.source,
        },
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function getPublicReferral(req: Request, res: Response, next: NextFunction) {
  try {
    const code = String(req.params.code ?? "");
    const resolved = await resolvePlatformReferral({ raw: code });
    res.json({
      data: {
        valid: Boolean(resolved.code) && !resolved.message,
        code: resolved.code,
        message: resolved.message,
        discountAmount: resolved.discountAmount,
        referrerPoints: REFERRER_POINTS_ON_PAID,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

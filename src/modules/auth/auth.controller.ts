import type { Request, Response, NextFunction } from "express";
import type { Branch, User } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { ensureOrganizationHasSlug } from "../../lib/ensure-organization-slug.js";
import { authenticateUser, signAuthToken, touchUserLastLogin } from "./auth.service.js";
import {
  checkOtpSendRateLimits,
  clearOtpForPhone,
  consumeLoginOtpIfValid,
  findActiveUserByTenDigitPhone,
  issueLoginOtp,
  isDemoLoginOtp,
  verifyAndConsumeLoginOtp,
} from "./login-otp.service.js";
import {
  isTwilioSmsEnabled,
  isTwilioWhatsAppOtpEnabled,
  sendLoginOtpSms,
  sendLoginOtpWhatsApp,
  toE164,
} from "../../services/twilio-sms.service.js";

import { env } from "../../config/env.js";
import {
  isPasswordResetEmailConfigured,
  sendPasswordResetEmail,
} from "./password-reset-email.service.js";
import {
  consumePasswordResetToken,
  createPasswordResetPlainToken,
  issuePasswordResetForUser,
  clearPasswordResetForUser,
  isPasswordResetTokenPending,
} from "./password-reset.service.js";
import { strongPasswordSchema } from "../../lib/password-policy.js";
import { updateUserApi } from "../users/user-api.service.js";
import { persistAvatarFile } from "../../services/object-storage.service.js";
import {
  getUserReportFavourites,
  setUserReportFavourites,
} from "./report-favourites.service.js";
import { logAuthActivity } from "../../services/activity-logger.service.js";
import {
  listWorkspacesForUser,
  resolveSwitchableUser,
} from "./workspace-switch.service.js";
import {
  linkWorkspaceUsers,
  unlinkWorkspaceUsers,
} from "./workspace-links.service.js";
import { provisionOrganization } from "../organization/organization-provision.service.js";
import { AppHttpError } from "../../lib/app-http-error.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const switchWorkspaceSchema = z.object({
  userId: z.string().min(1),
});

const linkWorkspaceSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const unlinkWorkspaceSchema = z.object({
  userId: z.string().min(1),
});

const createWorkspaceBranchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().max(120).optional().nullable(),
  phone: z
    .string()
    .regex(/^\d{10}$/, "Must be a 10-digit mobile number")
    .optional()
    .nullable(),
  email: z.string().email(),
  password: strongPasswordSchema,
});

const otpSendSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Must be a 10-digit mobile number"),
  channel: z.enum(["whatsapp", "sms"]).optional(),
});

const otpVerifySchema = z.object({
  phone: z.string().regex(/^\d{10}$/),
  code: z.string().min(4).max(16),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(24),
  password: strongPasswordSchema,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: strongPasswordSchema,
});

const patchMeSchema = z.object({
  name: z.string().min(1),
  /** Omit to leave unchanged; `null` or empty clears avatar in DB. */
  avatar: z.union([z.string().max(4096), z.null()]).optional(),
});

const resetTokenQuerySchema = z.object({
  token: z.string().min(24).max(2048),
});

function parseResetTokenFromQuery(req: Request): string {
  const raw = req.query.token;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return "";
}

/** Read-only: whether this reset URL can still complete once (token stored & unexpired). */
export async function getResetPasswordTokenStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = resetTokenQuerySchema.safeParse({ token: parseResetTokenFromQuery(req) });
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { message: "Missing or invalid token." },
      });
      return;
    }
    const pending = await isPasswordResetTokenPending(parsed.data.token);
    res.json({ data: { pending }, error: null });
  } catch (e) {
    next(e);
  }
}

function formatTwilioSendError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as {
      code?: number;
      message?: string;
      status?: number;
      moreInfo?: string;
    };
    if (typeof e.code === "number") {
      const base = `Twilio ${e.code}: ${e.message ?? "error"}`;
      return e.moreInfo ? `${base}. See ${e.moreInfo}` : base;
    }
  }
  return "Could not send SMS. Check Twilio credentials, trial verified numbers, and server logs.";
}

async function authSuccessResponse(
  user: User,
  branch: Branch | null,
  preloadedOrg?: { id: string; name: string; slug: string | null } | null
) {
  const token = signAuthToken({
    id: user.id,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    organizationId: user.organizationId,
    name: user.name,
    mustChangePassword: user.mustChangePassword === true,
    permissions: user.permissions,
  });
  let organization: { id: string; name: string; slug: string } | null = null;
  if (preloadedOrg && preloadedOrg.slug) {
    organization = {
      id: preloadedOrg.id,
      name: preloadedOrg.name,
      slug: preloadedOrg.slug.trim().toLowerCase(),
    };
  } else if (user.organizationId) {
    organization = await ensureOrganizationHasSlug(user.organizationId);
  }
  if (user.role !== "PLATFORM_OWNER") {
    if (!user.organizationId || !organization) {
      throw new AppHttpError(403, "This organization has been deleted or deactivated.", "ORG_INACTIVE");
    }
  }
  return {
    accessToken: token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      branchId: user.branchId,
      organizationId: user.organizationId,
      avatar: user.avatar ?? undefined,
      isActive: user.isActive,
      emailVerified: user.emailVerified || undefined,
      attendancePin: user.attendancePin ?? undefined,
      totalJobsCompleted: user.totalJobsCompleted ?? undefined,
      totalIncentiveEarned: user.totalIncentiveEarned ?? undefined,
      employeeCode: user.employeeCode ?? undefined,
      designation: user.designation ?? undefined,
      department: user.department ?? undefined,
      joiningDate: user.joiningDate ?? undefined,
      birthday: user.birthday ?? undefined,
      anniversary: user.anniversary ?? undefined,
      notes: user.notes ?? undefined,
      permissions: user.permissions || [],
      ...(user.mustChangePassword === true ? { mustChangePassword: true as const } : {}),
    },
    organization,
    branch: branch
      ? {
          id: branch.id,
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
          isActive: branch.isActive,
          qrCodeId: branch.qrCodeId ?? undefined,
          code: branch.code ?? undefined,
          city: branch.city ?? undefined,
          state: branch.state ?? undefined,
          pincode: branch.pincode ?? undefined,
          email: branch.email ?? undefined,
          managerName: branch.managerName ?? undefined,
          managerPhone: branch.managerPhone ?? undefined,
        }
      : null,
  };
}

function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(fwd) && fwd[0]) return String(fwd[0]);
  return req.ip || "unknown";
}

export async function sendLoginOtp(req: Request, res: Response, next: NextFunction) {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    const body = otpSendSchema.parse(req.body);
    const clientIp = getClientIp(req);

    // 1. Rate limiting & resend cooldown check
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

    // 2. Active user lookup
    const user = await findActiveUserByTenDigitPhone(body.phone);
    if (!user) {
      res.status(404).json({
        data: null,
        error: { message: "No account found for this mobile number" },
      });
      return;
    }

    // 3. Determine delivery channel
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
      // Auto: prefer WhatsApp OTP if configured; fallback to SMS only if SMS is explicitly enabled
      if (isTwilioWhatsAppOtpEnabled()) {
        chosenChannel = "whatsapp";
      } else if (smsAllowed && isTwilioSmsEnabled()) {
        chosenChannel = "sms";
      } else {
        chosenChannel = "log_only";
      }
    }

    // 4. Validate chosen channel configuration before generating OTP
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

    // 5. Issue OTP code
    const code = issueLoginOtp(body.phone, clientIp);
    const e164 = toE164(body.phone);
    let delivery: "whatsapp" | "sms" | "log_only" = chosenChannel;

    // 6. Deliver OTP — strict separation, NEVER fall back to SMS on WhatsApp error!
    if (chosenChannel === "whatsapp") {
      try {
        await sendLoginOtpWhatsApp(e164, code);
        delivery = "whatsapp";
      } catch (err) {
        clearOtpForPhone(body.phone);
        if (!isProduction) {
          console.error(
            "[auth/otp] WhatsApp send failed:",
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
        const { sid, status } = await sendLoginOtpSms(e164, code);
        delivery = "sms";
        if (!isProduction) {
          console.info(
            `[auth/otp] Twilio accepted SMS sid=${sid} status=${status} to=${e164}`
          );
        }
      } catch (err) {
        clearOtpForPhone(body.phone);
        if (!isProduction) {
          console.error("[auth/otp] Twilio SMS send failed:", err);
        }
        res.status(503).json({
          data: null,
          error: { message: formatTwilioSendError(err) },
        });
        return;
      }
    } else {
      delivery = "log_only";
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

export async function verifyLoginOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const body = otpVerifySchema.parse(req.body);
    const entered = body.code.replace(/\D/g, "");
    if (entered.length < 4) {
      res.status(401).json({ data: null, error: { message: "Invalid or expired OTP" } });
      return;
    }
    const user = await findActiveUserByTenDigitPhone(body.phone);
    if (!user) {
      res.status(401).json({ data: null, error: { message: "Invalid or expired OTP" } });
      return;
    }

    // Check demo bypass first (only active if not in production and configured)
    const demoValid = isDemoLoginOtp(entered);
    let otpValid = false;

    if (demoValid) {
      otpValid = true;
      clearOtpForPhone(body.phone);
    } else {
      const verifyResult = verifyAndConsumeLoginOtp(body.phone, entered);
      if (verifyResult.status === "VALID") {
        otpValid = true;
      } else if (verifyResult.status === "MAX_ATTEMPTS_EXCEEDED") {
        res.status(401).json({
          data: null,
          error: {
            message: "Too many incorrect attempts. This OTP has been invalidated. Please request a new code.",
            code: "MAX_ATTEMPTS_EXCEEDED",
          },
        });
        return;
      } else if (verifyResult.status === "EXPIRED") {
        res.status(401).json({
          data: null,
          error: {
            message: "OTP has expired. Please request a new code.",
            code: "OTP_EXPIRED",
          },
        });
        return;
      } else if (verifyResult.status === "INCORRECT") {
        res.status(401).json({
          data: null,
          error: {
            message: `Invalid OTP. ${verifyResult.remainingAttempts} attempt(s) remaining.`,
            code: "INVALID_OTP",
          },
        });
        return;
      } else {
        res.status(401).json({
          data: null,
          error: {
            message: "Invalid or expired OTP",
            code: "INVALID_OR_EXPIRED",
          },
        });
        return;
      }
    }

    if (!otpValid) {
      res.status(401).json({ data: null, error: { message: "Invalid or expired OTP" } });
      return;
    }

    await touchUserLastLogin(user.id);
    const branch = await prisma.branch.findUnique({ where: { id: user.branchId } });
    void logAuthActivity({
      organizationId: user.organizationId,
      userId: user.id,
      userName: user.name,
      action: "LOGIN",
      method: "otp",
    });
    res.json({ data: await authSuccessResponse(user, branch), error: null });
  } catch (e) {
    next(e);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const body = loginSchema.parse(req.body);

    const result = await authenticateUser(body.email, body.password);
    if (!result) {
      // On failure, check if user exists but org is inactive/deleted to provide the specific error
      const userCandidate = await prisma.user.findUnique({
        where: { email: body.email.trim().toLowerCase() },
        include: { organization: { select: { id: true, isActive: true } } },
      });
      if (userCandidate && userCandidate.role !== "PLATFORM_OWNER") {
        if (!userCandidate.organization) {
          res.status(403).json({
            data: null,
            error: {
              message: "This organization has been deleted.",
              code: "ORG_DELETED",
            },
          });
          return;
        }
        if (!userCandidate.organization.isActive) {
          res.status(403).json({
            data: null,
            error: {
              message: "This organization account is deactivated. Contact support.",
              code: "ORG_SUSPENDED",
            },
          });
          return;
        }
      }
      res.status(401).json({ data: null, error: { message: "Invalid email or password" } });
      return;
    }

    void logAuthActivity({
      organizationId: result.user.organizationId,
      userId: result.user.id,
      userName: result.user.name,
      action: "LOGIN",
      method: "password",
    });

    res.json({
      data: await authSuccessResponse(result.user, result.branch, result.organization),
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

/** POST /api/auth/logout — stateless JWT; records activity then client discards the token. */
export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.auth;
    if (auth?.id && auth.organizationId) {
      void logAuthActivity({
        organizationId: auth.organizationId,
        userId: auth.id,
        userName: auth.name || "Staff",
        action: "LOGOUT",
      });
    }
    res.json({ data: { ok: true as const }, error: null });
  } catch (e) {
    next(e);
  }
}

/**
 * Opaque success if the email is unknown. Issues a time-limited reset token and sends email via Resend when configured.
 * In development without Resend, prints the reset URL in the API terminal.
 */
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    const body = forgotPasswordSchema.parse(req.body);
    const normalized = body.email.trim().toLowerCase();
    const mailOk = isPasswordResetEmailConfigured();

    if (isProduction && !mailOk) {
      console.error(
        "[auth/forgot-password] RESEND_API_KEY is missing — cannot send password reset email in production."
      );
      res.status(503).json({
        data: null,
        error: {
          message:
            "Password reset email is not configured on this server. Please contact your administrator.",
        },
      });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { email: normalized, isActive: true },
      select: { id: true, email: true },
    });

    if (user) {
      const plainToken = createPasswordResetPlainToken();
      await issuePasswordResetForUser(user.id, plainToken);
      const firstOrigin = (env.FRONTEND_ORIGIN ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)[0] ?? "http://localhost:3000";
      const base = firstOrigin.replace(/\/+$/, "");
      const resetUrl = `${base}/reset-password?token=${encodeURIComponent(plainToken)}`;

      if (mailOk) {
        const sendResult = await sendPasswordResetEmail(user.email, resetUrl);
        if (!sendResult.ok) {
          if (!isProduction) {
            console.info(
              `[auth/forgot-password] Resend failed — dev-only reset link (still valid ~1h) for ${user.email}:\n${resetUrl}`
            );
            const trialToBlock =
              sendResult.detail.includes("only send testing") ||
              sendResult.detail.includes("verify a domain");
            const devTip = trialToBlock
              ? "On a Resend trial, mail only goes to your Resend-login email until you add and verify your domain at resend.com/domains (then MAIL_FROM must use that domain, e.g. support@mydetailos.com). Until then you can copy the reset URL from the backend terminal, or test with a DB user whose email is your Resend account address."
              : "Try MAIL_FROM=My Detail OS <onboarding@resend.dev> until your domain is verified, copy the reset URL from the backend terminal, and confirm RESEND_API_KEY is valid.";
            res.status(503).json({
              data: null,
              error: {
                message: `Resend could not send the email (${sendResult.detail}). ${devTip}`,
              },
            });
          } else {
            await clearPasswordResetForUser(user.id);
            res.status(503).json({
              data: null,
              error: {
                message:
                  "We could not send the reset email right now. Please try again in a few minutes.",
              },
            });
          }
          return;
        }
      } else if (!isProduction) {
        console.info(
          `[auth/forgot-password] RESEND_API_KEY not set — reset link for ${user.email}:\n${resetUrl}`
        );
      }
    } else if (!isProduction) {
      console.warn(
        `[auth/forgot-password] No active User has email "${normalized}" — no reset mail sent (API still returns generic success). Seed/demo accounts often use superadmin@company.com or *@mydetailos.test. Ask your Super Admin if you need a new account.`
      );
    }

    const mailInboxMessage =
      "If an account exists for this email, we've sent password reset instructions. Please check your inbox and spam folder.";

    /** Dev/local only: no SMTP/Resend — nothing is mailed. Users must copy the URL from backend logs if an account existed. */
    const devTerminalMessage =
      "This setup does not send email until you configure the backend (add RESEND_API_KEY to backend .env). If your email is registered, the full reset link is printed where the backend API runs (the terminal showing “API listening on …”). Scroll for `[auth/forgot-password]` followed by two lines—a second line starts with http and contains `/reset-password?token=`. Copy that URL into your browser. If nothing like that printed, this email may not be registered on this server.";

    res.json({
      data: {
        ok: true as const,
        message: mailOk ? mailInboxMessage : devTerminalMessage,
        ...(!mailOk && !isProduction ? { passwordResetDelivery: "dev-console" as const } : {}),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!user?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ data: null, error: { message: "Current password is incorrect." } });
      return;
    }
    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date() },
    });
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const branch = await prisma.branch.findUnique({ where: { id: refreshed.branchId } });
    res.json({ data: await authSuccessResponse(refreshed, branch), error: null });
  } catch (e) {
    next(e);
  }
}

export async function completePasswordReset(req: Request, res: Response, next: NextFunction) {
  try {
    const body = resetPasswordSchema.parse(req.body);
    const outcome = await consumePasswordResetToken(body.token, body.password);
    if (!outcome.ok) {
      const msg =
        outcome.reason === "EXPIRED"
          ? "This reset link has expired. Request a new one from Forgot password."
          : "Invalid or expired reset link.";
      res.status(400).json({ data: null, error: { message: msg } });
      return;
    }
    res.json({
      data: {
        ok: true as const,
        message: "Your password was updated. Sign in with your new password.",
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

/** Authenticated user updates own display name and avatar only (not email / phone / role / branch). */
export async function patchMe(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = patchMeSchema.parse(req.body);
    const patch: Parameters<typeof updateUserApi>[1] = {
      name: body.name.trim(),
    };
    if (body.avatar !== undefined) {
      patch.avatar =
        body.avatar === null || body.avatar.trim() === ""
          ? null
          : body.avatar.trim();
    }
    const updated = await updateUserApi(req.auth.id, patch);
    if (!updated) {
      res.status(400).json({
        data: null,
        error: {
          message: "Could not update profile.",
        },
      });
      return;
    }
    const row = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!row?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const branch = await prisma.branch.findUnique({ where: { id: row.branchId } });
    res.json({ data: await authSuccessResponse(row, branch), error: null });
  } catch (e) {
    next(e);
  }
}

export async function uploadMyAvatar(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const file = req.file;
    if (!file?.buffer) {
      res.status(400).json({ data: null, error: { message: "No image file provided." } });
      return;
    }
    /** Cloud (S3/R2): absolute URL. Local fallback: `/uploads/avatars/...`. */
    const avatarUrl = await persistAvatarFile({
      buffer: file.buffer,
      mimeType: file.mimetype,
      userId: req.auth.id,
    });
    const updated = await updateUserApi(req.auth.id, { avatar: avatarUrl });
    if (!updated) {
      res.status(400).json({ data: null, error: { message: "Could not save avatar." } });
      return;
    }
    const row = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!row?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const branch = await prisma.branch.findUnique({ where: { id: row.branchId } });
    res.json({ data: await authSuccessResponse(row, branch), error: null });
  } catch (e) {
    next(e);
  }
}

export async function me(req: Request, res: Response) {
  if (!req.auth) {
    res.status(401).json({ data: null, error: { message: "Unauthorized" } });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.auth.id },
    include: { branch: true },
  });
  if (!user?.isActive) {
    res.status(401).json({ data: null, error: { message: "Unauthorized" } });
    return;
  }
  const branch = user.branch;
  res.json({
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        branchId: user.branchId,
        organizationId: user.organizationId,
        avatar: user.avatar ?? undefined,
        isActive: user.isActive,
        emailVerified: user.emailVerified || undefined,
        attendancePin: user.attendancePin ?? undefined,
        totalJobsCompleted: user.totalJobsCompleted ?? undefined,
        totalIncentiveEarned: user.totalIncentiveEarned ?? undefined,
        employeeCode: user.employeeCode ?? undefined,
        designation: user.designation ?? undefined,
        department: user.department ?? undefined,
        joiningDate: user.joiningDate ?? undefined,
        birthday: user.birthday ?? undefined,
        anniversary: user.anniversary ?? undefined,
        notes: user.notes ?? undefined,
        permissions: user.permissions || [],
        ...(user.mustChangePassword === true ? { mustChangePassword: true as const } : {}),
      },
      branch: branch
        ? {
            id: branch.id,
            name: branch.name,
            address: branch.address,
            phone: branch.phone,
            isActive: branch.isActive,
            qrCodeId: branch.qrCodeId ?? undefined,
            code: branch.code ?? undefined,
            city: branch.city ?? undefined,
            state: branch.state ?? undefined,
            pincode: branch.pincode ?? undefined,
            email: branch.email ?? undefined,
            managerName: branch.managerName ?? undefined,
            managerPhone: branch.managerPhone ?? undefined,
          }
        : null,
    },
    error: null,
  });
}

/** List workshops linked to this staff phone (same mobile → associated accounts). */
export async function listMyWorkspaces(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const workspaces = await listWorkspacesForUser(req.auth.id);
    res.json({ data: { workspaces }, error: null });
  } catch (e) {
    next(e);
  }
}

/** Switch JWT session to another phone-linked staff account / workshop. */
export async function switchMyWorkspace(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = switchWorkspaceSchema.parse(req.body);
    const resolved = await resolveSwitchableUser(req.auth.id, body.userId);
    if (!resolved.user) {
      const status = resolved.reason === "Unauthorized" ? 401 : 400;
      res.status(status).json({
        data: null,
        error: { message: resolved.reason ?? "Could not switch workspace" },
      });
      return;
    }

    const branch = await prisma.branch.findUnique({ where: { id: resolved.user.branchId } });
    touchUserLastLogin(resolved.user.id);
    res.json({ data: await authSuccessResponse(resolved.user, branch), error: null });
  } catch (e) {
    next(e);
  }
}

/** Link another workshop admin account (email + password) for workspace switching. */
export async function linkMyWorkspace(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = linkWorkspaceSchema.parse(req.body);
    const current = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!current?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }

    const auth = await authenticateUser(body.email, body.password);
    if (!auth) {
      res.status(400).json({
        data: null,
        error: { message: "Invalid email or password for that workshop account" },
      });
      return;
    }
    if (auth.user.id === current.id) {
      res.status(400).json({
        data: null,
        error: { message: "That is your current account" },
      });
      return;
    }
    if (auth.user.organizationId === current.organizationId) {
      res.status(400).json({
        data: null,
        error: { message: "That account is already in this workshop" },
      });
      return;
    }
    if (auth.user.role === "PLATFORM_OWNER") {
      res.status(400).json({
        data: null,
        error: { message: "Cannot link that account" },
      });
      return;
    }

    await linkWorkspaceUsers(
      { userId: current.id, organizationId: current.organizationId },
      { userId: auth.user.id, organizationId: auth.user.organizationId }
    );

    const workspaces = await listWorkspacesForUser(current.id);
    res.json({ data: { workspaces }, error: null });
  } catch (e) {
    next(e);
  }
}

/** Remove a credential-linked workshop from the switcher list. */
export async function unlinkMyWorkspace(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = unlinkWorkspaceSchema.parse(req.body);
    const current = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!current?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!target) {
      res.status(404).json({ data: null, error: { message: "Account not found" } });
      return;
    }

    await unlinkWorkspaceUsers(
      { userId: current.id, organizationId: current.organizationId },
      { userId: target.id, organizationId: target.organizationId }
    );

    const workspaces = await listWorkspacesForUser(current.id);
    res.json({ data: { workspaces }, error: null });
  } catch (e) {
    next(e);
  }
}

/**
 * Create an independent workshop (org + HQ + SUPER_ADMIN) and auto-link it
 * so the current user can switch from the navbar (GarageSaarthi-style branch).
 */
export async function createMyWorkspaceBranch(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = createWorkspaceBranchSchema.parse(req.body);
    const current = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!current?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    if (current.role !== "SUPER_ADMIN" && current.role !== "ADMIN") {
      res.status(403).json({
        data: null,
        error: { message: "Only Admin or Super Admin can create a new branch workspace" },
      });
      return;
    }

    const phoneDigits =
      body.phone?.trim() ||
      current.phone.replace(/\D/g, "").slice(-10);
    if (phoneDigits.length !== 10) {
      res.status(400).json({
        data: null,
        error: { message: "A valid 10-digit branch phone is required" },
      });
      return;
    }

    const provisioned = await provisionOrganization({
      businessName: body.name,
      ownerName: current.name,
      email: body.email.trim().toLowerCase(),
      phone: phoneDigits,
      password: body.password,
      branchName: body.name,
      planCode: "STARTER",
      source: "workspace-branch-create",
      actor: current.email,
    });

    const city = body.city?.trim();
    if (city) {
      await prisma.branch.update({
        where: { id: provisioned.branch.id },
        data: { city, address: city },
      });
    }

    await linkWorkspaceUsers(
      { userId: current.id, organizationId: current.organizationId },
      {
        userId: provisioned.user.id,
        organizationId: provisioned.organizationId,
      }
    );

    const workspaces = await listWorkspacesForUser(current.id);
    res.status(201).json({
      data: {
        workspaces,
        organization: {
          id: provisioned.organization.id,
          name: provisioned.organization.name,
          slug: provisioned.organization.slug,
        },
        userId: provisioned.user.id,
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

const reportFavouritesSchema = z.object({
  hrefs: z.array(z.string().min(1)).max(200),
});

/** User-specific favourite report hrefs (AppJsonRow, keyed by user id). */
export async function getMyReportFavourites(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.auth.id },
      select: { id: true, isActive: true, organizationId: true },
    });
    if (!user?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const hrefs = await getUserReportFavourites(user.id, user.organizationId);
    res.json({ data: { hrefs }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function putMyReportFavourites(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.auth.id },
      select: { id: true, isActive: true, organizationId: true },
    });
    if (!user?.isActive) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = reportFavouritesSchema.parse(req.body);
    const hrefs = await setUserReportFavourites(
      user.id,
      user.organizationId,
      body.hrefs
    );
    res.json({ data: { hrefs }, error: null });
  } catch (e) {
    next(e);
  }
}

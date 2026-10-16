import { prisma } from "../../lib/prisma.js";
import type { User } from "@prisma/client";

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Match seed phones like +91-9876543210 to the last 10 digits entered in the UI. */
export async function findActiveUserByTenDigitPhone(ten: string): Promise<User | null> {
  if (ten.length !== 10) return null;
  const users = await prisma.user.findMany({ where: { isActive: true } });
  for (const u of users) {
    const d = digitsOnly(u.phone);
    if (d.endsWith(ten)) return u;
  }
  return null;
}

export type OtpEntry = {
  code: string;
  expiresAt: number;
  lastIssuedAt: number;
  failedAttempts: number;
};

const otpByPhone = new Map<string, OtpEntry>();

// Rate limiting states
type RateLimitState = { count: number; resetAt: number };
const phoneSendLimiter = new Map<string, RateLimitState>();
const ipSendLimiter = new Map<string, RateLimitState>();

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown between resends
export const MAX_PHONE_SENDS_PER_WINDOW = 5; // max 5 sends per 15 minutes per phone
export const MAX_IP_SENDS_PER_WINDOW = 15; // max 15 sends per 15 minutes per IP
export const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_VERIFY_ATTEMPTS = 5; // max 5 incorrect attempts before invalidating OTP

export type RateLimitCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "COOLDOWN" | "RATE_LIMITED";
      retryAfterSeconds: number;
      message: string;
    };

/** Checks resend cooldown and rate limits before issuing an OTP. */
export function checkOtpSendRateLimits(phoneTen: string, ip?: string): RateLimitCheckResult {
  const now = Date.now();

  // 1. Cooldown check (per phone number)
  const existing = otpByPhone.get(phoneTen);
  if (existing && existing.expiresAt > now) {
    const elapsed = now - existing.lastIssuedAt;
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
      return {
        allowed: false,
        reason: "COOLDOWN",
        retryAfterSeconds: waitSec,
        message: `Please wait ${waitSec} second(s) before requesting another code.`,
      };
    }
  }

  // 2. Per-phone send rate limit
  const phoneLimit = phoneSendLimiter.get(phoneTen);
  if (phoneLimit && now < phoneLimit.resetAt) {
    if (phoneLimit.count >= MAX_PHONE_SENDS_PER_WINDOW) {
      const waitSec = Math.ceil((phoneLimit.resetAt - now) / 1000);
      return {
        allowed: false,
        reason: "RATE_LIMITED",
        retryAfterSeconds: waitSec,
        message: `Too many OTP requests for this phone number. Please try again in ${Math.ceil(waitSec / 60)} minute(s).`,
      };
    }
  }

  // 3. Per-IP send rate limit
  if (ip && ip !== "unknown") {
    const ipLimit = ipSendLimiter.get(ip);
    if (ipLimit && now < ipLimit.resetAt) {
      if (ipLimit.count >= MAX_IP_SENDS_PER_WINDOW) {
        const waitSec = Math.ceil((ipLimit.resetAt - now) / 1000);
        return {
          allowed: false,
          reason: "RATE_LIMITED",
          retryAfterSeconds: waitSec,
          message: `Too many OTP requests from your network. Please try again later.`,
        };
      }
    }
  }

  return { allowed: true };
}

/** Issues a 4-digit numeric OTP and records rate limit counters. */
export function issueLoginOtp(phoneTen: string, ip?: string): string {
  const now = Date.now();
  const code = String(Math.floor(1000 + Math.random() * 9000));
  otpByPhone.set(phoneTen, {
    code,
    expiresAt: now + OTP_TTL_MS,
    lastIssuedAt: now,
    failedAttempts: 0,
  });

  // Increment phone counter
  const pLimit = phoneSendLimiter.get(phoneTen);
  if (!pLimit || now >= pLimit.resetAt) {
    phoneSendLimiter.set(phoneTen, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    pLimit.count += 1;
    phoneSendLimiter.set(phoneTen, pLimit);
  }

  // Increment IP counter
  if (ip && ip !== "unknown") {
    const iLimit = ipSendLimiter.get(ip);
    if (!iLimit || now >= iLimit.resetAt) {
      ipSendLimiter.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    } else {
      iLimit.count += 1;
      ipSendLimiter.set(ip, iLimit);
    }
  }

  return code;
}

/** Remove an OTP for a phone number (e.g. if delivery fails). */
export function clearOtpForPhone(phoneTen: string): void {
  otpByPhone.delete(phoneTen);
}

export type VerifyOtpResult =
  | { status: "VALID" }
  | { status: "EXPIRED" }
  | { status: "NOT_FOUND" }
  | { status: "MAX_ATTEMPTS_EXCEEDED" }
  | { status: "INCORRECT"; remainingAttempts: number };

/** Verifies an entered OTP with failed attempt tracking. */
export function verifyAndConsumeLoginOtp(phoneTen: string, entered: string): VerifyOtpResult {
  const now = Date.now();
  const entry = otpByPhone.get(phoneTen);
  if (!entry) {
    return { status: "NOT_FOUND" };
  }
  if (entry.expiresAt < now) {
    otpByPhone.delete(phoneTen);
    return { status: "EXPIRED" };
  }
  if (entry.code !== entered) {
    entry.failedAttempts += 1;
    const remaining = MAX_VERIFY_ATTEMPTS - entry.failedAttempts;
    if (remaining <= 0) {
      otpByPhone.delete(phoneTen);
      return { status: "MAX_ATTEMPTS_EXCEEDED" };
    }
    return { status: "INCORRECT", remainingAttempts: remaining };
  }

  // Correct code — consume immediately
  otpByPhone.delete(phoneTen);
  return { status: "VALID" };
}

/** Backward-compatible helper for code expecting a boolean. */
export function consumeLoginOtpIfValid(phoneTen: string, entered: string): boolean {
  const res = verifyAndConsumeLoginOtp(phoneTen, entered);
  return res.status === "VALID";
}

/**
 * Optional bypass for local/demo only.
 * CRITICAL SECURITY RULE: ALWAYS returns false in production, regardless of env vars.
 */
export function isDemoLoginOtp(entered: string): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  const raw = process.env.LOGIN_OTP_DEMO_CODE;
  if (raw === "") return false;
  const expected = raw ?? "1234";
  return entered === expected;
}

/** Reset in-memory state for clean unit tests. */
export function _resetOtpStateForTesting(): void {
  otpByPhone.clear();
  phoneSendLimiter.clear();
  ipSendLimiter.clear();
}

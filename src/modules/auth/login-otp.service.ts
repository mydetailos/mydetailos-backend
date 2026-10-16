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
const signupOtpByPhone = new Map<string, OtpEntry>();
const customerOtpByKey = new Map<string, OtpEntry>();

function customerOtpKey(phoneTen: string, organizationId: string): string {
  return `${organizationId.trim()}:${phoneTen.trim()}`;
}

// Rate limiting states
type RateLimitState = { count: number; resetAt: number };
const phoneSendLimiter = new Map<string, RateLimitState>();
const ipSendLimiter = new Map<string, RateLimitState>();

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown between resends
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

  // 1. Cooldown check (per phone number across login, signup, and customer portal)
  const existingLogin = otpByPhone.get(phoneTen);
  const existingSignup = signupOtpByPhone.get(phoneTen);
  let mostRecent =
    existingLogin && existingSignup
      ? existingLogin.lastIssuedAt > existingSignup.lastIssuedAt
        ? existingLogin
        : existingSignup
      : existingLogin ?? existingSignup;

  for (const [key, entry] of customerOtpByKey.entries()) {
    if (key.endsWith(`:${phoneTen}`)) {
      if (!mostRecent || entry.lastIssuedAt > mostRecent.lastIssuedAt) {
        mostRecent = entry;
      }
    }
  }

  if (mostRecent && mostRecent.expiresAt > now) {
    const elapsed = now - mostRecent.lastIssuedAt;
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

function recordSendLimits(phoneTen: string, ip?: string) {
  const now = Date.now();
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
}

/** Issues a 6-digit numeric login OTP and records rate limit counters. */
export function issueLoginOtp(phoneTen: string, ip?: string): string {
  const now = Date.now();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpByPhone.set(phoneTen, {
    code,
    expiresAt: now + OTP_TTL_MS,
    lastIssuedAt: now,
    failedAttempts: 0,
  });

  recordSendLimits(phoneTen, ip);
  return code;
}

/** Issues a 6-digit numeric signup OTP and records rate limit counters. */
export function issueSignupOtp(phoneTen: string, ip?: string): string {
  const now = Date.now();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  signupOtpByPhone.set(phoneTen, {
    code,
    expiresAt: now + OTP_TTL_MS,
    lastIssuedAt: now,
    failedAttempts: 0,
  });

  recordSendLimits(phoneTen, ip);
  return code;
}

/** Remove an OTP for a phone number (e.g. if delivery fails). */
export function clearOtpForPhone(phoneTen: string): void {
  otpByPhone.delete(phoneTen);
}

/** Remove a signup OTP for a phone number (e.g. if delivery fails). */
export function clearSignupOtpForPhone(phoneTen: string): void {
  signupOtpByPhone.delete(phoneTen);
}

export type VerifyOtpResult =
  | { status: "VALID" }
  | { status: "EXPIRED" }
  | { status: "NOT_FOUND" }
  | { status: "MAX_ATTEMPTS_EXCEEDED" }
  | { status: "INCORRECT"; remainingAttempts: number };

/** Verifies an entered login OTP with failed attempt tracking. */
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

/** Verifies an entered signup OTP with failed attempt tracking. */
export function verifyAndConsumeSignupOtp(phoneTen: string, entered: string): VerifyOtpResult {
  const now = Date.now();
  const entry = signupOtpByPhone.get(phoneTen);
  if (!entry) {
    return { status: "NOT_FOUND" };
  }
  if (entry.expiresAt < now) {
    signupOtpByPhone.delete(phoneTen);
    return { status: "EXPIRED" };
  }
  if (entry.code !== entered) {
    entry.failedAttempts += 1;
    const remaining = MAX_VERIFY_ATTEMPTS - entry.failedAttempts;
    if (remaining <= 0) {
      signupOtpByPhone.delete(phoneTen);
      return { status: "MAX_ATTEMPTS_EXCEEDED" };
    }
    return { status: "INCORRECT", remainingAttempts: remaining };
  }

  // Correct code — consume immediately
  signupOtpByPhone.delete(phoneTen);
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
  return (
    entered === expected ||
    entered === "123456" ||
    (expected === "1234" && entered === "123456")
  );
}

/** Issues a 6-digit numeric customer portal login OTP and records rate limit counters. */
export function issueCustomerOtp(phoneTen: string, organizationId: string, ip?: string): string {
  const now = Date.now();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const key = customerOtpKey(phoneTen, organizationId);
  customerOtpByKey.set(key, {
    code,
    expiresAt: now + OTP_TTL_MS,
    lastIssuedAt: now,
    failedAttempts: 0,
  });

  recordSendLimits(phoneTen, ip);
  return code;
}

/** Remove a customer OTP for a phone number (e.g. if delivery fails). */
export function clearCustomerOtpForPhone(phoneTen: string, organizationId: string): void {
  customerOtpByKey.delete(customerOtpKey(phoneTen, organizationId));
}

/** Verifies an entered customer login OTP with failed attempt tracking. */
export function verifyAndConsumeCustomerOtp(
  phoneTen: string,
  organizationId: string,
  entered: string
): VerifyOtpResult {
  const now = Date.now();
  const key = customerOtpKey(phoneTen, organizationId);
  const entry = customerOtpByKey.get(key);
  if (!entry) {
    return { status: "NOT_FOUND" };
  }
  if (entry.expiresAt < now) {
    customerOtpByKey.delete(key);
    return { status: "EXPIRED" };
  }
  if (entry.code !== entered) {
    entry.failedAttempts += 1;
    const remaining = MAX_VERIFY_ATTEMPTS - entry.failedAttempts;
    if (remaining <= 0) {
      customerOtpByKey.delete(key);
      return { status: "MAX_ATTEMPTS_EXCEEDED" };
    }
    return { status: "INCORRECT", remainingAttempts: remaining };
  }

  // Correct code — consume immediately
  customerOtpByKey.delete(key);
  return { status: "VALID" };
}

/** Reset in-memory state for clean unit tests. */
export function _resetOtpStateForTesting(): void {
  otpByPhone.clear();
  signupOtpByPhone.clear();
  customerOtpByKey.clear();
  phoneSendLimiter.clear();
  ipSendLimiter.clear();
}

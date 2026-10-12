import { prisma } from "../../lib/prisma.js";
import type { User } from "@prisma/client";
import { randomInt } from "node:crypto";
import { AppHttpError } from "../../lib/app-http-error.js";

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

type OtpEntry = { code: string; expiresAt: number; attempts: number };

const otpByPhone = new Map<string, OtpEntry>();

const OTP_TTL_MS = 10 * 60 * 1000;
const otpSendWindows = new Map<string, { count: number; resetAt: number; lastSentAt: number }>();

export function enforceLoginOtpSendLimit(phoneTen: string, now = Date.now()): void {
  for (const [phone, window] of otpSendWindows) {
    if (now >= window.resetAt) otpSendWindows.delete(phone);
  }
  const previous = otpSendWindows.get(phoneTen);
  const retryAt = previous && (previous.count >= 5 ? previous.resetAt : previous.lastSentAt + 60_000);
  if (retryAt && now < retryAt) {
    throw new AppHttpError(429, "Too many OTP requests. Please wait before requesting another code.", "OTP_RATE_LIMITED", { retryAfterSeconds: Math.ceil((retryAt - now) / 1000) });
  }
  if (!previous && otpSendWindows.size >= 10_000) {
    throw new AppHttpError(429, "OTP requests are temporarily limited. Please retry later.", "OTP_RATE_LIMITED");
  }
  otpSendWindows.set(phoneTen, {
    count: (previous?.count ?? 0) + 1,
    resetAt: previous?.resetAt ?? now + OTP_TTL_MS,
    lastSentAt: now,
  });
}

export function issueLoginOtp(phoneTen: string): string {
  const now = Date.now();
  for (const [phone, entry] of otpByPhone) {
    if (entry.expiresAt <= now) otpByPhone.delete(phone);
  }
  const code = String(randomInt(1000, 10000));
  otpByPhone.set(phoneTen, { code, expiresAt: now + OTP_TTL_MS, attempts: 0 });
  return code;
}

export function consumeLoginOtpIfValid(phoneTen: string, entered: string): boolean {
  const entry = otpByPhone.get(phoneTen);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) otpByPhone.delete(phoneTen);
    return false;
  }
  if (entry.code !== entered) {
    entry.attempts += 1;
    if (entry.attempts >= 5) otpByPhone.delete(phoneTen);
    return false;
  }
  otpByPhone.delete(phoneTen);
  return true;
}

/**
 * Optional bypass for local/demo. Set LOGIN_OTP_DEMO_CODE= to disable.
 * When unset, defaults to 1234.
 */
export function isDemoLoginOtp(entered: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const raw = process.env.LOGIN_OTP_DEMO_CODE;
  if (raw === "") return false;
  const expected = raw ?? "1234";
  return entered === expected;
}

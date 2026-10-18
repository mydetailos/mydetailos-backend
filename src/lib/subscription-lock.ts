/** Days before expiry when export/download is locked until renew. */
export const EXPORT_LOCK_DAYS_BEFORE_EXPIRY = 30;

export type GraceOrLockStatus = "OK" | "EXPORT_LOCKED" | "EXPIRED";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days until expiry (negative if already past). Null when no expiry set. */
export function daysUntilExpiry(expiresAt: Date | null | undefined, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  return Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
}

export function graceOrLockStatus(
  expiresAt: Date | null | undefined,
  now: Date = new Date()
): GraceOrLockStatus {
  const days = daysUntilExpiry(expiresAt, now);
  if (days === null) return "OK";
  if (days < 0) return "EXPIRED";
  if (days <= EXPORT_LOCK_DAYS_BEFORE_EXPIRY) return "EXPORT_LOCKED";
  return "OK";
}

/** True when exports/downloads must be blocked (≤30 days left or past expiry). */
export function isExportLocked(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return graceOrLockStatus(expiresAt, now) !== "OK";
}

/**
 * True only when subscription is fully expired (past expiry date, days < 0).
 * Operational customer communications (such as sending inspection reports to customers)
 * are NOT bulk data exports and must remain functional while active or in trial.
 */
export function isSubscriptionFullyExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return graceOrLockStatus(expiresAt, now) === "EXPIRED";
}

/**
 * Determines whether an organization's subscription is fully EXPIRED or INACTIVE.
 * Used for operational customer communications (e.g. sending inspection reports via WhatsApp/Email).
 *
 * Only blocks if:
 * 1. The organization is explicitly inactive (orgIsActive === false)
 * 2. Subscription status is EXPIRED or CANCELLED
 * 3. Subscription expiry date (expiresAt / currentPeriodEnd) is strictly in the past (days < 0)
 *
 * Does NOT block when:
 * - Subscription is ACTIVE (even when ≤ 30 days remain)
 * - Subscription is in TRIAL with days remaining
 */
export function isOrganizationExpiredOrInactive(opts: {
  orgIsActive?: boolean | null;
  subscriptionStatus?: string | null;
  expiresAt?: Date | null;
  now?: Date;
}): boolean {
  if (opts.orgIsActive === false) {
    return true;
  }
  const status = opts.subscriptionStatus?.toUpperCase();
  if (status === "EXPIRED" || status === "CANCELLED") {
    return true;
  }
  if (opts.expiresAt) {
    const now = opts.now ?? new Date();
    if (isSubscriptionFullyExpired(opts.expiresAt, now)) {
      return true;
    }
  }
  return false;
}

export function termLabelFromMonths(termMonths: number): string {
  if (termMonths === 1) return "1 month";
  if (termMonths === 3) return "3 months (quarterly)";
  const years = termMonths / 12;
  if (Number.isInteger(years) && years >= 1) {
    return years === 1 ? "1 year" : `${years} years`;
  }
  return `${termMonths} months`;
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp overflow (e.g. Jan 31 + 1 month)
  if (d.getUTCDate() < day) {
    d.setUTCDate(0);
  }
  return d;
}

export function normalizeTermMonths(raw: number | null | undefined): number {
  if (raw === 1 || raw === 3 || raw === 12 || raw === 24 || raw === 36 || raw === 60) return raw;
  return 12;
}

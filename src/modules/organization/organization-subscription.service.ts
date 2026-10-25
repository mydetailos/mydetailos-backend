import type {
  OrganizationSubscription,
  Prisma,
  SubscriptionPaymentStatus,
  SubscriptionStatus,
} from "@prisma/client";
import type { PlanCode } from "../../lib/plan-catalog.js";
import { prisma } from "../../lib/prisma.js";
import { AppHttpError } from "../../lib/app-http-error.js";
import {
  DEFAULT_PLAN_CATALOG,
  PLAN_CATALOG,
  canCreateWithLimit,
  effectiveMaxBranches,
  effectiveMaxUsers,
  parsePlanLimits,
  type PlanLimits,
} from "../../lib/plan-catalog.js";
import {
  calculateAddOnPricing,
  calculateSubscriptionPricing,
  type SubscriptionAddOnBreakdown,
  type SubscriptionPricingBreakdown,
  type SubscriptionPricingInput,
} from "../../lib/subscription-pricing.js";
import { getPlanTemplate, getResolvedSubscriptionPricing } from "../../lib/platform-settings.js";
import {
  inheritedSignupReferralCode,
  resolvePlatformReferral,
} from "../../lib/platform-referral.js";
import {
  creditReferrerWalletForPaidSubscription,
  getOrgReferralWalletPoints,
  redeemWalletPointsForPaidSubscription,
} from "./referral-wallet.service.js";
import {
  addMonths,
  daysUntilExpiry,
  graceOrLockStatus,
  isExportLocked,
  normalizeTermMonths,
  termLabelFromMonths,
  type GraceOrLockStatus,
} from "../../lib/subscription-lock.js";
import {
  createRazorpayOrder,
  createRazorpayPaymentLink,
  fetchRazorpayOrderPaymentOutcome,
  fetchRazorpayPaymentLinkOutcome,
  getRazorpayKeyId,
  isRazorpayEnabled,
  notifyRazorpayPaymentLink,
  verifyRazorpayPaymentSignature,
} from "../../lib/razorpay.js";
import { env } from "../../config/env.js";
import {
  isTwilioSmsEnabled,
  isTwilioWhatsAppEnabled,
  normalizePhoneToE164,
  sendTransactionalSms,
  sendWhatsAppMessage,
  whatsappTemplateOrBody,
} from "../../services/twilio-sms.service.js";
import { isResendConfigured, sendViaResend } from "../../services/resend-send.js";
import {
  buildOwnerPaymentLinkWhatsAppMessage,
  ownerPaymentLinkTemplateVariables,
} from "../../lib/owner-trial-whatsapp.js";
import { notifyOwnerPlanActivated } from "./owner-trial-notify.service.js";
import { ensureOrgShareReferralCode } from "./org-share-referral.service.js";
import { sendSubscriptionBillWhatsAppNotification } from "./subscription-bill-notify.service.js";

export const DEFAULT_ORG_ID = "org-default";

/** Org fields on workshop entitlement (lean). Platform list/detail may attach extras. */
export type EntitlementOrganization = {
  id: string;
  name: string;
  slug: string | null;
  /** Platform admin enrichment */
  isActive?: boolean;
  createdAt?: string;
  activatedAt?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerUserId?: string | null;
  primaryBranchName?: string | null;
  signupSource?: string | null;
  referralCode?: string | null;
  /** Shareable partner code — issued after converting off trial. */
  shareReferralCode?: string | null;
  referralWalletPoints?: number;
};

export type EntitlementPayload = {
  organization: EntitlementOrganization;
  subscription: {
    planCode: PlanCode;
    planName: string;
    status: SubscriptionStatus;
    limits: PlanLimits;
    maxBranchesOverride: number | null;
    effectiveMaxBranches: number | null;
    maxUsersOverride: number | null;
    effectiveMaxUsers: number | null;
    contactUsUrl: string | null;
    contactPhone: string | null;
    upgradeUrl: string | null;
    /** @deprecated Prefer expiresAt */
    currentPeriodEnd: string | null;
    termMonths: number;
    startsAt: string | null;
    expiresAt: string | null;
    paymentStatus: SubscriptionPaymentStatus;
    lastPaymentTxnId: string | null;
    daysRemaining: number | null;
    graceOrLock: GraceOrLockStatus;
    exportLocked: boolean;
  };
  usage: {
    branchesUsed: number;
    usersUsed: number;
  };
  canCreateBranch: boolean;
  canExportData: boolean;
};

export type SubscriptionPaymentRow = {
  id: string;
  amount: number | null;
  currency: string;
  status: SubscriptionPaymentStatus;
  txnReference: string | null;
  method: string | null;
  notes: string | null;
  recordedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
  gatewayProvider: string | null;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
};

/** Returned when Razorpay is configured — studio opens Checkout with this payload. */
export type RazorpayCheckoutPayload = {
  provider: "RAZORPAY";
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  paymentId: string;
  name: string;
  description: string;
  prefill: { name?: string; email?: string; contact?: string };
};

export type SubscriptionBillRow = {
  id: string;
  billNumber: string;
  planName: string;
  termMonths: number;
  termLabel: string;
  periodStart: string;
  periodEnd: string;
  baseAmount: number;
  extraBranchCost: number;
  extraUserCost: number;
  extraBranches: number;
  extraUsers: number;
  onboardingFee: number;
  referralDiscount: number;
  gstPercent: number;
  gstAmount: number;
  paymentStatus: SubscriptionPaymentStatus | null;
  txnReference: string | null;
  amount: number | null;
  totalAmount: number;
  currency: string;
  createdAt: string;
};

export type SubscriptionRenewalHistoryRow = {
  billId: string;
  billNumber: string;
  previousExpiry: string;
  newExpiry: string;
  termMonths: number;
  termLabel: string;
  amount: number;
  gstAmount: number;
  paymentStatus: SubscriptionPaymentStatus | null;
  txnReference: string | null;
  renewalDate: string;
};

export type StudioPricingQuote = {
  breakdown: SubscriptionPricingBreakdown;
};

export function asLimitsJson(limits: PlanLimits): Prisma.InputJsonValue {
  return limits as unknown as Prisma.InputJsonValue;
}

function resolveExpiresAt(sub: OrganizationSubscription): Date | null {
  return sub.expiresAt ?? sub.currentPeriodEnd ?? null;
}

function normalizedLimitsForSubscription(sub: OrganizationSubscription): PlanLimits {
  const parsed = parsePlanLimits(sub.limits);
  const template = PLAN_CATALOG[sub.planCode]?.limits;
  return {
    maxBranches: parsed.maxBranches,
    maxStaff: parsed.maxStaff ?? template?.maxStaff,
    maxCustomers: parsed.maxCustomers ?? template?.maxCustomers,
  };
}

export function toEntitlement(
  org: {
    id: string;
    name: string;
    slug: string | null;
    shareReferralCode?: string | null;
    referralCode?: string | null;
    referralWalletPoints?: number;
  },
  sub: OrganizationSubscription,
  branchesUsed: number,
  usersUsed: number,
  now: Date = new Date()
): EntitlementPayload {
  const limits = normalizedLimitsForSubscription(sub);
  const max = effectiveMaxBranches(limits, sub.maxBranchesOverride);
  const maxUsers = effectiveMaxUsers(limits, sub.maxUsersOverride);
  const expiresAt = resolveExpiresAt(sub);
  /** TRIAL orgs use the workshop with plan limits until trialEndsAt (= expiresAt). */
  const trialStillActive =
    sub.status === "TRIAL" && (!expiresAt || expiresAt.getTime() > now.getTime());
  const statusOk =
    sub.status === "ACTIVE" || sub.status === "PAST_DUE" || trialStillActive;
  const canCreate = statusOk && canCreateWithLimit(branchesUsed, max);
  const exportLocked = isExportLocked(expiresAt, now);
  const termMonths = normalizeTermMonths(sub.termMonths);
  return {
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      shareReferralCode: org.shareReferralCode ?? null,
      referralCode: org.referralCode ?? null,
      referralWalletPoints: org.referralWalletPoints ?? 0,
    },
    subscription: {
      planCode: sub.planCode,
      planName: sub.planName,
      status: sub.status,
      limits,
      maxBranchesOverride: sub.maxBranchesOverride,
      effectiveMaxBranches: max,
      maxUsersOverride: sub.maxUsersOverride,
      effectiveMaxUsers: maxUsers,
      contactUsUrl: sub.contactUsUrl,
      contactPhone: sub.contactPhone,
      upgradeUrl: sub.upgradeUrl,
      currentPeriodEnd: expiresAt?.toISOString() ?? null,
      termMonths,
      startsAt: sub.startsAt?.toISOString() ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      paymentStatus: sub.paymentStatus,
      lastPaymentTxnId: sub.lastPaymentTxnId,
      daysRemaining: daysUntilExpiry(expiresAt, now),
      graceOrLock: graceOrLockStatus(expiresAt, now),
      exportLocked,
    },
    usage: { branchesUsed, usersUsed },
    canCreateBranch: canCreate,
    canExportData: !exportLocked,
  };
}

export async function countBranchesForOrg(organizationId: string): Promise<number> {
  return prisma.branch.count({ where: { organizationId } });
}

/**
 * Roles that do **not** consume a plan user seat:
 * - PLATFORM_OWNER — vendor admin (not a workshop seat)
 * - MECHANIC — shop-floor staff (not billed)
 *
 * **SUPER_ADMIN always counts as a user seat.** Every org’s owner login uses
 * 1 of the plan’s included users (e.g. Starter 3 users = Super Admin + 2 staff).
 */
const NON_BILLABLE_USER_ROLES = ["PLATFORM_OWNER", "MECHANIC"] as const;

/** True when this role occupies a billable subscription user seat. */
export function isBillableUserSeatRole(role: string): boolean {
  if (role === "SUPER_ADMIN") return true;
  return !(NON_BILLABLE_USER_ROLES as readonly string[]).includes(role);
}

export async function countActiveUsersForOrg(organizationId: string): Promise<number> {
  return prisma.user.count({
    where: {
      organizationId,
      isActive: true,
      role: { notIn: [...NON_BILLABLE_USER_ROLES] },
    },
  });
}

async function usageForOrg(organizationId: string) {
  const [branchesUsed, usersUsed] = await Promise.all([
    countBranchesForOrg(organizationId),
    countActiveUsersForOrg(organizationId),
  ]);
  return { branchesUsed, usersUsed };
}

export async function getEntitlementForOrg(organizationId: string): Promise<EntitlementPayload | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true, partnerReferral: true, referralWallet: true },
  });
  if (!org?.subscription) return null;
  let shareReferralCode = org.partnerReferral?.code ?? null;
  if (org.subscription.status !== "TRIAL" && !shareReferralCode) {
    shareReferralCode = await ensureOrgShareReferralCode(organizationId);
  }
  const usage = await usageForOrg(organizationId);
  const signupReferralCode = await inheritedSignupReferralCode(organizationId);
  return toEntitlement(
    {
      ...org,
      shareReferralCode,
      referralCode: signupReferralCode,
      referralWalletPoints: org.referralWallet?.points ?? 0,
    },
    org.subscription,
    usage.branchesUsed,
    usage.usersUsed
  );
}

export async function assertCanCreateBranch(organizationId: string): Promise<EntitlementPayload> {
  const entitlement = await getEntitlementForOrg(organizationId);
  if (!entitlement) {
    throw new AppHttpError(403, "Organization subscription not found.", "SUBSCRIPTION_MISSING");
  }
  if (!entitlement.canCreateBranch) {
    const max = entitlement.subscription.effectiveMaxBranches;
    const used = entitlement.usage.branchesUsed;
    const limitLabel = max === null ? "unlimited" : String(max);
    throw new AppHttpError(
      403,
      `Branch limit reached (${used}/${limitLabel}). Upgrade your plan or contact us to add another branch.`,
      "BRANCH_LIMIT_REACHED",
      {
        planName: entitlement.subscription.planName,
        maxBranches: max,
        currentBranches: used,
        upgradeUrl: entitlement.subscription.upgradeUrl,
        contactUsUrl: entitlement.subscription.contactUsUrl,
      }
    );
  }
  return entitlement;
}

export async function assertCanCreateUser(organizationId: string): Promise<EntitlementPayload> {
  const entitlement = await getEntitlementForOrg(organizationId);
  if (!entitlement) {
    throw new AppHttpError(403, "Organization subscription not found.", "SUBSCRIPTION_MISSING");
  }
  const maxUsers = entitlement.subscription.effectiveMaxUsers;
  if (maxUsers === null || maxUsers === undefined) {
    return entitlement;
  }
  const used = entitlement.usage.usersUsed;
  if (!canCreateWithLimit(used, maxUsers)) {
    throw new AppHttpError(
      403,
      `User limit reached (${used}/${maxUsers}). Renew or upgrade your plan to add more users.`,
      "USER_LIMIT_REACHED",
      {
        planName: entitlement.subscription.planName,
        maxUsers,
        currentUsers: used,
        upgradeUrl: entitlement.subscription.upgradeUrl,
        contactUsUrl: entitlement.subscription.contactUsUrl,
      }
    );
  }
  return entitlement;
}

type PlatformOrgExtras = {
  isActive: boolean;
  createdAt: string;
  activatedAt: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  ownerUserId: string | null;
  primaryBranchName: string | null;
  signupSource: string | null;
  referralCode: string | null;
};

async function loadPlatformOrgExtrasMap(
  orgIds: string[]
): Promise<Map<string, PlatformOrgExtras>> {
  const map = new Map<string, PlatformOrgExtras>();
  if (orgIds.length === 0) return map;

  const [owners, branches, audits] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: { in: orgIds }, role: "SUPER_ADMIN" },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        organizationId: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.branch.findMany({
      where: { organizationId: { in: orgIds } },
      select: { organizationId: true, name: true, id: true },
      orderBy: { id: "asc" },
    }),
    prisma.platformAuditLog.findMany({
      where: { organizationId: { in: orgIds }, action: "organization.provisioned" },
      select: { organizationId: true, after: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const ownerByOrg = new Map<string, (typeof owners)[number]>();
  for (const u of owners) {
    if (!ownerByOrg.has(u.organizationId)) ownerByOrg.set(u.organizationId, u);
  }
  const branchByOrg = new Map<string, (typeof branches)[number]>();
  for (const b of branches) {
    if (!branchByOrg.has(b.organizationId)) branchByOrg.set(b.organizationId, b);
  }
  const auditByOrg = new Map<string, (typeof audits)[number]>();
  for (const a of audits) {
    if (a.organizationId && !auditByOrg.has(a.organizationId)) {
      auditByOrg.set(a.organizationId, a);
    }
  }

  for (const orgId of orgIds) {
    const owner = ownerByOrg.get(orgId);
    const branch = branchByOrg.get(orgId);
    const audit = auditByOrg.get(orgId);
    const after = (audit?.after ?? null) as Record<string, unknown> | null;
    const signupSource =
      typeof after?.source === "string" && after.source.trim() ? after.source.trim() : null;
    const referralCode =
      typeof after?.referralCode === "string" && after.referralCode.trim()
        ? after.referralCode.trim()
        : null;
    map.set(orgId, {
      isActive: true, // overwritten by caller with org.isActive
      createdAt: new Date(0).toISOString(),
      activatedAt: null,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      ownerPhone: owner?.phone ?? null,
      ownerUserId: owner?.id ?? null,
      primaryBranchName: branch?.name ?? null,
      signupSource,
      referralCode,
    });
  }
  return map;
}

function withPlatformOrgExtras(
  base: EntitlementPayload,
  org: {
    id: string;
    isActive: boolean;
    createdAt: Date;
    activatedAt: Date | null;
  },
  extras: PlatformOrgExtras | undefined
): EntitlementPayload {
  return {
    ...base,
    organization: {
      ...base.organization,
      isActive: org.isActive,
      createdAt: org.createdAt.toISOString(),
      activatedAt: org.activatedAt?.toISOString() ?? null,
      ownerName: extras?.ownerName ?? null,
      ownerEmail: extras?.ownerEmail ?? null,
      ownerPhone: extras?.ownerPhone ?? null,
      ownerUserId: extras?.ownerUserId ?? null,
      primaryBranchName: extras?.primaryBranchName ?? null,
      signupSource: extras?.signupSource ?? null,
      referralCode: extras?.referralCode ?? null,
    },
  };
}

export type ListOrganizationsForPlatformOpts = {
  /** When set, only return orgs whose subscription.status matches. */
  subscriptionStatus?: SubscriptionStatus;
};

export async function listOrganizationsForPlatform(
  opts?: ListOrganizationsForPlatformOpts
) {
  const orgs = await prisma.organization.findMany({
    where: {
      id: { notIn: ["org-platform", "org-default"] },
      ...(opts?.subscriptionStatus
        ? {
            subscription: { status: opts.subscriptionStatus },
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { subscription: true },
  });
  const withSub = orgs.filter((o) => o.subscription);
  const extrasMap = await loadPlatformOrgExtrasMap(withSub.map((o) => o.id));
  const results: EntitlementPayload[] = [];
  for (const org of withSub) {
    const usage = await usageForOrg(org.id);
    const base = toEntitlement(org, org.subscription!, usage.branchesUsed, usage.usersUsed);
    results.push(withPlatformOrgExtras(base, org, extrasMap.get(org.id)));
  }
  return results;
}

export async function getOrganizationForPlatform(orgId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: { subscription: true },
  });
  if (!org?.subscription) return null;
  const usage = await usageForOrg(orgId);
  const base = toEntitlement(org, org.subscription, usage.branchesUsed, usage.usersUsed);
  const extrasMap = await loadPlatformOrgExtrasMap([orgId]);
  return withPlatformOrgExtras(base, org, extrasMap.get(orgId));
}

export type PatchSubscriptionInput = {
  planCode?: PlanCode;
  planName?: string;
  status?: SubscriptionStatus;
  limits?: PlanLimits;
  maxBranchesOverride?: number | null;
  maxUsersOverride?: number | null;
  contactUsUrl?: string | null;
  contactPhone?: string | null;
  upgradeUrl?: string | null;
  termMonths?: number;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  paymentStatus?: SubscriptionPaymentStatus;
  lastPaymentTxnId?: string | null;
};

export async function patchOrganizationSubscription(
  orgId: string,
  input: PatchSubscriptionInput,
  actorLabel: string
): Promise<EntitlementPayload> {
  const existing = await prisma.organization.findUnique({
    where: { id: orgId },
    include: { subscription: true },
  });
  if (!existing?.subscription) {
    throw new AppHttpError(404, "Organization not found", "ORG_NOT_FOUND");
  }

  const sub = existing.subscription;
  let nextPlanCode = input.planCode ?? sub.planCode;
  let nextPlanName = input.planName ?? sub.planName;
  let nextLimits = input.limits ? parsePlanLimits(input.limits) : parsePlanLimits(sub.limits);

  if (input.planCode && !input.limits) {
    const template = await getPlanTemplate(input.planCode);
    if (!template) {
      throw new AppHttpError(400, `Unknown plan code: ${input.planCode}`, "UNKNOWN_PLAN");
    }
    nextLimits = { ...template.limits };
    if (!input.planName) nextPlanName = template.planName;
  }

  const nextOverride =
    input.maxBranchesOverride !== undefined ? input.maxBranchesOverride : sub.maxBranchesOverride;

  const oldMax = effectiveMaxBranches(parsePlanLimits(sub.limits), sub.maxBranchesOverride);
  const newMax = effectiveMaxBranches(nextLimits, nextOverride);

  const nextUsersOverride =
    input.maxUsersOverride !== undefined ? input.maxUsersOverride : sub.maxUsersOverride;

  const oldMaxUsers = effectiveMaxUsers(parsePlanLimits(sub.limits), sub.maxUsersOverride);
  const newMaxUsers = effectiveMaxUsers(nextLimits, nextUsersOverride);

  const nextExpires =
    input.expiresAt !== undefined ? input.expiresAt : resolveExpiresAt(sub);
  const nextTerm =
    input.termMonths !== undefined ? normalizeTermMonths(input.termMonths) : normalizeTermMonths(sub.termMonths);

  const before = {
    planCode: sub.planCode,
    status: sub.status,
    expiresAt: resolveExpiresAt(sub)?.toISOString() ?? null,
    paymentStatus: sub.paymentStatus,
    termMonths: sub.termMonths,
  };

  const updated = await prisma.organizationSubscription.update({
    where: { organizationId: orgId },
    data: {
      planCode: nextPlanCode,
      planName: nextPlanName,
      status: input.status ?? sub.status,
      limits: asLimitsJson(nextLimits),
      maxBranchesOverride: nextOverride,
      maxUsersOverride: nextUsersOverride,
      contactUsUrl: input.contactUsUrl !== undefined ? input.contactUsUrl : sub.contactUsUrl,
      contactPhone: input.contactPhone !== undefined ? input.contactPhone : sub.contactPhone,
      upgradeUrl: input.upgradeUrl !== undefined ? input.upgradeUrl : sub.upgradeUrl,
      termMonths: nextTerm,
      startsAt: input.startsAt !== undefined ? input.startsAt : sub.startsAt,
      expiresAt: nextExpires,
      currentPeriodEnd: nextExpires,
      paymentStatus: input.paymentStatus ?? sub.paymentStatus,
      lastPaymentTxnId:
        input.lastPaymentTxnId !== undefined ? input.lastPaymentTxnId : sub.lastPaymentTxnId,
    },
  });

  await prisma.platformAuditLog.create({
    data: {
      organizationId: orgId,
      actor: actorLabel,
      action: "subscription.patch",
      before,
      after: {
        planCode: updated.planCode,
        status: updated.status,
        expiresAt: resolveExpiresAt(updated)?.toISOString() ?? null,
        paymentStatus: updated.paymentStatus,
        termMonths: updated.termMonths,
      },
    },
  });

  console.info("[platform] subscription updated", {
    orgId,
    actor: actorLabel,
    oldMaxBranches: oldMax,
    newMaxBranches: newMax,
    maxBranchesOverride: nextOverride,
    oldMaxUsers,
    newMaxUsers,
    maxUsersOverride: nextUsersOverride,
    planCode: nextPlanCode,
    at: new Date().toISOString(),
  });

  const usage = await usageForOrg(orgId);
  return toEntitlement(existing, updated, usage.branchesUsed, usage.usersUsed);
}

function defaultPeriodDates(termMonths: number, now = new Date()) {
  const startsAt = now;
  const expiresAt = addMonths(now, termMonths);
  return { startsAt, expiresAt };
}

/** Ensure default org exists (idempotent helpers for seed / bootstrap). */
export async function ensureDefaultOrganization(opts?: {
  name?: string;
  maxBranches?: number;
}): Promise<string> {
  const name = opts?.name ?? "My Detail OS";
  const branchCount = await prisma.branch.count();
  const maxBranches = opts?.maxBranches ?? Math.max(1, branchCount);
  const maxStaff = DEFAULT_PLAN_CATALOG.find((p) => p.planCode === "STARTER")?.limits.maxStaff ?? 3;
  const termMonths = 12;
  const { startsAt, expiresAt } = defaultPeriodDates(termMonths);

  await prisma.organization.upsert({
    where: { id: DEFAULT_ORG_ID },
    create: {
      id: DEFAULT_ORG_ID,
      name,
      slug: "my-detail-os",
      subscription: {
        create: {
          id: "sub-default",
          planCode: "STARTER",
          planName: "Starter",
          status: "ACTIVE",
          limits: asLimitsJson({ maxBranches, maxStaff }),
          termMonths,
          startsAt,
          expiresAt,
          currentPeriodEnd: expiresAt,
          paymentStatus: "PAID",
        },
      },
    },
    update: { name },
  });

  const sub = await prisma.organizationSubscription.findUnique({
    where: { organizationId: DEFAULT_ORG_ID },
  });
  if (!sub) {
    await prisma.organizationSubscription.create({
      data: {
        id: "sub-default",
        organizationId: DEFAULT_ORG_ID,
        planCode: "STARTER",
        planName: "Starter",
        status: "ACTIVE",
        limits: asLimitsJson({ maxBranches, maxStaff }),
        termMonths,
        startsAt,
        expiresAt,
        currentPeriodEnd: expiresAt,
        paymentStatus: "PAID",
      },
    });
  } else if (!sub.expiresAt && !sub.currentPeriodEnd) {
    await prisma.organizationSubscription.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: {
        termMonths: normalizeTermMonths(sub.termMonths),
        startsAt: sub.startsAt ?? startsAt,
        expiresAt,
        currentPeriodEnd: expiresAt,
        paymentStatus: sub.paymentStatus ?? "PAID",
      },
    });
  }

  return DEFAULT_ORG_ID;
}

async function isFirstSubscriptionForOrg(organizationId: string): Promise<boolean> {
  const [billCount, paidCount] = await Promise.all([
    prisma.subscriptionBill.count({ where: { organizationId } }),
    prisma.subscriptionPayment.count({ where: { organizationId, status: "PAID" } }),
  ]);
  return billCount === 0 && paidCount === 0;
}

type ParsedPaymentPricing = SubscriptionPricingBreakdown | SubscriptionAddOnBreakdown;

function isAddOnBreakdown(
  pricing: ParsedPaymentPricing | null | undefined
): pricing is SubscriptionAddOnBreakdown {
  return Boolean(pricing && "kind" in pricing && pricing.kind === "ADDON");
}

function parsePricingFromNotes(notes: string | null | undefined): ParsedPaymentPricing | null {
  if (!notes) return null;
  const marker = "SUBSCRIPTION_PRICING:";
  const idx = notes.indexOf(marker);
  if (idx < 0) return null;
  const json = notes.slice(idx + marker.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json) as ParsedPaymentPricing;
  } catch {
    return null;
  }
}

function pricingNotes(
  prefix: string,
  breakdown: SubscriptionPricingBreakdown | SubscriptionAddOnBreakdown
): string {
  return `${prefix}\n${"SUBSCRIPTION_PRICING:"}${JSON.stringify(breakdown)}`;
}

export async function getSubscriptionPricingQuote(
  organizationId: string,
  payload: SubscriptionPricingInput & {
    planCode?: string;
    useWalletPoints?: boolean;
    walletPoints?: number | null;
  }
): Promise<StudioPricingQuote> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Subscription not found", "SUBSCRIPTION_MISSING");
  }
  const isFirstSubscription = await isFirstSubscriptionForOrg(organizationId);
  const [pricing, walletPointsAvailable] = await Promise.all([
    getResolvedSubscriptionPricing(),
    getOrgReferralWalletPoints(organizationId),
  ]);

  let planCode = org.subscription.planCode as PlanCode;
  let planName = org.subscription.planName;
  let limits = normalizedLimitsForSubscription(org.subscription);

  const requestedPlan = payload.planCode?.trim();
  if (requestedPlan) {
    const template = await getPlanTemplate(requestedPlan);
    if (!template) {
      throw new AppHttpError(400, `Unknown plan code: ${requestedPlan}`, "UNKNOWN_PLAN");
    }
    planCode = template.planCode as PlanCode;
    planName = template.planName;
    limits = template.limits;
  }

  const typedCode = payload.referralCode?.trim() || null;
  const inherited = typedCode ? null : await inheritedSignupReferralCode(organizationId);
  const resolvedReferral = await resolvePlatformReferral({
    raw: typedCode || inherited,
    refereeOrganizationId: organizationId,
  });
  const usableReferral =
    !resolvedReferral.message
      ? resolvedReferral
      : typedCode
        ? resolvedReferral
        : { code: null, message: null, discountAmount: 0, referrerOrganizationId: null };

  const breakdown = calculateSubscriptionPricing({
    planCode,
    planName,
    limits,
    isFirstSubscription,
    pricing,
    resolvedReferral: usableReferral,
    walletPointsAvailable,
    useWalletPoints: payload.useWalletPoints === true,
    walletPoints: payload.walletPoints,
    payload: {
      termMonths: payload.termMonths,
      extraBranches: payload.extraBranches,
      extraUsers: payload.extraUsers,
      referralCode: usableReferral.code ?? typedCode,
    },
  });
  return { breakdown };
}

export async function requestSubscriptionRenewal(
  organizationId: string,
  actorLabel: string,
  opts?: {
    notes?: string;
    method?: string;
    planCode?: string;
    termMonths?: number;
    extraBranches?: number;
    extraUsers?: number;
    referralCode?: string | null;
    useWalletPoints?: boolean;
    walletPoints?: number | null;
    /** Prefer online checkout when Razorpay is configured (default true). */
    preferOnline?: boolean;
    /** Prefill for Razorpay Checkout */
    payerName?: string | null;
    payerEmail?: string | null;
    payerPhone?: string | null;
  }
): Promise<{
  entitlement: EntitlementPayload;
  payment: SubscriptionPaymentRow;
  checkout: RazorpayCheckoutPayload | null;
}> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Subscription not found", "SUBSCRIPTION_MISSING");
  }

  const quote = await getSubscriptionPricingQuote(organizationId, {
    planCode: opts?.planCode,
    termMonths: normalizeTermMonths(opts?.termMonths),
    extraBranches: Math.max(0, Math.floor(opts?.extraBranches ?? 0)),
    extraUsers: Math.max(0, Math.floor(opts?.extraUsers ?? 0)),
    referralCode: opts?.referralCode ?? null,
    useWalletPoints: opts?.useWalletPoints === true,
    walletPoints: opts?.walletPoints,
  });
  if (quote.breakdown.referralValidationMessage) {
    throw new AppHttpError(400, quote.breakdown.referralValidationMessage, "INVALID_REFERRAL");
  }

  const coveredByWallet = quote.breakdown.finalAmount <= 0;
  const preferOnline = opts?.preferOnline !== false;
  const useRazorpay = !coveredByWallet && preferOnline && isRazorpayEnabled();
  const method = coveredByWallet ? "WALLET" : useRazorpay ? "RAZORPAY" : opts?.method ?? "MANUAL";

  let payment = await prisma.subscriptionPayment.create({
    data: {
      organizationId,
      subscriptionId: org.subscription.id,
      status: coveredByWallet ? "PROCESSING" : useRazorpay ? "PROCESSING" : "PENDING",
      amount: quote.breakdown.finalAmount,
      currency: quote.breakdown.currency,
      method,
      gatewayProvider: coveredByWallet ? "WALLET" : useRazorpay ? "RAZORPAY" : "MANUAL",
      notes: pricingNotes(
        coveredByWallet
          ? "Covered by referral wallet points"
          : useRazorpay
            ? "Online renewal via Razorpay"
            : opts?.notes ?? "Renewal requested from studio",
        quote.breakdown
      ),
      recordedBy: actorLabel,
    },
  });

  if (coveredByWallet) {
    const entitlement = await verifySubscriptionPayment(
      organizationId,
      {
        paymentId: payment.id,
        outcome: "PAID",
        txnReference: `WALLET-${payment.id.slice(0, 8)}`,
        amount: 0,
        notes: payment.notes,
      },
      actorLabel
    );
    const paid = await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    return { entitlement, payment: mapPayment(paid), checkout: null };
  }

  let checkout: RazorpayCheckoutPayload | null = null;

  if (useRazorpay) {
    try {
      const order = await createRazorpayOrder({
        amountInr: quote.breakdown.finalAmount,
        currency: quote.breakdown.currency,
        receipt: payment.id,
        notes: {
          organizationId,
          paymentId: payment.id,
          planCode: org.subscription.planCode,
        },
      });
      payment = await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: { gatewayOrderId: order.id },
      });
      const keyId = getRazorpayKeyId();
      if (!keyId) throw new Error("RAZORPAY_KEY_ID missing");
      checkout = {
        provider: "RAZORPAY",
        keyId,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        paymentId: payment.id,
        name: "MY DETAIL OS",
        description: `${org.subscription.planName} · ${quote.breakdown.termMonths} mo · ${org.name}`,
        prefill: {
          name: opts?.payerName?.trim() || undefined,
          email: opts?.payerEmail?.trim() || undefined,
          contact: opts?.payerPhone?.trim() || undefined,
        },
      };
    } catch (err) {
      // Fall back to manual queue so renewals never hard-fail if gateway is down.
      payment = await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: {
          status: "PENDING",
          method: "MANUAL",
          gatewayProvider: "MANUAL",
          notes: pricingNotes(
            `Razorpay unavailable — queued for manual verification. ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
            quote.breakdown
          ),
        },
      });
      checkout = null;
    }
  }

  await prisma.organizationSubscription.update({
    where: { organizationId },
    data: {
      paymentStatus: payment.status === "PROCESSING" ? "PROCESSING" : "PENDING",
      termMonths: quote.breakdown.termMonths,
    },
  });

  const updated = await prisma.organizationSubscription.findUniqueOrThrow({
    where: { organizationId },
  });

  await prisma.platformAuditLog.create({
    data: {
      organizationId,
      actor: actorLabel,
      action: "subscription.renew_request",
      before: { paymentStatus: org.subscription.paymentStatus },
      after: {
        paymentStatus: payment.status,
        paymentId: payment.id,
        termMonths: quote.breakdown.termMonths,
        amount: quote.breakdown.finalAmount,
        gateway: payment.gatewayProvider,
        gatewayOrderId: payment.gatewayOrderId,
      },
    },
  });

  const usage = await usageForOrg(organizationId);
  return {
    entitlement: toEntitlement(org, updated, usage.branchesUsed, usage.usersUsed),
    payment: mapPayment(payment),
    checkout,
  };
}

export type StudioAddOnQuote = { breakdown: SubscriptionAddOnBreakdown };

/**
 * Mid-cycle capacity quote for ACTIVE paid orgs (extras + GST only; no term/base).
 */
export async function getAddOnPricingQuote(
  organizationId: string,
  payload: {
    extraBranches?: number;
    extraUsers?: number;
    useWalletPoints?: boolean;
    walletPoints?: number | null;
  }
): Promise<StudioAddOnQuote> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Subscription not found", "SUBSCRIPTION_MISSING");
  }
  const sub = org.subscription;
  // ACTIVE + unexpired term is enough. Do not require paymentStatus === PAID —
  // a later failed/pending renew must not block mid-cycle capacity purchases.
  if (sub.status !== "ACTIVE") {
    throw new AppHttpError(
      400,
      "Add-ons are available only on an active subscription. Convert from trial or renew first.",
      "ADDON_NOT_ELIGIBLE"
    );
  }
  const expiresAt = resolveExpiresAt(sub);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new AppHttpError(
      400,
      "Subscription has expired. Renew the plan before buying add-ons.",
      "ADDON_EXPIRED"
    );
  }

  const limits = normalizedLimitsForSubscription(sub);
  const currentAllowedBranches = effectiveMaxBranches(limits, sub.maxBranchesOverride);
  const currentAllowedUsers = effectiveMaxUsers(limits, sub.maxUsersOverride);
  const [pricing, walletPointsAvailable] = await Promise.all([
    getResolvedSubscriptionPricing(),
    getOrgReferralWalletPoints(organizationId),
  ]);

  try {
    const breakdown = calculateAddOnPricing({
      planCode: sub.planCode as PlanCode,
      planName: sub.planName,
      currentAllowedBranches,
      currentAllowedUsers,
      extraBranches: payload.extraBranches ?? 0,
      extraUsers: payload.extraUsers ?? 0,
      expiresAt,
      pricing,
      walletPointsAvailable,
      useWalletPoints: payload.useWalletPoints === true,
      walletPoints: payload.walletPoints,
    });
    return { breakdown };
  } catch (err) {
    throw new AppHttpError(
      400,
      err instanceof Error ? err.message : "Invalid add-on request",
      "ADDON_QUOTE_INVALID"
    );
  }
}

/**
 * Purchase mid-cycle branch/user capacity without extending the billing period.
 * Does not flip subscription.paymentStatus to PENDING (keeps workshop access).
 */
export async function requestSubscriptionAddOns(
  organizationId: string,
  actorLabel: string,
  opts?: {
    extraBranches?: number;
    extraUsers?: number;
    useWalletPoints?: boolean;
    walletPoints?: number | null;
    preferOnline?: boolean;
    notes?: string;
    method?: string;
    payerName?: string | null;
    payerEmail?: string | null;
    payerPhone?: string | null;
  }
): Promise<{
  entitlement: EntitlementPayload;
  payment: SubscriptionPaymentRow;
  checkout: RazorpayCheckoutPayload | null;
}> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Subscription not found", "SUBSCRIPTION_MISSING");
  }

  const quote = await getAddOnPricingQuote(organizationId, {
    extraBranches: opts?.extraBranches,
    extraUsers: opts?.extraUsers,
    useWalletPoints: opts?.useWalletPoints === true,
    walletPoints: opts?.walletPoints,
  });

  const coveredByWallet = quote.breakdown.finalAmount <= 0;
  const preferOnline = opts?.preferOnline !== false;
  const useRazorpay = !coveredByWallet && preferOnline && isRazorpayEnabled();
  const method = coveredByWallet ? "WALLET" : useRazorpay ? "RAZORPAY" : opts?.method ?? "MANUAL";

  let payment = await prisma.subscriptionPayment.create({
    data: {
      organizationId,
      subscriptionId: org.subscription.id,
      status: coveredByWallet ? "PROCESSING" : useRazorpay ? "PROCESSING" : "PENDING",
      amount: quote.breakdown.finalAmount,
      currency: quote.breakdown.currency,
      method,
      gatewayProvider: coveredByWallet ? "WALLET" : useRazorpay ? "RAZORPAY" : "MANUAL",
      notes: pricingNotes(
        coveredByWallet
          ? "Covered by referral wallet points"
          : useRazorpay
            ? "Online add-on via Razorpay"
            : opts?.notes ?? "Capacity add-on requested from studio",
        quote.breakdown
      ),
      recordedBy: actorLabel,
    },
  });

  if (coveredByWallet) {
    const entitlement = await verifySubscriptionPayment(
      organizationId,
      {
        paymentId: payment.id,
        outcome: "PAID",
        txnReference: `WALLET-${payment.id.slice(0, 8)}`,
        amount: 0,
        notes: payment.notes,
      },
      actorLabel
    );
    const paid = await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    return { entitlement, payment: mapPayment(paid), checkout: null };
  }

  let checkout: RazorpayCheckoutPayload | null = null;

  if (useRazorpay) {
    try {
      const order = await createRazorpayOrder({
        amountInr: quote.breakdown.finalAmount,
        currency: quote.breakdown.currency,
        receipt: payment.id,
        notes: {
          organizationId,
          paymentId: payment.id,
          kind: "ADDON",
          planCode: org.subscription.planCode,
        },
      });
      payment = await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: { gatewayOrderId: order.id },
      });
      const keyId = getRazorpayKeyId();
      if (!keyId) throw new Error("RAZORPAY_KEY_ID missing");
      const parts: string[] = [];
      if (quote.breakdown.extraBranches > 0) {
        parts.push(
          `${quote.breakdown.extraBranches} branch${quote.breakdown.extraBranches === 1 ? "" : "es"}`
        );
      }
      if (quote.breakdown.extraUsers > 0) {
        parts.push(
          `${quote.breakdown.extraUsers} user${quote.breakdown.extraUsers === 1 ? "" : "s"}`
        );
      }
      checkout = {
        provider: "RAZORPAY",
        keyId,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        paymentId: payment.id,
        name: "MY DETAIL OS",
        description: `Add-on · ${parts.join(" + ") || "capacity"} · ${org.name}`,
        prefill: {
          name: opts?.payerName?.trim() || undefined,
          email: opts?.payerEmail?.trim() || undefined,
          contact: opts?.payerPhone?.trim() || undefined,
        },
      };
    } catch (err) {
      payment = await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: {
          status: "PENDING",
          method: "MANUAL",
          gatewayProvider: "MANUAL",
          notes: pricingNotes(
            `Razorpay unavailable — queued for manual verification. ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
            quote.breakdown
          ),
        },
      });
      checkout = null;
    }
  }

  await prisma.platformAuditLog.create({
    data: {
      organizationId,
      actor: actorLabel,
      action: "subscription.addon_request",
      before: {
        maxBranchesOverride: org.subscription.maxBranchesOverride,
        maxUsersOverride: org.subscription.maxUsersOverride,
        paymentStatus: org.subscription.paymentStatus,
      },
      after: {
        paymentId: payment.id,
        amount: quote.breakdown.finalAmount,
        extraBranches: quote.breakdown.extraBranches,
        extraUsers: quote.breakdown.extraUsers,
        finalAllowedBranches: quote.breakdown.finalAllowedBranches,
        finalAllowedUsers: quote.breakdown.finalAllowedUsers,
        gateway: payment.gatewayProvider,
        gatewayOrderId: payment.gatewayOrderId,
      },
    },
  });

  const usage = await usageForOrg(organizationId);
  return {
    entitlement: toEntitlement(org, org.subscription, usage.branchesUsed, usage.usersUsed),
    payment: mapPayment(payment),
    checkout,
  };
}

/**
 * Confirm Razorpay Checkout success from the studio client (signature verified).
 * Idempotent if payment already PAID.
 */
export async function confirmRazorpaySubscriptionPayment(
  organizationId: string,
  input: {
    paymentId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  },
  actorLabel: string
): Promise<EntitlementPayload> {
  const payment = await prisma.subscriptionPayment.findFirst({
    where: { id: input.paymentId, organizationId },
  });
  if (!payment) {
    throw new AppHttpError(404, "Payment not found", "PAYMENT_MISSING");
  }
  if (payment.status === "PAID") {
    const entitlement = await getEntitlementForOrg(organizationId);
    if (!entitlement) throw new AppHttpError(404, "Subscription not found", "SUBSCRIPTION_MISSING");
    return entitlement;
  }
  if (payment.gatewayOrderId && payment.gatewayOrderId !== input.razorpayOrderId) {
    throw new AppHttpError(400, "Order mismatch for this payment", "ORDER_MISMATCH");
  }
  const ok = verifyRazorpayPaymentSignature({
    orderId: input.razorpayOrderId,
    paymentId: input.razorpayPaymentId,
    signature: input.razorpaySignature,
  });
  if (!ok) {
    throw new AppHttpError(400, "Invalid payment signature", "INVALID_SIGNATURE");
  }

  await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      gatewayOrderId: input.razorpayOrderId,
      gatewayPaymentId: input.razorpayPaymentId,
      gatewayProvider: "RAZORPAY",
      method: "RAZORPAY",
    },
  });

  return verifySubscriptionPayment(
    organizationId,
    {
      paymentId: payment.id,
      outcome: "PAID",
      txnReference: input.razorpayPaymentId,
      notes: "Paid via Razorpay Checkout",
    },
    actorLabel
  );
}

/**
 * Recover a Checkout / Payment Link that succeeded on Razorpay but never reached confirm
 * (webhook missed, modal dismissed, local env without public webhook URL).
 * Verifies capture status via Razorpay API — does not trust the client alone.
 */
export async function syncRazorpaySubscriptionPayment(
  organizationId: string,
  input: { paymentId: string; razorpayOrderId?: string; abandonIfUnpaid?: boolean },
  actorLabel: string
): Promise<EntitlementPayload> {
  const payment = await prisma.subscriptionPayment.findFirst({
    where: { id: input.paymentId, organizationId },
  });
  if (!payment) {
    throw new AppHttpError(404, "Payment not found", "PAYMENT_MISSING");
  }
  if (payment.status === "PAID" || payment.status === "FAILED") {
    const entitlement = await getEntitlementForOrg(organizationId);
    if (!entitlement) throw new AppHttpError(404, "Subscription not found", "SUBSCRIPTION_MISSING");
    return entitlement;
  }

  const gatewayId = input.razorpayOrderId?.trim() || payment.gatewayOrderId;
  if (!gatewayId) {
    throw new AppHttpError(400, "No Razorpay order on this payment", "ORDER_MISSING");
  }
  if (payment.gatewayOrderId && payment.gatewayOrderId !== gatewayId) {
    throw new AppHttpError(400, "Order mismatch for this payment", "ORDER_MISMATCH");
  }

  const gatewayOutcome = gatewayId.startsWith("plink_")
    ? await fetchRazorpayPaymentLinkOutcome(gatewayId)
    : await fetchRazorpayOrderPaymentOutcome(gatewayId);

  if (!gatewayOutcome || gatewayOutcome.outcome === "PENDING") {
    if (input.abandonIfUnpaid) {
      return verifySubscriptionPayment(
        organizationId,
        {
          paymentId: payment.id,
          outcome: "FAILED",
          txnReference: payment.txnReference,
          notes: "Auto-failed: Razorpay Checkout closed without a captured payment",
        },
        actorLabel
      );
    }
    throw new AppHttpError(402, "Payment not captured on Razorpay yet", "PAYMENT_NOT_CAPTURED");
  }

  if (gatewayOutcome.outcome === "FAILED") {
    return verifySubscriptionPayment(
      organizationId,
      {
        paymentId: payment.id,
        outcome: "FAILED",
        txnReference: gatewayOutcome.paymentId ?? payment.txnReference,
        notes: `Razorpay ${gatewayId.startsWith("plink_") ? "payment link" : "order"} ${gatewayOutcome.status}`,
      },
      actorLabel
    );
  }

  await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      gatewayOrderId: gatewayId,
      gatewayPaymentId: gatewayOutcome.paymentId,
      gatewayProvider: "RAZORPAY",
      method: gatewayId.startsWith("plink_") ? "RAZORPAY_LINK" : "RAZORPAY",
    },
  });

  return verifySubscriptionPayment(
    organizationId,
    {
      paymentId: payment.id,
      outcome: "PAID",
      txnReference: gatewayOutcome.paymentId,
      notes: gatewayId.startsWith("plink_")
        ? "Paid via Razorpay Payment Link (synced)"
        : "Paid via Razorpay (synced after Checkout)",
    },
    actorLabel
  );
}

/**
 * Best-effort: poll Razorpay for open PROCESSING/PENDING gateway payments and settle them.
 * Used when webhooks cannot reach local/dev, and as a safety net in production.
 */
/** Abandoned Checkout / unpaid link older than this is auto-FAILED on reconcile. */
const RAZORPAY_STALE_FAIL_MS = 15 * 60 * 1000;

export async function reconcileOpenRazorpayPayments(opts?: {
  limit?: number;
}): Promise<{ settled: number; checked: number }> {
  if (!isRazorpayEnabled()) return { settled: 0, checked: 0 };
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 50);

  const open = await prisma.subscriptionPayment.findMany({
    where: {
      status: { in: ["PROCESSING", "PENDING"] },
      gatewayOrderId: { not: null },
      OR: [
        { gatewayProvider: "RAZORPAY" },
        { method: { in: ["RAZORPAY", "RAZORPAY_LINK"] } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  let settled = 0;
  const now = Date.now();
  for (const payment of open) {
    const gatewayId = payment.gatewayOrderId?.trim();
    if (!gatewayId) continue;
    try {
      await syncRazorpaySubscriptionPayment(
        payment.organizationId,
        { paymentId: payment.id, razorpayOrderId: gatewayId },
        "razorpay-reconcile"
      );
      const refreshed = await prisma.subscriptionPayment.findUnique({
        where: { id: payment.id },
        select: { status: true },
      });
      if (refreshed && (refreshed.status === "PAID" || refreshed.status === "FAILED")) {
        settled += 1;
        continue;
      }

      // Still open on gateway: expire abandoned attempts so they leave "Needs review".
      const ageMs = now - payment.createdAt.getTime();
      if (ageMs >= RAZORPAY_STALE_FAIL_MS) {
        await verifySubscriptionPayment(
          payment.organizationId,
          {
            paymentId: payment.id,
            outcome: "FAILED",
            txnReference: payment.txnReference,
            notes: "Auto-failed: Razorpay payment not completed within 15 minutes",
          },
          "razorpay-reconcile"
        );
        settled += 1;
      }
    } catch {
      /* still open on gateway, or transient API error — leave for next pass */
      try {
        const ageMs = now - payment.createdAt.getTime();
        if (ageMs >= RAZORPAY_STALE_FAIL_MS) {
          const stillOpen = await prisma.subscriptionPayment.findUnique({
            where: { id: payment.id },
            select: { status: true },
          });
          if (
            stillOpen &&
            (stillOpen.status === "PROCESSING" || stillOpen.status === "PENDING")
          ) {
            await verifySubscriptionPayment(
              payment.organizationId,
              {
                paymentId: payment.id,
                outcome: "FAILED",
                txnReference: payment.txnReference,
                notes: "Auto-failed: Razorpay payment not completed within 15 minutes",
              },
              "razorpay-reconcile"
            );
            settled += 1;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  return { settled, checked: open.length };
}

async function findPaymentForRazorpayWebhook(input: {
  orderId?: string | null;
  paymentLinkId?: string | null;
  notesPaymentId?: string | null;
}) {
  return (
    (input.orderId
      ? await prisma.subscriptionPayment.findFirst({
          where: { gatewayOrderId: input.orderId },
        })
      : null) ??
    (input.paymentLinkId
      ? await prisma.subscriptionPayment.findFirst({
          where: { gatewayOrderId: input.paymentLinkId },
        })
      : null) ??
    (input.notesPaymentId
      ? await prisma.subscriptionPayment.findUnique({
          where: { id: input.notesPaymentId },
        })
      : null)
  );
}

/** Webhook helper: mark PAID by Razorpay order id or payment-link id. */
export async function settleRazorpayOrderFromWebhook(input: {
  orderId?: string | null;
  paymentId: string;
  paymentLinkId?: string | null;
  notesPaymentId?: string | null;
}): Promise<boolean> {
  const payment = await findPaymentForRazorpayWebhook(input);

  if (!payment) return false;
  if (payment.status === "PAID") return true;

  await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      gatewayPaymentId: input.paymentId,
      gatewayProvider: "RAZORPAY",
      method: input.paymentLinkId || payment.gatewayOrderId?.startsWith("plink_")
        ? "RAZORPAY_LINK"
        : "RAZORPAY",
      ...(input.orderId ? { gatewayOrderId: input.orderId } : {}),
    },
  });

  await verifySubscriptionPayment(
    payment.organizationId,
    {
      paymentId: payment.id,
      outcome: "PAID",
      txnReference: input.paymentId,
      notes: "Paid via Razorpay webhook",
    },
    "razorpay-webhook"
  );
  return true;
}

/** Webhook helper: mark FAILED for expired/cancelled links or failed payments. */
export async function markRazorpayPaymentFailedFromWebhook(input: {
  orderId?: string | null;
  paymentId?: string | null;
  paymentLinkId?: string | null;
  notesPaymentId?: string | null;
  reason?: string;
}): Promise<boolean> {
  const payment = await findPaymentForRazorpayWebhook(input);
  if (!payment) return false;
  if (payment.status === "PAID" || payment.status === "FAILED") return true;

  // payment.failed on a still-open payment link should not kill the attempt
  // (customer can retry). Only expire/cancel (or failed checkout order) settles FAILED.
  const reason = input.reason ?? "payment.failed";
  if (reason === "payment.failed" && payment.gatewayOrderId?.startsWith("plink_")) {
    return false;
  }

  await verifySubscriptionPayment(
    payment.organizationId,
    {
      paymentId: payment.id,
      outcome: "FAILED",
      txnReference: input.paymentId ?? payment.txnReference,
      notes: `Razorpay webhook: ${reason}`,
    },
    "razorpay-webhook"
  );
  return true;
}

export async function listSubscriptionPayments(organizationId: string): Promise<SubscriptionPaymentRow[]> {
  const rows = await prisma.subscriptionPayment.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(mapPayment);
}

export async function listSubscriptionBills(organizationId: string): Promise<SubscriptionBillRow[]> {
  const rows = await prisma.subscriptionBill.findMany({
    where: { organizationId },
    include: {
      payment: {
        select: {
          status: true,
          txnReference: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(mapBill);
}

export async function getSubscriptionBill(
  organizationId: string,
  billId: string
): Promise<SubscriptionBillRow & { organizationName: string } | null> {
  const bill = await prisma.subscriptionBill.findFirst({
    where: { id: billId, organizationId },
    include: {
      organization: { select: { name: true } },
      payment: {
        select: {
          status: true,
          txnReference: true,
        },
      },
    },
  });
  if (!bill) return null;
  return { ...mapBill(bill), organizationName: bill.organization.name };
}

export async function listSubscriptionRenewalHistory(
  organizationId: string
): Promise<SubscriptionRenewalHistoryRow[]> {
  const bills = await prisma.subscriptionBill.findMany({
    where: { organizationId },
    include: {
      payment: {
        select: {
          status: true,
          txnReference: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return bills.map((bill) => ({
    billId: bill.id,
    billNumber: bill.billNumber,
    previousExpiry: bill.periodStart.toISOString(),
    newExpiry: bill.periodEnd.toISOString(),
    termMonths: bill.termMonths,
    termLabel: bill.termLabel,
    amount: bill.totalAmount ?? bill.amount ?? 0,
    gstAmount: bill.gstAmount ?? 0,
    paymentStatus: bill.payment?.status ?? null,
    txnReference: bill.payment?.txnReference ?? null,
    renewalDate: bill.createdAt.toISOString(),
  }));
}

function mapPayment(p: {
  id: string;
  amount: number | null;
  currency: string;
  status: SubscriptionPaymentStatus;
  txnReference: string | null;
  method: string | null;
  notes: string | null;
  recordedBy: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  gatewayProvider?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
}): SubscriptionPaymentRow {
  return {
    id: p.id,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    txnReference: p.txnReference,
    method: p.method,
    notes: p.notes,
    recordedBy: p.recordedBy,
    verifiedAt: p.verifiedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    gatewayProvider: p.gatewayProvider ?? null,
    gatewayOrderId: p.gatewayOrderId ?? null,
    gatewayPaymentId: p.gatewayPaymentId ?? null,
  };
}

function mapBill(b: {
  id: string;
  billNumber: string;
  planName: string;
  termMonths: number;
  termLabel: string;
  periodStart: Date;
  periodEnd: Date;
  baseAmount: number | null;
  extraBranchCost: number | null;
  extraUserCost: number | null;
  extraBranches: number | null;
  extraUsers: number | null;
  onboardingFee: number | null;
  referralDiscount: number | null;
  gstPercent: number | null;
  gstAmount: number | null;
  totalAmount: number | null;
  payment?: {
    status: SubscriptionPaymentStatus;
    txnReference: string | null;
  } | null;
  amount: number | null;
  currency: string;
  createdAt: Date;
}): SubscriptionBillRow {
  return {
    id: b.id,
    billNumber: b.billNumber,
    planName: b.planName,
    termMonths: b.termMonths,
    termLabel: b.termLabel,
    periodStart: b.periodStart.toISOString(),
    periodEnd: b.periodEnd.toISOString(),
    baseAmount: b.baseAmount ?? 0,
    extraBranchCost: b.extraBranchCost ?? 0,
    extraUserCost: b.extraUserCost ?? 0,
    extraBranches: b.extraBranches ?? 0,
    extraUsers: b.extraUsers ?? 0,
    onboardingFee: b.onboardingFee ?? 0,
    referralDiscount: b.referralDiscount ?? 0,
    gstPercent: b.gstPercent ?? 0,
    gstAmount: b.gstAmount ?? 0,
    paymentStatus: b.payment?.status ?? null,
    txnReference: b.payment?.txnReference ?? null,
    amount: b.amount,
    totalAmount: b.totalAmount ?? b.amount ?? 0,
    currency: b.currency,
    createdAt: b.createdAt.toISOString(),
  };
}

async function nextBillNumber(organizationId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `SUB-${year}-`;
  const count = await prisma.subscriptionBill.count({
    where: { organizationId, billNumber: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

export type VerifyPaymentInput = {
  paymentId: string;
  outcome: "PAID" | "FAILED";
  txnReference?: string | null;
  amount?: number | null;
  notes?: string | null;
};

async function settleAddOnPayment(
  orgId: string,
  org: { id: string; name: string; slug: string | null; isActive: boolean },
  sub: OrganizationSubscription,
  payment: {
    id: string;
    notes: string | null;
    amount: number | null;
    currency: string;
    txnReference: string | null;
    status: string;
  },
  pricing: SubscriptionAddOnBreakdown,
  input: VerifyPaymentInput,
  actorLabel: string
): Promise<EntitlementPayload> {
  const now = new Date();
  const currentEnd = resolveExpiresAt(sub);
  const periodStart = now;
  const periodEnd = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  const txnRef = input.txnReference?.trim() || payment.txnReference || `ADDON-${Date.now()}`;
  const billNumber = await nextBillNumber(orgId);
  const finalAmount = pricing.finalAmount ?? input.amount ?? payment.amount ?? 0;
  const shouldNotifyOwner = payment.status !== "PAID";

  const nextBranchOverride =
    pricing.finalAllowedBranches === null
      ? null
      : pricing.finalAllowedBranches ?? sub.maxBranchesOverride;
  const nextUsersOverride =
    pricing.finalAllowedUsers === null
      ? null
      : pricing.finalAllowedUsers ?? sub.maxUsersOverride;

  let addOnBillId: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          txnReference: txnRef,
          notes: input.notes ?? payment.notes,
          amount: input.amount ?? payment.amount,
          verifiedAt: now,
          recordedBy: actorLabel,
        },
      });

      await tx.organizationSubscription.update({
        where: { organizationId: orgId },
        data: {
          paymentStatus: "PAID",
          lastPaymentTxnId: txnRef,
          status: "ACTIVE",
          maxBranchesOverride: nextBranchOverride,
          maxUsersOverride: nextUsersOverride,
          // Keep existing startsAt / expiresAt / termMonths / plan.
        },
      });

      await tx.organization.update({
        where: { id: orgId },
        data: { isActive: true },
      });

      const bill = await tx.subscriptionBill.create({
        data: {
          organizationId: orgId,
          subscriptionId: sub.id,
          paymentId: payment.id,
          billNumber,
          planName: sub.planName,
          termMonths: sub.termMonths,
          termLabel: "Add-on",
          periodStart,
          periodEnd,
          baseAmount: 0,
          extraBranchCost: pricing.extraBranchCost,
          extraUserCost: pricing.extraUserCost,
          extraBranches: pricing.extraBranches,
          extraUsers: pricing.extraUsers,
          onboardingFee: 0,
          referralDiscount: 0,
          gstPercent: pricing.gstPercent,
          gstAmount: pricing.gstAmount,
          totalAmount: finalAmount,
          amount: finalAmount,
          currency: payment.currency,
        },
      });
      addOnBillId = bill.id;

      await tx.platformAuditLog.create({
        data: {
          organizationId: orgId,
          actor: actorLabel,
          action: "subscription.addon_verified",
          before: {
            maxBranchesOverride: sub.maxBranchesOverride,
            maxUsersOverride: sub.maxUsersOverride,
            paymentStatus: sub.paymentStatus,
            expiresAt: currentEnd?.toISOString() ?? null,
          },
          after: {
            maxBranchesOverride: nextBranchOverride,
            maxUsersOverride: nextUsersOverride,
            paymentStatus: "PAID",
            billNumber,
            txnReference: txnRef,
            finalAmount,
            extraBranches: pricing.extraBranches,
            extraUsers: pricing.extraUsers,
            expiresAt: currentEnd?.toISOString() ?? null,
          },
        },
      });
    });

    const usage = await usageForOrg(orgId);
    const [updatedOrg, updated] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
      prisma.organizationSubscription.findUniqueOrThrow({
        where: { organizationId: orgId },
      }),
    ]);
    if (shouldNotifyOwner) {
      void notifyOwnerPlanActivated({
        organizationId: orgId,
        organizationName: org.name,
        planName: sub.planName,
        termLabel: "Add-on",
        amount: finalAmount,
        expiresAt: periodEnd,
        kind: "addon",
        extraBranches: pricing.extraBranches,
        extraUsers: pricing.extraUsers,
        billNumber,
        billId: addOnBillId,
      }).catch((err) => {
        console.warn(
          "[addon-activated-notify]",
          err instanceof Error ? err.message : err
        );
      });
    }
  const refereeWallet = await prisma.referralWallet.findUnique({
    where: { organizationId: orgId },
    select: { points: true },
  });
  return toEntitlement(
    {
      ...updatedOrg,
      referralWalletPoints: refereeWallet?.points ?? 0,
    },
    updated,
    usage.branchesUsed,
    usage.usersUsed
  );
}

/**
 * Admin verifies a renew or mid-cycle add-on payment.
 * Renew: extends expiresAt by termMonths and creates a bill.
 * Add-on: raises capacity overrides only; keeps the current expiry.
 */
export async function verifySubscriptionPayment(
  orgId: string,
  input: VerifyPaymentInput,
  actorLabel: string
): Promise<EntitlementPayload> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: { subscription: true },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Organization not found", "ORG_NOT_FOUND");
  }

  const payment = await prisma.subscriptionPayment.findFirst({
    where: { id: input.paymentId, organizationId: orgId },
  });
  if (!payment) {
    throw new AppHttpError(404, "Payment not found", "PAYMENT_NOT_FOUND");
  }

  const sub = org.subscription;
  const pricing = parsePricingFromNotes(payment.notes);

  if (input.outcome === "FAILED") {
    const isAddOn = isAddOnBreakdown(pricing);
    await prisma.$transaction([
      prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          txnReference: input.txnReference ?? payment.txnReference,
          notes: input.notes ?? payment.notes,
          amount: input.amount ?? payment.amount,
          verifiedAt: new Date(),
          recordedBy: actorLabel,
        },
      }),
      // Mid-cycle add-ons must not flip a healthy PAID subscription to FAILED.
      ...(isAddOn
        ? []
        : [
            prisma.organizationSubscription.update({
              where: { organizationId: orgId },
              data: { paymentStatus: "FAILED" },
            }),
          ]),
      prisma.platformAuditLog.create({
        data: {
          organizationId: orgId,
          actor: actorLabel,
          action: isAddOn ? "subscription.addon_failed" : "subscription.payment_failed",
          before: { paymentId: payment.id, status: payment.status },
          after: { status: "FAILED" },
        },
      }),
    ]);
    const usage = await usageForOrg(orgId);
    const updated = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    return toEntitlement(org, updated, usage.branchesUsed, usage.usersUsed);
  }

  // Debit wallet before marking paid so a short balance cannot settle free capacity.
  if (payment.status !== "PAID") {
    try {
      await redeemWalletPointsForPaidSubscription({
        organizationId: orgId,
        paymentId: payment.id,
        breakdown: pricing,
      });
    } catch (err) {
      throw new AppHttpError(
        400,
        err instanceof Error ? err.message : "Could not redeem wallet points",
        "WALLET_REDEEM_FAILED"
      );
    }
  }

  if (isAddOnBreakdown(pricing)) {
    return settleAddOnPayment(orgId, org, sub, payment, pricing, input, actorLabel);
  }

  const renewPricing = pricing as SubscriptionPricingBreakdown | null;
  const termMonths = normalizeTermMonths(renewPricing?.termMonths ?? sub.termMonths);
  const now = new Date();
  const currentEnd = resolveExpiresAt(sub);
  const periodStart = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  const periodEnd = addMonths(periodStart, termMonths);
  const txnRef = input.txnReference?.trim() || payment.txnReference || `MANUAL-${Date.now()}`;
  const billNumber = await nextBillNumber(orgId);
  const termLabel = termLabelFromMonths(termMonths);

  let nextPlanCode = sub.planCode;
  let nextPlanName = sub.planName;
  let nextLimits = normalizedLimitsForSubscription(sub);
  if (renewPricing?.planCode) {
    const template = await getPlanTemplate(renewPricing.planCode);
    if (template) {
      nextPlanCode = template.planCode;
      nextPlanName = template.planName;
      nextLimits = template.limits;
    }
  }

  const nextBranchOverride =
    renewPricing?.finalAllowedBranches === null
      ? null
      : renewPricing?.finalAllowedBranches ?? sub.maxBranchesOverride;
  /**
   * Same "absolute overwrite" semantics as `maxBranchesOverride`: each renewal's
   * effective user cap is the base plan allowance + that renewal's extraUsers,
   * not additive across renewals — avoids double-counting after multiple renewals.
   */
  const nextUsersOverride =
    renewPricing?.finalAllowedUsers === null
      ? null
      : renewPricing?.finalAllowedUsers ?? sub.maxUsersOverride;
  const finalAmount = renewPricing?.finalAmount ?? input.amount ?? payment.amount ?? 0;
  const shouldNotifyOwner = payment.status !== "PAID";
  const notifyKind: "upgrade" | "renewal" = sub.status === "TRIAL" ? "upgrade" : "renewal";

  let verifiedBillId: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.subscriptionPayment.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        txnReference: txnRef,
        notes: input.notes ?? payment.notes,
        amount: input.amount ?? payment.amount,
        verifiedAt: now,
        recordedBy: actorLabel,
      },
    });

    await tx.organizationSubscription.update({
      where: { organizationId: orgId },
      data: {
        paymentStatus: "PAID",
        lastPaymentTxnId: txnRef,
        status: "ACTIVE",
        planCode: nextPlanCode,
        planName: nextPlanName,
        limits: asLimitsJson(nextLimits),
        maxBranchesOverride: nextBranchOverride,
        maxUsersOverride: nextUsersOverride,
        startsAt: sub.startsAt ?? periodStart,
        expiresAt: periodEnd,
        currentPeriodEnd: periodEnd,
        termMonths,
      },
    });

    // Accepting payment reactivates workshop access (no separate Restore needed).
    await tx.organization.update({
      where: { id: orgId },
      data: { isActive: true },
    });

    const bill = await tx.subscriptionBill.create({
      data: {
        organizationId: orgId,
        subscriptionId: sub.id,
        paymentId: payment.id,
        billNumber,
        planName: sub.planName,
        termMonths,
        termLabel,
        periodStart,
        periodEnd,
        baseAmount: renewPricing?.baseAmount ?? finalAmount,
        extraBranchCost: renewPricing?.extraBranchCost ?? 0,
        extraUserCost: renewPricing?.extraUserCost ?? 0,
        extraBranches: renewPricing?.extraBranches ?? 0,
        extraUsers: renewPricing?.extraUsers ?? 0,
        onboardingFee: renewPricing?.onboardingFee ?? 0,
        referralDiscount: renewPricing?.referralDiscount ?? 0,
        gstPercent: renewPricing?.gstPercent ?? 0,
        gstAmount: renewPricing?.gstAmount ?? 0,
        totalAmount: finalAmount,
        amount: finalAmount,
        currency: payment.currency,
      },
    });
    verifiedBillId = bill.id;

    await tx.platformAuditLog.create({
      data: {
        organizationId: orgId,
        actor: actorLabel,
        action: "subscription.payment_verified",
        before: {
          expiresAt: currentEnd?.toISOString() ?? null,
          paymentStatus: sub.paymentStatus,
          isActive: org.isActive,
        },
        after: {
          expiresAt: periodEnd.toISOString(),
          paymentStatus: "PAID",
          billNumber,
          txnReference: txnRef,
          termMonths,
          finalAmount,
          isActive: true,
        },
      },
    });
  });

  const usage = await usageForOrg(orgId);
  const [updatedOrg, updated] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    }),
  ]);
  const shareReferralCode = await ensureOrgShareReferralCode(orgId);
  const paidCount = await prisma.subscriptionPayment.count({
    where: { organizationId: orgId, status: "PAID" },
  });
  // First paid conversion only — covers Razorpay quote notes and admin mark-paid.
  if (paidCount === 1 && !(renewPricing && isAddOnBreakdown(renewPricing))) {
    try {
      const signupReferral = await inheritedSignupReferralCode(orgId);
      await creditReferrerWalletForPaidSubscription({
        refereeOrganizationId: orgId,
        paymentId: payment.id,
        breakdown: renewPricing && !isAddOnBreakdown(renewPricing) ? renewPricing : null,
        referralCodeFallback: signupReferral,
      });
    } catch (err) {
      console.warn("[referral-wallet]", err instanceof Error ? err.message : err);
    }
  }
  const refereeWallet = await prisma.referralWallet.findUnique({
    where: { organizationId: orgId },
    select: { points: true },
  });
  if (shouldNotifyOwner) {
    void notifyOwnerPlanActivated({
      organizationId: orgId,
      organizationName: org.name,
      planName: nextPlanName,
      termLabel,
      amount: finalAmount,
      expiresAt: periodEnd,
      kind: notifyKind,
      billNumber,
      billId: verifiedBillId,
    }).catch((err) => {
      console.warn(
        "[plan-activated-notify]",
        err instanceof Error ? err.message : err
      );
    });
  }
  return toEntitlement(
    {
      ...updatedOrg,
      shareReferralCode,
      referralWalletPoints: refereeWallet?.points ?? 0,
    },
    updated,
    usage.branchesUsed,
    usage.usersUsed
  );
}

/**
 * Admin shortcut: mark a subscription paid.
 *
 * Reuses the most recent open renewal payment (PENDING first, then PROCESSING)
 * when one exists, so its pricing breakdown — extraBranches/extraUsers/termMonths —
 * carries through to verification and correctly raises
 * `maxBranchesOverride`/`maxUsersOverride`. Previously this always created a
 * brand-new context-less payment, which silently discarded any extras purchased
 * in the renewal request (bug). Also reuses orphan PROCESSING rows left by a
 * prior mid-flight mark-paid instead of stacking another payment.
 * Falls back to creating a fresh payment when there's no open renewal
 * (e.g. an ad-hoc admin "mark paid" without a prior renewal request).
 */
export async function adminMarkSubscriptionPaid(
  orgId: string,
  actorLabel: string,
  opts?: {
    txnReference?: string | null;
    amount?: number | null;
    termMonths?: number;
    notes?: string | null;
  }
): Promise<EntitlementPayload> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: { subscription: true },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Organization not found", "ORG_NOT_FOUND");
  }

  const pendingPayment = await prisma.subscriptionPayment.findFirst({
    where: { organizationId: orgId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  const processingPayment = !pendingPayment
    ? await prisma.subscriptionPayment.findFirst({
        where: { organizationId: orgId, status: "PROCESSING" },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const openPayment = pendingPayment ?? processingPayment;

  const paymentId = openPayment
    ? openPayment.id
    : (
        await prisma.subscriptionPayment.create({
          data: {
            organizationId: orgId,
            subscriptionId: org.subscription.id,
            status: "PROCESSING",
            method: "ADMIN",
            notes: opts?.notes ?? "Marked paid by platform admin",
            amount: opts?.amount ?? null,
            recordedBy: actorLabel,
          },
        })
      ).id;

  if (opts?.termMonths) {
    await prisma.organizationSubscription.update({
      where: { organizationId: orgId },
      data: { termMonths: normalizeTermMonths(opts.termMonths) },
    });
  }

  return verifySubscriptionPayment(
    orgId,
    {
      paymentId,
      outcome: "PAID",
      txnReference: opts?.txnReference,
      amount: opts?.amount,
      notes: opts?.notes,
    },
    actorLabel
  );
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function applyAdminDiscount(
  breakdown: SubscriptionPricingBreakdown,
  discountType: "NONE" | "FLAT" | "PERCENTAGE" | "CODE",
  discountValue: number
): SubscriptionPricingBreakdown {
  if (discountType === "NONE" || discountType === "CODE") return breakdown;
  const pre =
    breakdown.baseAmount +
    breakdown.extraBranchCost +
    breakdown.extraUserCost +
    breakdown.onboardingFee;
  let disc = 0;
  if (discountType === "FLAT") disc = Math.min(pre, Math.max(0, discountValue));
  if (discountType === "PERCENTAGE") {
    disc = Math.min(pre, (pre * Math.min(100, Math.max(0, discountValue))) / 100);
  }
  disc = roundMoney(disc);
  const taxable = Math.max(0, roundMoney(pre - disc));
  const gstAmount = roundMoney((taxable * breakdown.gstPercent) / 100);
  return {
    ...breakdown,
    referralCode: null,
    referralDiscount: disc,
    referralApplied: disc > 0,
    referralEligible: disc > 0,
    referralValidationMessage: null,
    referrerOrganizationId: null,
    walletPointsApplied: 0,
    walletPointsDiscount: 0,
    subTotalBeforeTax: taxable,
    gstAmount,
    finalAmount: roundMoney(taxable + gstAmount),
  };
}

export type AdminPaymentLinkResult = {
  paymentId: string;
  billId: string | null;
  paymentLinkUrl: string;
  amount: number;
  currency: string;
  expiresAt: string | null;
  gateway: string;
  sentVia: Array<"email" | "sms" | "whatsapp">;
};

/** Platform admin: create Razorpay Payment Link and notify owner. */
export async function createAdminPaymentLink(
  organizationId: string,
  actorLabel: string,
  input: {
    planCode: string;
    termMonths: 1 | 3 | 12 | 24 | 36 | 60;
    extraBranches?: number;
    extraUsers?: number;
    referralCode?: string | null;
    discountType?: "NONE" | "FLAT" | "PERCENTAGE" | "CODE";
    discountValue?: number | null;
    notes?: string | null;
    sendVia?: Array<"email" | "sms" | "whatsapp">;
    customerEmail?: string | null;
    customerPhone?: string | null;
  }
): Promise<AdminPaymentLinkResult> {
  if (!isRazorpayEnabled()) {
    throw new AppHttpError(
      503,
      "Online payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the API.",
      "GATEWAY_DISABLED"
    );
  }

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      subscription: true,
      users: {
        where: { role: { in: ["SUPER_ADMIN", "ADMIN"] } },
        take: 1,
        orderBy: { id: "asc" },
        select: { name: true, email: true, phone: true },
      },
    },
  });
  if (!org?.subscription) {
    throw new AppHttpError(404, "Organization or subscription not found", "ORG_NOT_FOUND");
  }

  const discountType = input.discountType ?? "NONE";
  const referralCode =
    discountType === "CODE" ? input.referralCode?.trim() || null : null;

  const quote = await getSubscriptionPricingQuote(organizationId, {
    planCode: input.planCode,
    termMonths: input.termMonths,
    extraBranches: Math.max(0, Math.floor(input.extraBranches ?? 0)),
    extraUsers: Math.max(0, Math.floor(input.extraUsers ?? 0)),
    referralCode,
  });
  if (discountType === "CODE" && quote.breakdown.referralValidationMessage) {
    throw new AppHttpError(400, quote.breakdown.referralValidationMessage, "INVALID_REFERRAL");
  }

  const breakdown = applyAdminDiscount(
    quote.breakdown,
    discountType,
    Number(input.discountValue) || 0
  );

  if (!(breakdown.finalAmount > 0)) {
    throw new AppHttpError(400, "Payable amount must be greater than zero", "INVALID_AMOUNT");
  }

  const owner = org.users[0];
  const customerEmail = input.customerEmail?.trim() || owner?.email || null;
  const customerPhone = input.customerPhone?.trim() || owner?.phone || null;
  const customerName = owner?.name || org.name;

  let payment = await prisma.subscriptionPayment.create({
    data: {
      organizationId,
      subscriptionId: org.subscription.id,
      status: "PROCESSING",
      amount: breakdown.finalAmount,
      currency: breakdown.currency,
      method: "RAZORPAY_LINK",
      gatewayProvider: "RAZORPAY",
      notes: pricingNotes(
        `Admin payment link${input.notes?.trim() ? ` — ${input.notes.trim()}` : ""}`,
        breakdown
      ),
      recordedBy: actorLabel,
    },
  });

  let link: Awaited<ReturnType<typeof createRazorpayPaymentLink>>;
  try {
    link = await createRazorpayPaymentLink({
      amountInr: breakdown.finalAmount,
      currency: breakdown.currency,
      description: `${breakdown.planName} · ${breakdown.termLabel} · ${org.name}`,
      referenceId: payment.id,
      customer: {
        name: customerName,
        email: customerEmail ?? undefined,
        contact: customerPhone ?? undefined,
      },
      notes: {
        organizationId,
        paymentId: payment.id,
        planCode: breakdown.planCode,
        source: "admin_payment_link",
      },
      notify: {
        email: Boolean(input.sendVia?.includes("email") && customerEmail),
        sms: Boolean(input.sendVia?.includes("sms") && customerPhone),
      },
      callbackUrl: `${env.FRONTEND_ORIGIN.replace(/\/$/, "")}/settings/billing`,
    });
  } catch (err) {
    await prisma.subscriptionPayment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        notes: `${payment.notes ?? ""}\nLINK_CREATE_FAILED: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      },
    });
    throw new AppHttpError(
      502,
      err instanceof Error ? err.message : "Failed to create Razorpay payment link",
      "GATEWAY_ERROR"
    );
  }

  payment = await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      gatewayOrderId: link.id,
      notes: `${payment.notes ?? ""}\nPAYMENT_LINK_URL:${link.shortUrl}`,
    },
  });

  await prisma.organizationSubscription.update({
    where: { organizationId },
    data: {
      paymentStatus: "PROCESSING",
      planCode: breakdown.planCode,
      planName: breakdown.planName,
      termMonths: breakdown.termMonths,
    },
  });

  await prisma.platformAuditLog.create({
    data: {
      organizationId,
      actor: actorLabel,
      action: "subscription.payment_link_created",
      after: {
        paymentId: payment.id,
        amount: breakdown.finalAmount,
        paymentLinkId: link.id,
        planCode: breakdown.planCode,
        termMonths: breakdown.termMonths,
        discountType,
      },
    },
  });

  const sendVia = input.sendVia ?? [];
  const sentVia: Array<"email" | "sms" | "whatsapp"> = [];
  const msg = `MY DETAIL OS — payment link for ${org.name}\nAmount: ₹${breakdown.finalAmount.toFixed(2)}\nPay here: ${link.shortUrl}`;
  const waMsg = buildOwnerPaymentLinkWhatsAppMessage({
    ownerName: customerName,
    organizationName: org.name,
    amount: breakdown.finalAmount,
    paymentLinkUrl: link.shortUrl,
  });

  for (const channel of sendVia) {
    try {
      if (channel === "email" && customerEmail && isResendConfigured()) {
        await sendViaResend({
          to: [customerEmail],
          subject: `Payment link — ${org.name} · MY DETAIL OS`,
          html: `<p>Hi,</p><p>Please complete your MY DETAIL OS subscription payment:</p><p><strong>₹${breakdown.finalAmount.toFixed(2)}</strong></p><p><a href="${link.shortUrl}">Pay now</a></p><p>${link.shortUrl}</p>`,
          text: msg,
        });
        sentVia.push("email");
      } else if (channel === "sms" && customerPhone && isTwilioSmsEnabled()) {
        await sendTransactionalSms(normalizePhoneToE164(customerPhone), msg);
        sentVia.push("sms");
      } else if (channel === "whatsapp" && customerPhone && isTwilioWhatsAppEnabled()) {
        await sendWhatsAppMessage(
          customerPhone,
          whatsappTemplateOrBody(
            env.TWILIO_OWNER_PAYMENT_LINK_TEMPLATE_SID,
            ownerPaymentLinkTemplateVariables({
              ownerName: customerName,
              organizationName: org.name,
              amount: breakdown.finalAmount,
              paymentLinkUrl: link.shortUrl,
            }),
            waMsg
          )
        );
        sentVia.push("whatsapp");
      }
    } catch {
      /* channel failure should not block link creation */
    }
  }

  return {
    paymentId: payment.id,
    billId: null,
    paymentLinkUrl: link.shortUrl,
    amount: breakdown.finalAmount,
    currency: breakdown.currency,
    expiresAt: null,
    gateway: "RAZORPAY",
    sentVia,
  };
}

export async function resendAdminPaymentLink(
  organizationId: string,
  paymentId: string,
  medium: "email" | "sms" | "whatsapp",
  actorLabel: string
): Promise<{ ok: boolean; paymentLinkUrl: string }> {
  const payment = await prisma.subscriptionPayment.findFirst({
    where: { id: paymentId, organizationId },
    include: {
      organization: {
        include: {
          users: {
            where: { role: { in: ["SUPER_ADMIN", "ADMIN"] } },
            take: 1,
            orderBy: { id: "asc" },
            select: { name: true, email: true, phone: true },
          },
        },
      },
    },
  });
  if (!payment) {
    throw new AppHttpError(404, "Payment not found", "PAYMENT_NOT_FOUND");
  }

  const urlMatch = payment.notes?.match(/PAYMENT_LINK_URL:(https?:\/\/\S+)/);
  const paymentLinkUrl = urlMatch?.[1];
  if (!paymentLinkUrl || !payment.gatewayOrderId?.startsWith("plink_")) {
    throw new AppHttpError(400, "No payment link on this payment", "PAYMENT_LINK_MISSING");
  }

  const owner = payment.organization.users[0];
  const msg = `MY DETAIL OS — payment link\nAmount: ₹${Number(payment.amount ?? 0).toFixed(2)}\nPay here: ${paymentLinkUrl}`;
  const waMsg = buildOwnerPaymentLinkWhatsAppMessage({
    ownerName: owner?.name,
    organizationName: payment.organization.name,
    amount: Number(payment.amount ?? 0),
    paymentLinkUrl,
  });

  if (medium === "email") {
    const email = owner?.email;
    if (!email) throw new AppHttpError(400, "Owner email missing", "EMAIL_MISSING");
    if (isResendConfigured()) {
      await sendViaResend({
        to: [email],
        subject: "Payment link — MY DETAIL OS",
        html: `<p><a href="${paymentLinkUrl}">Pay now</a></p><p>${paymentLinkUrl}</p>`,
        text: msg,
      });
    } else {
      await notifyRazorpayPaymentLink(payment.gatewayOrderId, "email");
    }
  } else if (medium === "sms") {
    const phone = owner?.phone;
    if (!phone) throw new AppHttpError(400, "Owner phone missing", "PHONE_MISSING");
    if (isTwilioSmsEnabled()) {
      await sendTransactionalSms(normalizePhoneToE164(phone), msg);
    } else {
      await notifyRazorpayPaymentLink(payment.gatewayOrderId, "sms");
    }
  } else {
    const phone = owner?.phone;
    if (!phone) throw new AppHttpError(400, "Owner phone missing", "PHONE_MISSING");
    if (!isTwilioWhatsAppEnabled()) {
      throw new AppHttpError(503, "WhatsApp is not configured", "WHATSAPP_NOT_CONFIGURED");
    }
    await sendWhatsAppMessage(
      phone,
      whatsappTemplateOrBody(
        env.TWILIO_OWNER_PAYMENT_LINK_TEMPLATE_SID,
        ownerPaymentLinkTemplateVariables({
          ownerName: owner?.name,
          organizationName: payment.organization.name,
          amount: Number(payment.amount ?? 0),
          paymentLinkUrl,
        }),
        waMsg
      )
    );
  }

  await prisma.platformAuditLog.create({
    data: {
      organizationId,
      actor: actorLabel,
      action: "subscription.payment_link_resent",
      after: { paymentId, medium },
    },
  });

  return { ok: true, paymentLinkUrl };
}

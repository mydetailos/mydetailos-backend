/**
 * Single organization provisioning path used by:
 * - Public website trial signup (POST /api/public/signup)
 * - Platform admin (POST /api/platform/organizations/provision)
 *
 * Creates: Organization + HQ Branch + SUPER_ADMIN owner + TRIAL subscription.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { Branch, Organization, OrganizationSubscription, User } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppHttpError } from "../../lib/app-http-error.js";
import { validateStrongPassword } from "../../lib/password-policy.js";
import { getPlatformSettings, getPlanTemplate } from "../../lib/platform-settings.js";
import { writePlatformAuditLog } from "../../lib/platform-audit.js";
import { signAuthToken } from "../auth/auth.service.js";
import { asLimitsJson } from "./organization-subscription.service.js";
import { addMonths } from "../../lib/subscription-lock.js";
import { ensureNonReservedSlug } from "../../lib/reserved-slugs.js";
import { ensureOrgShareReferralCode } from "./org-share-referral.service.js";
import { notifyOwnerTrialStarted, type OwnerTrialNotifyResult } from "./owner-trial-notify.service.js";

export type ProvisionOrganizationInput = {
  businessName: string;
  ownerName: string;
  email: string;
  phone: string;
  password: string;
  branchName?: string;
  planCode?: string;
  referralCode?: string | null;
  source?: string;
  /** Who triggered provisioning (for audit). */
  actor: string;
  /** Override trial length; defaults to platform settings.trialDaysDefault. */
  trialDays?: number;
};

export type ProvisionOrganizationResult = {
  organizationId: string;
  organization: Pick<Organization, "id" | "name" | "slug" | "isActive" | "createdAt">;
  branch: Pick<Branch, "id" | "name" | "organizationId">;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    role: User["role"];
    branchId: string;
    organizationId: string;
    mustChangePassword?: true;
    permissions: string[];
  };
  subscription: {
    id: string;
    planCode: string;
    planName: string;
    status: OrganizationSubscription["status"];
    startsAt: string | null;
    expiresAt: string | null;
    termMonths: number;
  };
  accessToken: string;
  notified: OwnerTrialNotifyResult;
};

function shortId(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (trimmed.startsWith("+")) return trimmed;
  if (digits.length > 10) return `+${digits}`;
  return trimmed;
}

function toAuthUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    branchId: user.branchId,
    organizationId: user.organizationId,
    permissions: user.permissions || [],
    ...(user.mustChangePassword === true ? { mustChangePassword: true as const } : {}),
  };
}

export async function provisionOrganization(
  input: ProvisionOrganizationInput
): Promise<ProvisionOrganizationResult> {
  const businessName = input.businessName.trim();
  const ownerName = input.ownerName.trim();
  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  const password = input.password;
  const branchName = (input.branchName?.trim() || "HQ").slice(0, 120);

  if (!businessName) {
    throw new AppHttpError(400, "Business name is required.", "VALIDATION_ERROR");
  }
  if (!ownerName) {
    throw new AppHttpError(400, "Owner name is required.", "VALIDATION_ERROR");
  }
  if (!email || !email.includes("@")) {
    throw new AppHttpError(400, "A valid email is required.", "VALIDATION_ERROR");
  }
  if (phone.replace(/\D/g, "").length < 10) {
    throw new AppHttpError(400, "A valid phone number is required.", "VALIDATION_ERROR");
  }

  const passwordError = validateStrongPassword(password);
  if (passwordError) {
    throw new AppHttpError(400, passwordError, "WEAK_PASSWORD");
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    throw new AppHttpError(409, "An account with this email already exists.", "EMAIL_EXISTS");
  }

  const settings = await getPlatformSettings();
  const planCode = (input.planCode?.trim().toUpperCase().replace(/[\s-]+/g, "_") || "STARTER");
  const plan = await getPlanTemplate(planCode);
  if (!plan) {
    throw new AppHttpError(400, `Plan "${planCode}" is not available.`, "PLAN_NOT_FOUND");
  }

  const trialDays = Math.min(
    90,
    Math.max(1, Math.floor(input.trialDays ?? settings.trialDaysDefault ?? 14))
  );
  const now = new Date();
  const expiresAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

  let orgId = `org-${shortId()}`;
  while (await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } })) {
    orgId = `org-${shortId()}`;
  }
  let branchId = `br-${shortId()}`;
  while (await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true } })) {
    branchId = `br-${shortId()}`;
  }
  let userId = `usr-${shortId()}`;
  while (await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) {
    userId = `usr-${shortId()}`;
  }
  let subId = `sub-${shortId()}`;
  while (await prisma.organizationSubscription.findUnique({ where: { id: subId }, select: { id: true } })) {
    subId = `sub-${shortId()}`;
  }

  let slug = ensureNonReservedSlug(businessName);
  const slugTaken = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (slugTaken) {
    slug = ensureNonReservedSlug(`${slug}-${shortId().slice(-6)}`);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const limits = plan.limits;

  const result = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        id: orgId,
        name: businessName,
        slug,
        isActive: true,
        activatedAt: now,
      },
    });

    const branch = await tx.branch.create({
      data: {
        id: branchId,
        name: branchName,
        address: "",
        phone,
        isActive: true,
        code: "HQ",
        organizationId: orgId,
        createdByUserId: userId,
      },
    });

    const user = await tx.user.create({
      data: {
        id: userId,
        name: ownerName,
        email,
        phone,
        role: "SUPER_ADMIN",
        branchId,
        organizationId: orgId,
        passwordHash,
        mustChangePassword: false,
        passwordUpdatedAt: now,
        isActive: true,
        emailVerified: false,
        permissions: [],
      },
    });

    const subscription = await tx.organizationSubscription.create({
      data: {
        id: subId,
        organizationId: orgId,
        planCode: plan.planCode,
        planName: plan.planName,
        status: "TRIAL",
        limits: asLimitsJson(limits),
        termMonths: 0,
        startsAt: now,
        expiresAt,
        currentPeriodEnd: expiresAt,
        paymentStatus: "PENDING",
        contactUsUrl: settings.defaultContactUsUrl,
        contactPhone: settings.defaultContactPhone,
        upgradeUrl: settings.defaultUpgradeUrl,
      },
    });

    return { organization, branch, user, subscription };
  });

  const notified = await notifyOwnerTrialStarted({
    ownerName,
    email,
    phone,
    temporaryPassword: password,
    trialDays,
  });

  await writePlatformAuditLog({
    organizationId: orgId,
    actor: input.actor,
    action: "organization.provisioned",
    after: {
      organizationId: orgId,
      name: businessName,
      slug,
      planCode: plan.planCode,
      status: "TRIAL",
      trialDays,
      expiresAt: expiresAt.toISOString(),
      ownerUserId: userId,
      branchId,
      source: input.source ?? "provision",
      referralCode: input.referralCode ?? null,
      notified,
    },
  });

  const accessToken = signAuthToken({
    id: result.user.id,
    email: result.user.email,
    role: result.user.role,
    branchId: result.user.branchId,
    organizationId: result.user.organizationId,
    name: result.user.name,
    mustChangePassword: false,
    permissions: result.user.permissions || [],
  });

  return {
    organizationId: orgId,
    organization: {
      id: result.organization.id,
      name: result.organization.name,
      slug: result.organization.slug,
      isActive: result.organization.isActive,
      createdAt: result.organization.createdAt,
    },
    branch: {
      id: result.branch.id,
      name: result.branch.name,
      organizationId: result.branch.organizationId,
    },
    user: toAuthUser(result.user),
    subscription: {
      id: result.subscription.id,
      planCode: result.subscription.planCode,
      planName: result.subscription.planName,
      status: result.subscription.status,
      startsAt: result.subscription.startsAt?.toISOString() ?? null,
      expiresAt: result.subscription.expiresAt?.toISOString() ?? null,
      termMonths: result.subscription.termMonths,
    },
    accessToken,
    notified,
  };
}

export type ConvertTrialInput = {
  organizationId: string;
  actor: string;
  termMonths?: number;
  planCode?: string;
  /** When true, marks subscription ACTIVE + PAID without a gateway. Manual admin conversion. */
  markPaid?: boolean;
  notes?: string;
};

/**
 * Convert a TRIAL subscription to a paid term.
 * Does NOT fake a payment gateway — defaults to PENDING unless markPaid is set by platform admin.
 */
export async function convertTrialSubscription(
  input: ConvertTrialInput
): Promise<{
  organizationId: string;
  subscription: {
    id: string;
    planCode: string;
    planName: string;
    status: OrganizationSubscription["status"];
    paymentStatus: OrganizationSubscription["paymentStatus"];
    termMonths: number;
    startsAt: string | null;
    expiresAt: string | null;
  };
}> {
  const orgId = input.organizationId;
  const sub = await prisma.organizationSubscription.findUnique({
    where: { organizationId: orgId },
  });
  if (!sub) {
    throw new AppHttpError(404, "Subscription not found.", "SUBSCRIPTION_MISSING");
  }
  if (sub.status !== "TRIAL") {
    throw new AppHttpError(
      409,
      `Subscription is ${sub.status}, not TRIAL.`,
      "NOT_ON_TRIAL"
    );
  }

  const settings = await getPlatformSettings();
  const termMonths = [1, 3, 12, 24, 36, 60].includes(input.termMonths ?? NaN)
    ? (input.termMonths as number)
    : settings.defaultTermMonths ?? 12;

  const planCode = input.planCode
    ? input.planCode.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : sub.planCode;
  const plan = await getPlanTemplate(planCode);
  if (!plan) {
    throw new AppHttpError(400, `Plan "${planCode}" is not available.`, "PLAN_NOT_FOUND");
  }

  const now = new Date();
  const expiresAt = addMonths(now, termMonths);

  const markPaid = input.markPaid === true;
  const before = {
    status: sub.status,
    planCode: sub.planCode,
    paymentStatus: sub.paymentStatus,
    expiresAt: sub.expiresAt?.toISOString() ?? null,
  };

  const updated = await prisma.organizationSubscription.update({
    where: { organizationId: orgId },
    data: {
      planCode: plan.planCode,
      planName: plan.planName,
      limits: asLimitsJson(plan.limits),
      status: markPaid ? "ACTIVE" : "ACTIVE",
      paymentStatus: markPaid ? "PAID" : "PENDING",
      termMonths,
      startsAt: now,
      expiresAt,
      currentPeriodEnd: expiresAt,
    },
  });

  await writePlatformAuditLog({
    organizationId: orgId,
    actor: input.actor,
    action: "subscription.convert_trial",
    before,
    after: {
      status: updated.status,
      planCode: updated.planCode,
      paymentStatus: updated.paymentStatus,
      termMonths,
      expiresAt: expiresAt.toISOString(),
      markPaid,
      notes: input.notes ?? null,
    },
  });

  await ensureOrgShareReferralCode(orgId);

  return {
    organizationId: orgId,
    subscription: {
      id: updated.id,
      planCode: updated.planCode,
      planName: updated.planName,
      status: updated.status,
      paymentStatus: updated.paymentStatus,
      termMonths: updated.termMonths,
      startsAt: updated.startsAt?.toISOString() ?? null,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
    },
  };
}

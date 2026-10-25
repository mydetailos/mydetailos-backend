/**
 * Platform control-plane handlers:
 * - GET  /api/platform/dashboard
 * - GET  /api/platform/users
 * - GET  /api/platform/branches
 * - POST /api/platform/organizations/:orgId/branches
 * - GET  /api/platform/renewals|bills|payments|audit
 * - GET  /api/platform/organizations/:orgId/activity
 * - GET/POST/PATCH /api/platform/referrals
 * - GET/PUT/POST /api/platform/plans (+ PATCH/DELETE /plans/:code)
 * - GET/PUT /api/platform/settings
 * - GET  /api/platform/messaging
 * - POST /api/platform/messaging/test
 * - POST /api/platform/organizations/:orgId/suspend|restore
 */

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppHttpError } from "../../lib/app-http-error.js";
import { strongPasswordSchema } from "../../lib/password-policy.js";
import { writePlatformAuditLog } from "../../lib/platform-audit.js";
import {
  convertTrialSubscription,
  provisionOrganization,
} from "../organization/organization-provision.service.js";
import { env } from "../../config/env.js";
import { normalizePlanCode, parseAllowedTerms, parsePlanLimits } from "../../lib/plan-catalog.js";
import type { SubscriptionPricingPatch } from "../../lib/subscription-pricing.js";
import {
  createPlatformPlan,
  deletePlatformPlan,
  getEffectivePlanCatalog,
  getPlatformSettings,
  updatePlatformPlan,
  updatePlatformSettings,
  type PlatformSettingsPayload,
} from "../../lib/platform-settings.js";
import {
  isTwilioSmsEnabled,
  isTwilioWhatsAppEnabled,
  normalizePhoneToE164,
  sendTransactionalSms,
  sendWhatsAppMessage,
} from "../../services/twilio-sms.service.js";
import { isResendConfigured, sendViaResend } from "../../services/resend-send.js";
import { persistBusinessLogoFile } from "../../services/object-storage.service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function actorFromReq(req: Request): string {
  const auth = (req as Request & { auth?: { id?: string; email?: string } }).auth;
  if (auth?.email) return auth.email;
  if (auth?.id) return `user:${auth.id}`;
  const platformActor = (req as Request & { platformActor?: string }).platformActor;
  return platformActor ?? "platform-api-key";
}

function parseDateFilter(raw: unknown): Date | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function pageParams(query: Record<string, unknown>): { skip: number; take: number; page: number } {
  const take = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200);
  const page = Math.max(Number(query.page ?? 1) || 1, 1);
  return { skip: (page - 1) * take, take, page };
}

function parseBoolQuery(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  return undefined;
}

const PLAN_CODE_STRING = z
  .string()
  .min(2)
  .max(24)
  .transform((s) => normalizePlanCode(s))
  .refine((s) => /^[A-Z][A-Z0-9_]{1,23}$/.test(s), "Invalid plan code");

const termMonthsLiteral = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(12),
  z.literal(24),
  z.literal(36),
  z.literal(60),
]);
const allowedTermsSchema = z.array(termMonthsLiteral).min(1).max(6);

// ─── GET /api/platform/dashboard ─────────────────────────────────────────────

export async function getPlatformDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [
      orgTotal,
      orgActive,
      orgInactive,
      subsByStatus,
      mtdPaidAgg,
      pendingPayments,
      activeReferrals,
    ] = await Promise.all([
      prisma.organization.count(),
      prisma.organization.count({ where: { isActive: true } }),
      prisma.organization.count({ where: { isActive: false } }),
      prisma.organizationSubscription.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.subscriptionPayment.aggregate({
        where: {
          status: "PAID",
          OR: [
            { verifiedAt: { gte: monthStart } },
            { verifiedAt: null, createdAt: { gte: monthStart } },
          ],
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.subscriptionPayment.count({
        where: { status: { in: ["PENDING", "PROCESSING"] } },
      }),
      prisma.platformReferralCode.count({ where: { isActive: true } }),
    ]);

    const subscriptionStatusBreakdown: Record<string, number> = {};
    for (const row of subsByStatus) {
      subscriptionStatusBreakdown[row.status] = row._count._all;
    }

    res.json({
      data: {
        organizations: {
          total: orgTotal,
          active: orgActive,
          inactive: orgInactive,
        },
        subscriptionStatusBreakdown,
        revenueMtd: {
          amount: mtdPaidAgg._sum.amount ?? 0,
          paidPaymentCount: mtdPaidAgg._count._all,
          currency: "INR",
          periodStart: monthStart.toISOString(),
        },
        pendingPayments,
        activeReferrals,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/users ─────────────────────────────────────────────────

export async function listPlatformUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const { skip, take } = pageParams(q);
    const orgId = typeof q.orgId === "string" ? q.orgId : undefined;
    const role = typeof q.role === "string" ? q.role : undefined;
    const isActive = parseBoolQuery(q.isActive);
    const search = typeof q.search === "string" ? q.search.trim() : undefined;
    const includePlatformOwner = parseBoolQuery(q.includePlatformOwner) === true;

    const where: Prisma.UserWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    if (role) {
      where.role = role as UserRole;
    } else if (!includePlatformOwner) {
      where.role = { not: "PLATFORM_OWNER" };
    }

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          branchId: true,
          organizationId: true,
          lastLoginAt: true,
          organization: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
        },
        orderBy: [{ organizationId: "asc" }, { name: "asc" }],
        skip,
        take,
      }),
      prisma.user.count({ where }),
    ]);

    const users = rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      isActive: u.isActive,
      branchId: u.branchId,
      branchName: u.branch.name,
      organizationId: u.organizationId,
      organizationName: u.organization.name,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    }));

    res.json({ data: { users, total }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── POST /api/platform/organizations/:orgId/branches ────────────────────────

const tenDigitPhone = z.string().regex(/^\d{10}$/, "Must be a 10-digit mobile number");
const optionalTenDigitPhone = z
  .string()
  .regex(/^$|^\d{10}$/, "Must be a 10-digit mobile number")
  .nullable()
  .optional();

const platformCreateBranchSchema = z.object({
  name: z.string().min(1).max(160),
  address: z.string().min(1).max(500),
  phone: tenDigitPhone,
  code: z.string().max(32).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  pincode: z.string().max(12).nullable().optional(),
  email: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
  managerName: z.string().max(120).nullable().optional(),
  managerPhone: optionalTenDigitPhone,
  isActive: z.boolean().optional(),
  /** When true (default), raise maxBranchesOverride if the org is at its plan limit. */
  raiseLimitIfNeeded: z.boolean().optional(),
});

/**
 * Platform owner creates a workshop branch for an organization.
 * If the plan is at its branch cap, optionally raises `maxBranchesOverride` first.
 */
export async function postPlatformOrganizationBranch(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const orgId = String(req.params.orgId ?? "");
    if (!orgId) throw new AppHttpError(400, "Organization id is required.", "ORG_ID_REQUIRED");

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
    if (!org) throw new AppHttpError(404, "Organization not found.", "ORG_NOT_FOUND");

    const body = platformCreateBranchSchema.parse(req.body);
    const actor = actorFromReq(req);

    const {
      getEntitlementForOrg,
      patchOrganizationSubscription,
    } = await import("../organization/organization-subscription.service.js");
    const { upsertBranchApi } = await import("../branches/branch-api.service.js");

    let limitRaisedTo: number | null = null;
    if (body.raiseLimitIfNeeded !== false) {
      const entitlement = await getEntitlementForOrg(orgId);
      if (entitlement) {
        const used = entitlement.usage.branchesUsed;
        const max = entitlement.subscription.effectiveMaxBranches;
        if (max !== null && used >= max) {
          const nextMax = used + 1;
          await patchOrganizationSubscription(
            orgId,
            { maxBranchesOverride: nextMax },
            actor
          );
          limitRaisedTo = nextMax;
        }
      }
    }

    const id = `br-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const code =
      typeof body.code === "string" && body.code.trim()
        ? body.code.trim().toUpperCase()
        : null;
    const email =
      typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;

    const branch = await upsertBranchApi(
      {
        id,
        name: body.name.trim(),
        address: body.address.trim(),
        phone: body.phone,
        isActive: body.isActive ?? true,
        qrCodeId: `qr-${id}`,
        code,
        city: body.city?.trim() || null,
        state: body.state?.trim() || null,
        pincode: body.pincode?.trim() || null,
        email,
        managerName: body.managerName?.trim() || null,
        managerPhone: body.managerPhone?.trim() || null,
        organizationId: orgId,
      },
      { skipLimitCheck: true }
    );

    await writePlatformAuditLog({
      organizationId: orgId,
      actor,
      action: "branch.created",
      after: {
        branchId: branch.id,
        name: branch.name,
        code: branch.code ?? null,
        limitRaisedTo,
      },
    });

    res.status(201).json({
      data: {
        branch: {
          id: branch.id,
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
          isActive: branch.isActive,
          code: branch.code ?? null,
          city: branch.city ?? null,
          state: branch.state ?? null,
          pincode: branch.pincode ?? null,
          email: branch.email ?? null,
          managerName: branch.managerName ?? null,
          managerPhone: branch.managerPhone ?? null,
          organizationId: orgId,
          organizationName: org.name,
        },
        limitRaisedTo,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/branches ──────────────────────────────────────────────

export async function listPlatformBranches(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const { skip, take } = pageParams(q);
    const orgId = typeof q.orgId === "string" ? q.orgId : undefined;
    const isActive = parseBoolQuery(q.isActive);
    const search = typeof q.search === "string" ? q.search.trim() : undefined;

    const where: Prisma.BranchWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { city: { contains: search, mode: "insensitive" } },
              { code: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.branch.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true } },
        },
        orderBy: [{ organizationId: "asc" }, { name: "asc" }],
        skip,
        take,
      }),
      prisma.branch.count({ where }),
    ]);

    const branches = rows.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      phone: b.phone,
      isActive: b.isActive,
      code: b.code,
      city: b.city,
      state: b.state,
      pincode: b.pincode,
      email: b.email,
      managerName: b.managerName,
      managerPhone: b.managerPhone,
      organizationId: b.organizationId,
      organizationName: b.organization.name,
    }));

    res.json({ data: { branches, total }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/renewals ───────────────────────────────────────────────

export async function listPlatformRenewals(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const { skip, take } = pageParams(q);
    const orgId = typeof q.orgId === "string" ? q.orgId : undefined;
    const since = parseDateFilter(q.since);
    const until = parseDateFilter(q.until);
    const paymentStatus = typeof q.paymentStatus === "string" ? q.paymentStatus : undefined;

    const where: Prisma.SubscriptionBillWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(since || until
        ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
        : {}),
      ...(paymentStatus ? { payment: { status: paymentStatus as never } } : {}),
    };

    const [bills, total] = await Promise.all([
      prisma.subscriptionBill.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true } },
          payment: {
            select: {
              id: true,
              status: true,
              txnReference: true,
              amount: true,
              method: true,
              verifiedAt: true,
              recordedBy: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.subscriptionBill.count({ where }),
    ]);

    const renewals = bills.map((b) => ({
      billId: b.id,
      billNumber: b.billNumber,
      organizationId: b.organizationId,
      organizationName: b.organization.name,
      planName: b.planName,
      termMonths: b.termMonths,
      termLabel: b.termLabel,
      previousExpiry: b.periodStart.toISOString(),
      newExpiry: b.periodEnd.toISOString(),
      baseAmount: b.baseAmount ?? 0,
      referralDiscount: b.referralDiscount ?? 0,
      gstAmount: b.gstAmount ?? 0,
      totalAmount: b.totalAmount ?? b.amount ?? 0,
      currency: b.currency,
      paymentStatus: b.payment?.status ?? null,
      txnReference: b.payment?.txnReference ?? null,
      renewalDate: b.createdAt.toISOString(),
    }));

    res.json({ data: { renewals, total }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/bills ──────────────────────────────────────────────────

export async function listPlatformBills(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const { skip, take } = pageParams(q);
    const orgId = typeof q.orgId === "string" ? q.orgId : undefined;
    const since = parseDateFilter(q.since);
    const until = parseDateFilter(q.until);
    const paymentStatus = typeof q.paymentStatus === "string" ? q.paymentStatus : undefined;
    const search = typeof q.search === "string" ? q.search.trim() : undefined;

    const where: Prisma.SubscriptionBillWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(search
        ? {
            OR: [
              { billNumber: { contains: search, mode: "insensitive" } },
              { organization: { name: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
      ...(since || until
        ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
        : {}),
      ...(paymentStatus ? { payment: { status: paymentStatus as never } } : {}),
    };

    const [bills, total] = await Promise.all([
      prisma.subscriptionBill.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true } },
          payment: {
            select: { id: true, status: true, txnReference: true, verifiedAt: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.subscriptionBill.count({ where }),
    ]);

    const result = bills.map((b) => ({
      id: b.id,
      billNumber: b.billNumber,
      organizationId: b.organizationId,
      organizationName: b.organization.name,
      planName: b.planName,
      termMonths: b.termMonths,
      termLabel: b.termLabel,
      periodStart: b.periodStart.toISOString(),
      periodEnd: b.periodEnd.toISOString(),
      baseAmount: b.baseAmount ?? 0,
      extraBranchCost: b.extraBranchCost ?? 0,
      extraUserCost: b.extraUserCost ?? 0,
      onboardingFee: b.onboardingFee ?? 0,
      referralDiscount: b.referralDiscount ?? 0,
      gstPercent: b.gstPercent ?? 0,
      gstAmount: b.gstAmount ?? 0,
      totalAmount: b.totalAmount ?? b.amount ?? 0,
      currency: b.currency,
      paymentStatus: b.payment?.status ?? null,
      txnReference: b.payment?.txnReference ?? null,
      verifiedAt: b.payment?.verifiedAt?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
    }));

    res.json({ data: { bills: result, total }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/payments ───────────────────────────────────────────────

export async function listPlatformPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const { skip, take } = pageParams(q);
    const orgId = typeof q.orgId === "string" ? q.orgId : undefined;
    const status = typeof q.status === "string" ? q.status : undefined;
    const since = parseDateFilter(q.since);
    const until = parseDateFilter(q.until);

    // Auto-settle gateway successes/failures when reviewing open payments
    // (covers missed webhooks / local environments without a public webhook URL).
    if (!status || status === "PROCESSING" || status === "PENDING") {
      try {
        const { reconcileOpenRazorpayPayments } = await import(
          "../organization/organization-subscription.service.js"
        );
        await reconcileOpenRazorpayPayments({ limit: 30 });
      } catch {
        /* listing must still work if Razorpay is briefly unavailable */
      }
    }

    const where: Prisma.SubscriptionPaymentWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(status ? { status: status as never } : {}),
      ...(since || until
        ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
        : {}),
    };

    const [payments, total] = await Promise.all([
      prisma.subscriptionPayment.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true } },
          subscription: { select: { planCode: true, planName: true } },
          bill: { select: { billNumber: true, totalAmount: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.subscriptionPayment.count({ where }),
    ]);

    const result = payments.map((p) => ({
      id: p.id,
      organizationId: p.organizationId,
      organizationName: p.organization.name,
      planCode: p.subscription.planCode,
      planName: p.subscription.planName,
      billNumber: p.bill?.billNumber ?? null,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      txnReference: p.txnReference,
      method: p.method,
      notes: p.notes,
      recordedBy: p.recordedBy,
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    }));

    res.json({ data: { payments: result, total }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/audit ──────────────────────────────────────────────────

export async function listPlatformAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const { skip, take } = pageParams(q);
    const orgId = typeof q.orgId === "string" ? q.orgId : undefined;
    const action = typeof q.action === "string" ? q.action : undefined;
    const since = parseDateFilter(q.since);
    const until = parseDateFilter(q.until);

    const where: Prisma.PlatformAuditLogWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
      ...(since || until
        ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
        : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.platformAuditLog.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.platformAuditLog.count({ where }),
    ]);

    const result = logs.map((l) => ({
      id: l.id,
      organizationId: l.organizationId,
      organizationName: l.organization?.name ?? null,
      actor: l.actor,
      action: l.action,
      before: l.before,
      after: l.after,
      createdAt: l.createdAt.toISOString(),
    }));

    res.json({ data: { logs: result, total }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/organizations/:orgId/activity ─────────────────────────
/**
 * Read-only Platform Owner view of Workshop activityLogs for one organization.
 * Reuses AppJsonRow collection="activityLogs" — does not touch PlatformAuditLog.
 */
export async function listPlatformOrganizationActivity(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const orgId = String(req.params["orgId"] ?? "").trim();
    if (!orgId) throw new AppHttpError(400, "orgId is required.", "MISSING_PARAM");

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
    if (!org) throw new AppHttpError(404, "Organization not found.", "ORG_NOT_FOUND");

    const q = req.query as Record<string, unknown>;
    const { skip, take, page } = pageParams(q);
    const action = typeof q.action === "string" ? q.action.trim() : "";
    const entityType = typeof q.entityType === "string" ? q.entityType.trim() : "";
    const actor = typeof q.actor === "string" ? q.actor.trim() : "";
    const search = typeof q.search === "string" ? q.search.trim() : "";
    const since = parseDateFilter(q.since);
    const until = parseDateFilter(q.until);

    const actionPat = action ? `%${action}%` : null;
    const entityPat = entityType ? `%${entityType}%` : null;
    const actorPat = actor ? `%${actor}%` : null;
    const searchPat = search ? `%${search}%` : null;

    const rows = await prisma.$queryRaw<
      Array<{
        payload: unknown;
        entityId: string;
        createdAt: Date;
        total_count: bigint;
      }>
    >`
      SELECT
        payload,
        "entityId",
        "createdAt",
        COUNT(*) OVER() AS total_count
      FROM "AppJsonRow"
      WHERE collection = 'activityLogs'
        AND "organizationId" = ${orgId}
        AND (${since}::timestamptz IS NULL OR "createdAt" >= ${since})
        AND (${until}::timestamptz IS NULL OR "createdAt" <= ${until})
        AND (
          ${actionPat}::text IS NULL
          OR COALESCE(payload->>'action', '') ILIKE ${actionPat}
        )
        AND (
          ${entityPat}::text IS NULL
          OR COALESCE(payload->>'entityType', '') ILIKE ${entityPat}
        )
        AND (
          ${actorPat}::text IS NULL
          OR COALESCE(payload->>'userName', '') ILIKE ${actorPat}
          OR COALESCE(payload->>'userId', '') ILIKE ${actorPat}
        )
        AND (
          ${searchPat}::text IS NULL
          OR COALESCE(payload->>'details', '') ILIKE ${searchPat}
          OR COALESCE(payload->>'entityLabel', '') ILIKE ${searchPat}
          OR COALESCE(payload->>'action', '') ILIKE ${searchPat}
          OR COALESCE(payload->>'entityId', '') ILIKE ${searchPat}
        )
      ORDER BY "createdAt" DESC
      LIMIT ${take} OFFSET ${skip}
    `;

    const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;

    const { normalizeActivityLogPayload } = await import(
      "../../services/activity-logger.service.js"
    );
    const activities = rows.map((r) => {
      const p = normalizeActivityLogPayload(r.payload, r.entityId);
      const createdAtRaw =
        typeof p.createdAt === "string"
          ? p.createdAt
          : typeof p.timestamp === "string"
            ? p.timestamp
            : r.createdAt.toISOString();
      return {
        id: typeof p.id === "string" ? p.id : r.entityId,
        organizationId: org.id,
        organizationName: org.name,
        action: typeof p.action === "string" ? p.action : "",
        entityType: typeof p.entityType === "string" ? p.entityType : "",
        entityId: typeof p.entityId === "string" ? p.entityId : r.entityId,
        entityLabel: typeof p.entityLabel === "string" ? p.entityLabel : null,
        userId: typeof p.userId === "string" ? p.userId : null,
        userName: typeof p.userName === "string" ? p.userName : null,
        details:
          typeof p.details === "string"
            ? p.details
            : p.details != null
              ? JSON.stringify(p.details)
              : null,
        createdAt: createdAtRaw,
      };
    });

    res.json({
      data: {
        activities,
        total,
        page,
        pageSize: take,
        organization: { id: org.id, name: org.name },
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/referrals ─────────────────────────────────────────────

export async function listPlatformReferrals(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const showInactive = q.showInactive === "true";

    const codes = await prisma.platformReferralCode.findMany({
      where: showInactive ? {} : { isActive: true },
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const result = codes.map((c) => ({
      id: c.id,
      code: c.code,
      discountAmount: c.discountAmount,
      isActive: c.isActive,
      createdBy: c.createdBy,
      notes: c.notes,
      organizationId: c.organizationId,
      organizationName: c.organization?.name ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));

    res.json({ data: { referralCodes: result, total: result.length }, error: null });
  } catch (e) {
    next(e);
  }
}

const createReferralSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(24)
    .regex(/^[A-Z0-9-]+$/, "Code must be uppercase letters, digits, or hyphens only."),
  discountAmount: z.number().min(0).default(1000),
  notes: z.string().max(500).optional(),
});

// ─── POST /api/platform/referrals ────────────────────────────────────────────

export async function createPlatformReferral(req: Request, res: Response, next: NextFunction) {
  try {
    const body = createReferralSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);

    const existing = await prisma.platformReferralCode.findUnique({
      where: { code: body.code },
    });
    if (existing) {
      throw new AppHttpError(409, `Referral code "${body.code}" already exists.`, "DUPLICATE_CODE");
    }

    const created = await prisma.platformReferralCode.create({
      data: {
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        code: body.code,
        discountAmount: body.discountAmount,
        isActive: true,
        createdBy: actor,
        notes: body.notes ?? null,
      },
    });

    await writePlatformAuditLog({
      actor,
      action: "referral.created",
      after: {
        id: created.id,
        code: created.code,
        discountAmount: created.discountAmount,
        isActive: created.isActive,
      },
    });

    res.status(201).json({
      data: {
        id: created.id,
        code: created.code,
        discountAmount: created.discountAmount,
        isActive: created.isActive,
        createdBy: created.createdBy,
        notes: created.notes,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

const patchReferralSchema = z
  .object({
    discountAmount: z.number().min(0).optional(),
    notes: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => b.discountAmount !== undefined || b.notes !== undefined || b.isActive !== undefined, {
    message: "At least one of discountAmount, notes, isActive is required.",
  });

// ─── PATCH /api/platform/referrals/:id ───────────────────────────────────────

export async function patchPlatformReferral(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new AppHttpError(400, "id is required.", "MISSING_PARAM");
    const body = patchReferralSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);

    const existing = await prisma.platformReferralCode.findUnique({ where: { id } });
    if (!existing) throw new AppHttpError(404, "Referral code not found.", "NOT_FOUND");

    const before = {
      discountAmount: existing.discountAmount,
      notes: existing.notes,
      isActive: existing.isActive,
    };

    const updated = await prisma.platformReferralCode.update({
      where: { id },
      data: {
        ...(body.discountAmount !== undefined ? { discountAmount: body.discountAmount } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });

    await writePlatformAuditLog({
      actor,
      action: body.isActive === false ? "referral.deactivated" : "referral.updated",
      before,
      after: {
        discountAmount: updated.discountAmount,
        notes: updated.notes,
        isActive: updated.isActive,
      },
    });

    res.json({
      data: {
        id: updated.id,
        code: updated.code,
        discountAmount: updated.discountAmount,
        isActive: updated.isActive,
        createdBy: updated.createdBy,
        notes: updated.notes,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function listPlatformReferralWallets(req: Request, res: Response, next: NextFunction) {
  try {
    const wallets = await prisma.referralWallet.findMany({
      include: {
        organization: { select: { id: true, name: true } },
        transactions: { orderBy: { createdAt: "desc" }, take: 20 },
      },
      orderBy: { points: "desc" },
    });
    res.json({
      data: {
        wallets: wallets.map((w) => ({
          id: w.id,
          organizationId: w.organizationId,
          organizationName: w.organization.name,
          points: w.points,
          updatedAt: w.updatedAt.toISOString(),
          transactions: w.transactions.map((t) => ({
            id: t.id,
            type: t.type,
            points: t.points,
            amountInr: t.amountInr,
            referralCode: t.referralCode,
            sourceOrganizationId: t.sourceOrganizationId,
            paymentId: t.paymentId,
            notes: t.notes,
            createdAt: t.createdAt.toISOString(),
          })),
        })),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/plans ─────────────────────────────────────────────────

export async function getPlatformPlans(req: Request, res: Response, next: NextFunction) {
  try {
    const settings = await getPlatformSettings();
    const plans = getEffectivePlanCatalog(settings.planCatalog);
    res.json({
      data: {
        plans,
        overrides: settings.planOverrides,
        pricing: settings.subscriptionPricing,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

const planLimitsSchema = z.object({
  maxBranches: z.number().int().min(0).nullable().optional(),
  maxStaff: z.number().int().min(0).nullable().optional(),
  maxCustomers: z.number().int().min(0).nullable().optional(),
});

const pricingPatchSchema = z.object({
  currency: z.string().min(1).max(8).optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  termBasePrices: z
    .object({
      1: z.number().min(0).optional(),
      3: z.number().min(0).optional(),
      12: z.number().min(0).optional(),
      24: z.number().min(0).optional(),
      36: z.number().min(0).optional(),
      60: z.number().min(0).optional(),
    })
    .optional(),
  planMultipliers: z.record(z.string(), z.number().min(0)).optional(),
  addOns: z
    .object({
      extraBranchPrice: z.number().min(0).optional(),
      extraUserPrice: z.number().min(0).optional(),
      onboardingFee: z.number().min(0).optional(),
      referralDiscount: z.number().min(0).optional(),
    })
    .optional(),
}).optional();

const putPlansSchema = z.object({
  planOverrides: z
    .record(
      z.string(),
      z.object({
        planName: z.string().min(1).max(80).optional(),
        limits: planLimitsSchema.optional(),
        publicVisible: z.boolean().optional(),
        allowedTerms: allowedTermsSchema.optional(),
      })
    )
    .optional()
    .default({}),
  pricing: pricingPatchSchema,
});

function plansResponse(settings: Awaited<ReturnType<typeof getPlatformSettings>>) {
  return {
    plans: getEffectivePlanCatalog(settings.planCatalog),
    overrides: settings.planOverrides,
    pricing: settings.subscriptionPricing,
  };
}

// ─── PUT /api/platform/plans ─────────────────────────────────────────────────

export async function putPlatformPlans(req: Request, res: Response, next: NextFunction) {
  try {
    const body = putPlansSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);
    const before = await getPlatformSettings();
    const known = new Set(before.planCatalog.map((p) => p.planCode));

    const planOverrides: PlatformSettingsPayload["planOverrides"] = {};
    for (const [codeRaw, override] of Object.entries(body.planOverrides ?? {})) {
      const planCode = normalizePlanCode(codeRaw);
      if (!known.has(planCode)) continue;
      const existing = before.planCatalog.find((p) => p.planCode === planCode)!;
      planOverrides[planCode] = {
        ...(override.planName ? { planName: override.planName } : {}),
        ...(override.limits
          ? {
              limits: parsePlanLimits({
                ...existing.limits,
                ...override.limits,
              }),
            }
          : {}),
        ...(override.publicVisible !== undefined ? { publicVisible: override.publicVisible } : {}),
        ...(override.allowedTerms !== undefined
          ? { allowedTerms: parseAllowedTerms(override.allowedTerms) }
          : {}),
      };
    }

    const pricingPatch: SubscriptionPricingPatch | undefined = body.pricing
      ? {
          ...(body.pricing.currency !== undefined ? { currency: body.pricing.currency } : {}),
          ...(body.pricing.gstPercent !== undefined ? { gstPercent: body.pricing.gstPercent } : {}),
          ...(body.pricing.termBasePrices ? { termBasePrices: body.pricing.termBasePrices } : {}),
          ...(body.pricing.planMultipliers
            ? {
                planMultipliers: Object.fromEntries(
                  Object.entries(body.pricing.planMultipliers).map(([k, v]) => [
                    normalizePlanCode(k),
                    v,
                  ])
                ) as SubscriptionPricingPatch["planMultipliers"],
              }
            : {}),
          ...(body.pricing.addOns ? { addOns: body.pricing.addOns } : {}),
        }
      : undefined;

    const patch: PlatformSettingsPayload = {
      ...(Object.keys(planOverrides).length ? { planOverrides } : {}),
      ...(pricingPatch ? { subscriptionPricing: pricingPatch } : {}),
      ...(pricingPatch?.gstPercent !== undefined
        ? { defaultGstPercent: pricingPatch.gstPercent }
        : {}),
    };

    const settings = await updatePlatformSettings({
      patch,
      updatedBy: actor,
    });

    await writePlatformAuditLog({
      actor,
      action: "plans.updated",
      before: {
        planCatalog: before.planCatalog,
        pricing: before.subscriptionPricing,
      },
      after: {
        planCatalog: settings.planCatalog,
        pricing: settings.subscriptionPricing,
      },
    });

    res.json({ data: plansResponse(settings), error: null });
  } catch (e) {
    next(e);
  }
}

const createPlanSchema = z.object({
  planCode: PLAN_CODE_STRING,
  planName: z.string().min(1).max(80),
  limits: planLimitsSchema.optional(),
  publicVisible: z.boolean().optional().default(true),
  allowedTerms: allowedTermsSchema.optional(),
  multiplier: z.number().min(0).optional().default(1),
});

// ─── POST /api/platform/plans ────────────────────────────────────────────────

export async function postPlatformPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const body = createPlanSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);
    const before = await getPlatformSettings();
    const settings = await createPlatformPlan(
      {
        planCode: body.planCode,
        planName: body.planName,
        limits: body.limits ? parsePlanLimits(body.limits) : undefined,
        publicVisible: body.publicVisible,
        allowedTerms: body.allowedTerms,
        multiplier: body.multiplier,
      },
      actor
    );
    await writePlatformAuditLog({
      actor,
      action: "plans.created",
      before: { planCatalog: before.planCatalog },
      after: { planCatalog: settings.planCatalog, created: body.planCode },
    });
    res.status(201).json({ data: plansResponse(settings), error: null });
  } catch (e) {
    next(e);
  }
}

const patchPlanSchema = z.object({
  planName: z.string().min(1).max(80).optional(),
  limits: planLimitsSchema.optional(),
  publicVisible: z.boolean().optional(),
  allowedTerms: allowedTermsSchema.optional(),
  multiplier: z.number().min(0).optional(),
});

// ─── PATCH /api/platform/plans/:code ─────────────────────────────────────────

export async function patchPlatformPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const code = PLAN_CODE_STRING.parse(req.params.code);
    const body = patchPlanSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);
    const before = await getPlatformSettings();
    const settings = await updatePlatformPlan(
      code,
      {
        planName: body.planName,
        limits: body.limits ? parsePlanLimits(body.limits) : undefined,
        publicVisible: body.publicVisible,
        allowedTerms: body.allowedTerms,
        multiplier: body.multiplier,
      },
      actor
    );
    await writePlatformAuditLog({
      actor,
      action: "plans.patched",
      before: { plan: before.planCatalog.find((p) => p.planCode === code) ?? null },
      after: { plan: settings.planCatalog.find((p) => p.planCode === code) ?? null },
    });
    res.json({ data: plansResponse(settings), error: null });
  } catch (e) {
    next(e);
  }
}

// ─── DELETE /api/platform/plans/:code ────────────────────────────────────────

export async function deletePlatformPlanHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const code = PLAN_CODE_STRING.parse(req.params.code);
    const actor = actorFromReq(req);
    const before = await getPlatformSettings();
    const settings = await deletePlatformPlan(code, actor);
    await writePlatformAuditLog({
      actor,
      action: "plans.deleted",
      before: { plan: before.planCatalog.find((p) => p.planCode === code) ?? null },
      after: { planCatalog: settings.planCatalog },
    });
    res.json({ data: plansResponse(settings), error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/settings ──────────────────────────────────────────────

export async function getPlatformSettingsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const settings = await getPlatformSettings();
    res.json({
      data: {
        settings: {
          trialDaysDefault: settings.trialDaysDefault,
          defaultTermMonths: settings.defaultTermMonths,
          defaultGstPercent: settings.defaultGstPercent,
          defaultContactUsUrl: settings.defaultContactUsUrl,
          defaultContactPhone: settings.defaultContactPhone,
          defaultUpgradeUrl: settings.defaultUpgradeUrl,
          invoiceSettings: settings.invoiceSettings ?? null,
        },
        meta: {
          updatedAt: settings.updatedAt,
          updatedBy: settings.updatedBy,
          envFallbacks: {
            defaultContactUsUrl: env.DEFAULT_CONTACT_US_URL ?? null,
            defaultUpgradeUrl: env.DEFAULT_UPGRADE_URL ?? null,
            defaultContactPhone: process.env.DEFAULT_CONTACT_PHONE?.trim() || null,
          },
        },
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

const putSettingsSchema = z.object({
  trialDaysDefault: z.number().int().min(1).max(90).optional(),
  defaultTermMonths: z.union([z.literal(12), z.literal(24), z.literal(36), z.literal(60)]).optional(),
  defaultGstPercent: z.number().min(0).max(100).optional(),
  defaultContactUsUrl: z.string().max(500).nullable().optional(),
  defaultContactPhone: z.string().max(32).nullable().optional(),
  defaultUpgradeUrl: z.string().max(500).nullable().optional(),
  invoiceSettings: z.record(z.string(), z.unknown()).optional(),
});

// ─── PUT /api/platform/settings ──────────────────────────────────────────────

export async function putPlatformSettingsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const body = putSettingsSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);
    const before = await getPlatformSettings();

    // Reject accidental secret fields if a client sends them.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const forbiddenKeys = [
      "twilioAuthToken",
      "twilioApiKeySecret",
      "resendApiKey",
      "RESEND_API_KEY",
      "TWILIO_AUTH_TOKEN",
    ];
    for (const key of forbiddenKeys) {
      if (key in raw) {
        throw new AppHttpError(400, "Provider secrets cannot be stored via platform settings.", "SECRETS_NOT_ALLOWED");
      }
    }

    const settings = await updatePlatformSettings({
      patch: body,
      updatedBy: actor,
    });

    await writePlatformAuditLog({
      actor,
      action: "settings.updated",
      before: {
        trialDaysDefault: before.trialDaysDefault,
        defaultTermMonths: before.defaultTermMonths,
        defaultGstPercent: before.defaultGstPercent,
        defaultContactUsUrl: before.defaultContactUsUrl,
        defaultContactPhone: before.defaultContactPhone,
        defaultUpgradeUrl: before.defaultUpgradeUrl,
        hasInvoiceSettings: Boolean(before.invoiceSettings),
      },
      after: {
        trialDaysDefault: settings.trialDaysDefault,
        defaultTermMonths: settings.defaultTermMonths,
        defaultGstPercent: settings.defaultGstPercent,
        defaultContactUsUrl: settings.defaultContactUsUrl,
        defaultContactPhone: settings.defaultContactPhone,
        defaultUpgradeUrl: settings.defaultUpgradeUrl,
        hasInvoiceSettings: Boolean(settings.invoiceSettings),
      },
    });

    res.json({
      data: {
        settings: {
          trialDaysDefault: settings.trialDaysDefault,
          defaultTermMonths: settings.defaultTermMonths,
          defaultGstPercent: settings.defaultGstPercent,
          defaultContactUsUrl: settings.defaultContactUsUrl,
          defaultContactPhone: settings.defaultContactPhone,
          defaultUpgradeUrl: settings.defaultUpgradeUrl,
          invoiceSettings: settings.invoiceSettings ?? null,
        },
        meta: {
          updatedAt: settings.updatedAt,
          updatedBy: settings.updatedBy,
        },
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

// ─── POST /api/platform/settings/invoice-logo ────────────────────────────────

export async function postPlatformInvoiceLogo(req: Request, res: Response, next: NextFunction) {
  try {
    const file = req.file;
    if (!file?.buffer) {
      res.status(400).json({ data: null, error: { message: "No image file provided." } });
      return;
    }
    const actor = actorFromReq(req);
    const url = await persistBusinessLogoFile({
      buffer: file.buffer,
      mimeType: file.mimetype,
      uploadedBy: actor,
    });
    res.json({ data: { url }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/messaging ─────────────────────────────────────────────

export async function getPlatformMessagingStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      data: {
        smsEnabled: isTwilioSmsEnabled(),
        whatsappEnabled: isTwilioWhatsAppEnabled(),
        emailEnabled: isResendConfigured(),
        mailFromSet: Boolean(env.MAIL_FROM?.trim()),
        twilioFromSet: Boolean(env.TWILIO_FROM_NUMBER?.trim()),
        twilioWhatsappFromSet: Boolean(env.TWILIO_WHATSAPP_FROM?.trim()),
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

// ─── POST /api/platform/messaging/test ───────────────────────────────────────

const messagingTestSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("sms"),
    to: z.string().min(8).max(32),
    body: z.string().min(1).max(1600).optional(),
  }),
  z.object({
    channel: z.literal("whatsapp"),
    to: z.string().min(8).max(32),
    body: z.string().min(1).max(1600).optional(),
  }),
  z.object({
    channel: z.literal("email"),
    to: z.string().email(),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20_000).optional(),
  }),
]);

const DEFAULT_SMS_BODY =
  "My Detail OS — platform test SMS. If you received this, Twilio SMS is working.";
const DEFAULT_WHATSAPP_BODY =
  "My Detail OS — platform test WhatsApp. If you received this, Twilio WhatsApp is working.";
const DEFAULT_EMAIL_SUBJECT = "My Detail OS — platform test email";
const DEFAULT_EMAIL_BODY =
  "<p>My Detail OS platform test email.</p><p>If you received this, Resend email is working.</p>";

export async function postPlatformMessagingTest(req: Request, res: Response, next: NextFunction) {
  try {
    const body = messagingTestSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);

    if (body.channel === "sms") {
      if (!isTwilioSmsEnabled()) {
        throw new AppHttpError(503, "SMS is not configured on the API server.", "SMS_NOT_CONFIGURED");
      }
      const to = normalizePhoneToE164(body.to);
      const text = body.body?.trim() || DEFAULT_SMS_BODY;
      await sendTransactionalSms(to, text);
      await writePlatformAuditLog({
        organizationId: null,
        actor,
        action: "messaging.test_sms",
        before: null,
        after: { to, preview: text.slice(0, 120) },
      });
      res.json({ data: { ok: true, channel: "sms", to }, error: null });
      return;
    }

    if (body.channel === "whatsapp") {
      if (!isTwilioWhatsAppEnabled()) {
        throw new AppHttpError(
          503,
          "WhatsApp is not configured on the API server.",
          "WHATSAPP_NOT_CONFIGURED"
        );
      }
      const text = body.body?.trim() || DEFAULT_WHATSAPP_BODY;
      const result = await sendWhatsAppMessage(body.to, text);
      if (
        result.status === "failed" ||
        result.status === "undelivered" ||
        (result.twilioErrorCode != null && result.twilioErrorCode !== 0)
      ) {
        const message = result.twilioErrorCode === 63016
          ? "WhatsApp rejected this free-form message outside the 24-hour reply window. Send a WhatsApp message to the configured sender first, then retry, or use an approved template."
          : result.twilioErrorMessage || `WhatsApp message ${result.status}${result.twilioErrorCode ? ` (Twilio error ${result.twilioErrorCode})` : ""}.`;
        throw new AppHttpError(502, message, "WHATSAPP_SEND_FAILED");
      }
      await writePlatformAuditLog({
        organizationId: null,
        actor,
        action: "messaging.test_whatsapp",
        before: null,
        after: { to: body.to, preview: text.slice(0, 120) },
      });
      res.json({ data: { ok: true, channel: "whatsapp", to: body.to, sid: result.sid, status: result.status }, error: null });
      return;
    }

    if (!isResendConfigured()) {
      throw new AppHttpError(503, "Email is not configured on the API server.", "EMAIL_NOT_CONFIGURED");
    }
    const subject = body.subject?.trim() || DEFAULT_EMAIL_SUBJECT;
    const html = body.body?.trim() || DEFAULT_EMAIL_BODY;
    const out = await sendViaResend({
      to: [body.to],
      subject,
      html,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    });
    if (!out.ok) {
      throw new AppHttpError(502, out.detail, "EMAIL_SEND_FAILED");
    }
    await writePlatformAuditLog({
      organizationId: null,
      actor,
      action: "messaging.test_email",
      before: null,
      after: { to: body.to, subject },
    });
    res.json({ data: { ok: true, channel: "email", to: body.to }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── POST /api/platform/organizations/:orgId/suspend ─────────────────────────

const suspendSchema = z.object({
  reason: z.string().min(1).max(500),
});

export async function suspendOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = String(req.params["orgId"] ?? "");
    if (!orgId) throw new AppHttpError(400, "orgId is required.", "MISSING_PARAM");
    const body = suspendSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);

    const sub = await prisma.organizationSubscription.findUnique({
      where: { organizationId: orgId },
    });
    if (!sub) throw new AppHttpError(404, "Organization subscription not found.", "NOT_FOUND");
    if (sub.status === "CANCELLED") {
      throw new AppHttpError(409, "Subscription is already suspended/cancelled.", "ALREADY_SUSPENDED");
    }

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { isActive: true },
    });
    if (!org) throw new AppHttpError(404, "Organization not found.", "NOT_FOUND");

    const before = { status: sub.status, isActive: org.isActive };
    await prisma.$transaction([
      prisma.organizationSubscription.update({
        where: { organizationId: orgId },
        data: { status: "CANCELLED" },
      }),
      // Restrict workshop access (TenantGuard blocks inactive orgs).
      prisma.organization.update({
        where: { id: orgId },
        data: { isActive: false },
      }),
    ]);

    await writePlatformAuditLog({
      organizationId: orgId,
      actor,
      action: "subscription.suspended",
      before,
      after: { status: "CANCELLED", isActive: false, reason: body.reason },
    });

    res.json({ data: { suspended: true, reason: body.reason }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── POST /api/platform/organizations/:orgId/restore ─────────────────────────

const restoreSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

export async function restoreOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = String(req.params["orgId"] ?? "");
    if (!orgId) throw new AppHttpError(400, "orgId is required.", "MISSING_PARAM");
    const body = restoreSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);

    const sub = await prisma.organizationSubscription.findUnique({
      where: { organizationId: orgId },
    });
    if (!sub) throw new AppHttpError(404, "Organization subscription not found.", "NOT_FOUND");

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { isActive: true },
    });
    if (!org) throw new AppHttpError(404, "Organization not found.", "NOT_FOUND");

    const before = { status: sub.status, isActive: org.isActive };
    await prisma.$transaction([
      prisma.organizationSubscription.update({
        where: { organizationId: orgId },
        data: { status: "ACTIVE" },
      }),
      prisma.organization.update({
        where: { id: orgId },
        data: { isActive: true },
      }),
    ]);

    await writePlatformAuditLog({
      organizationId: orgId,
      actor,
      action: "subscription.restored",
      before,
      after: {
        status: "ACTIVE",
        isActive: true,
        reason: body.reason ?? "Restored by platform admin",
      },
    });

    res.json({ data: { restored: true }, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── DELETE /api/platform/organizations/:orgId ───────────────────────────────

export async function deletePlatformOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = String(req.params["orgId"] ?? "");
    if (!orgId) throw new AppHttpError(400, "orgId is required.", "MISSING_PARAM");
    const actor = actorFromReq(req);

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true },
    });
    if (!org) throw new AppHttpError(404, "Organization not found.", "NOT_FOUND");

    // Safeguard: Do not delete if the PLATFORM_OWNER account is anchored to this organization
    const platformOwner = await prisma.user.findFirst({
      where: { organizationId: orgId, role: "PLATFORM_OWNER" },
    });
    if (platformOwner) {
      throw new AppHttpError(
        400,
        "Cannot delete this organization because the Platform Owner user is attached to it. Please reassign the platform owner first.",
        "PLATFORM_OWNER_ATTACHED"
      );
    }

    await prisma.$transaction(async (tx) => {
      // 1. Inspections
      await tx.inspectionSendLog.deleteMany({ where: { organizationId: orgId } });
      await tx.inspectionUpload.deleteMany({ where: { organizationId: orgId } });
      await tx.inspectionReportVersion.deleteMany({
        where: { report: { organizationId: orgId } },
      });
      await tx.inspectionReport.deleteMany({ where: { organizationId: orgId } });
      await tx.inspectionTemplate.deleteMany({ where: { organizationId: orgId } });

      // 2. AppJsonRow
      await tx.appJsonRow.deleteMany({ where: { organizationId: orgId } });

      // 3. Parties & related child tables
      const parties = await tx.party.findMany({
        where: { organizationId: orgId },
        select: { id: true },
      });
      const partyIds = parties.map((p) => p.id);
      if (partyIds.length > 0) {
        await tx.partyHidden.deleteMany({ where: { partyId: { in: partyIds } } });
        await tx.partyCustomField.deleteMany({ where: { partyId: { in: partyIds } } });
        await tx.partyBankAccount.deleteMany({ where: { partyId: { in: partyIds } } });
        await tx.partyShippingAddress.deleteMany({ where: { partyId: { in: partyIds } } });
        await tx.party.deleteMany({ where: { organizationId: orgId } });
      }

      // 4. Vehicles & Customers
      await tx.vehicle.deleteMany({ where: { organizationId: orgId } });
      await tx.customer.deleteMany({ where: { organizationId: orgId } });

      // 5. Appointments
      await tx.appointment.deleteMany({ where: { organizationId: orgId } });

      // 6. Attendance & Users
      const branches = await tx.branch.findMany({
        where: { organizationId: orgId },
        select: { id: true },
      });
      const branchIds = branches.map((b) => b.id);
      if (branchIds.length > 0) {
        await tx.attendance.deleteMany({ where: { branchId: { in: branchIds } } });
      }
      await tx.user.deleteMany({ where: { organizationId: orgId } });

      // 7. Branches
      await tx.branch.deleteMany({ where: { organizationId: orgId } });

      // 8. Subscriptions, Payments, Bills, Referrals
      await tx.subscriptionBill.deleteMany({ where: { organizationId: orgId } });
      await tx.subscriptionPayment.deleteMany({ where: { organizationId: orgId } });
      await tx.organizationSubscription.deleteMany({ where: { organizationId: orgId } });
      await tx.referralTransaction.deleteMany({
        where: { wallet: { organizationId: orgId } },
      });
      await tx.referralWallet.deleteMany({ where: { organizationId: orgId } });
      await tx.platformReferralCode.deleteMany({ where: { organizationId: orgId } });
      await tx.platformAuditLog.deleteMany({ where: { organizationId: orgId } });

      // 9. Finally, the Organization
      await tx.organization.delete({ where: { id: orgId } });
    });

    await writePlatformAuditLog({
      organizationId: null,
      actor,
      action: "organization.deleted",
      before: { id: org.id, name: org.name, slug: org.slug },
      after: null,
    });

    res.json({ data: { deleted: true, organizationId: orgId, name: org.name }, error: null });
  } catch (e) {
    next(e);
  }
}


// ─── POST /api/platform/organizations/provision ──────────────────────────────

const provisionSchema = z.object({
  businessName: z.string().min(1).max(160),
  ownerName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(7).max(20),
  password: strongPasswordSchema,
  branchName: z.string().min(1).max(120).optional(),
  planCode: z.string().min(2).max(24).optional(),
  referralCode: z.string().max(32).nullable().optional(),
  trialDays: z.number().int().min(1).max(90).optional(),
  source: z.string().max(80).optional(),
});

export async function postPlatformProvisionOrganization(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const body = provisionSchema.parse(req.body ?? {});
    const actor = actorFromReq(req);
    const result = await provisionOrganization({
      ...body,
      actor,
      source: body.source ?? "platform_admin",
    });
    res.status(201).json({ data: result, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── POST /api/platform/organizations/:orgId/subscription/convert-trial ───────

const convertTrialSchema = z.object({
  termMonths: z
    .union([z.literal(1), z.literal(3), z.literal(12), z.literal(24), z.literal(36), z.literal(60)])
    .optional(),
  planCode: z.string().min(2).max(24).optional(),
  markPaid: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

export async function postPlatformConvertTrial(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const orgId = String(req.params["orgId"] ?? "");
    if (!orgId) throw new AppHttpError(400, "orgId is required.", "MISSING_PARAM");
    const body = convertTrialSchema.parse(req.body ?? {});
    const result = await convertTrialSubscription({
      organizationId: orgId,
      actor: actorFromReq(req),
      termMonths: body.termMonths,
      planCode: body.planCode,
      markPaid: body.markPaid,
      notes: body.notes,
    });
    res.json({ data: result, error: null });
  } catch (e) {
    next(e);
  }
}

// ─── GET /api/platform/contacts ───────────────────────────────────────────────

export async function listPlatformContacts(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, unknown>;
    const take = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const search = typeof q.search === "string" ? q.search.trim().toLowerCase() : "";

    const rows = await prisma.appJsonRow.findMany({
      where: { collection: "publicContacts" },
      orderBy: { createdAt: "desc" },
      take: search ? 500 : take,
    });

    type ContactPayload = {
      id?: string;
      name?: string;
      email?: string;
      phone?: string;
      businessName?: string;
      subject?: string;
      message?: string;
      source?: string;
      createdAt?: string;
      ip?: string;
      userAgent?: string | null;
    };

    let contacts = rows.map((row) => {
      const payload = (row.payload ?? {}) as ContactPayload;
      return {
        id: payload.id ?? row.entityId,
        name: payload.name ?? "",
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        businessName: payload.businessName ?? null,
        subject: payload.subject ?? null,
        message: payload.message ?? "",
        source: payload.source ?? null,
        createdAt: payload.createdAt ?? row.createdAt.toISOString(),
        ip: payload.ip ?? null,
        userAgent: payload.userAgent ?? null,
      };
    });

    if (search) {
      contacts = contacts.filter((c) => {
        const hay = [c.name, c.email, c.phone, c.businessName, c.message, c.source]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(search);
      });
    }

    const total = contacts.length;
    if (search) contacts = contacts.slice(0, take);

    res.json({ data: { contacts, total }, error: null });
  } catch (e) {
    next(e);
  }
}

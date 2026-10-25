/**
 * Platform control-plane settings singleton (PlatformSettings id=default).
 * Plan catalog is stored as planCatalog[] (dynamic create/update/delete).
 * Legacy planOverrides are migrated into the catalog on read.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { env } from "../config/env.js";
import { AppHttpError } from "./app-http-error.js";
import {
  DEFAULT_ALLOWED_TERMS,
  DEFAULT_PLAN_CATALOG,
  PLAN_CODE_REGEX,
  normalizePlanCode,
  parseAllowedTerms,
  parsePlanLimits,
  type DynamicPlanDefinition,
  type PlanCode,
  type PlanLimits,
  type PlanTemplate,
  type TermMonths,
} from "./plan-catalog.js";
import {
  getSubscriptionPricingConfigFromEnv,
  mergeSubscriptionPricingConfig,
  type SubscriptionPricingConfig,
  type SubscriptionPricingPatch,
} from "./subscription-pricing.js";

export const PLATFORM_SETTINGS_ID = "default";

export type PlanOverride = {
  planName?: string;
  limits?: PlanLimits;
  /** When false, plan is hidden from public website catalog. */
  publicVisible?: boolean;
  /** Term lengths (months) this plan may be sold on. */
  allowedTerms?: TermMonths[];
};

export type PlatformSettingsPayload = {
  trialDaysDefault?: number;
  defaultTermMonths?: number;
  defaultGstPercent?: number;
  defaultContactUsUrl?: string | null;
  defaultContactPhone?: string | null;
  defaultUpgradeUrl?: string | null;
  /** Dynamic plan definitions (source of truth). */
  planCatalog?: DynamicPlanDefinition[];
  /** @deprecated Migrated into planCatalog on read. */
  planOverrides?: Partial<Record<string, PlanOverride>>;
  /** Persisted subscription pricing (overrides env when set). */
  subscriptionPricing?: SubscriptionPricingPatch;
  /** Platform tax invoice settings (business entity, brand name, GST, bank details, template text). */
  invoiceSettings?: Record<string, unknown>;
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function parsePlanDefinition(raw: unknown): DynamicPlanDefinition | null {
  const entry = asRecord(raw);
  const codeRaw = typeof entry.planCode === "string" ? normalizePlanCode(entry.planCode) : "";
  if (!codeRaw || !PLAN_CODE_REGEX.test(codeRaw)) return null;
  const planName =
    typeof entry.planName === "string" && entry.planName.trim()
      ? entry.planName.trim()
      : codeRaw;
  return {
    planCode: codeRaw,
    planName,
    limits: parsePlanLimits(entry.limits),
    publicVisible: entry.publicVisible !== false,
    allowedTerms: parseAllowedTerms(entry.allowedTerms),
    isBuiltIn: entry.isBuiltIn === true,
  };
}

function parsePlanCatalog(raw: unknown): DynamicPlanDefinition[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DynamicPlanDefinition[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const plan = parsePlanDefinition(item);
    if (!plan || seen.has(plan.planCode)) continue;
    seen.add(plan.planCode);
    out.push(plan);
  }
  return out.length ? out : undefined;
}

function parseLegacyOverrides(raw: unknown): Partial<Record<string, PlanOverride>> {
  const planOverridesRaw = asRecord(raw);
  const planOverrides: Partial<Record<string, PlanOverride>> = {};
  for (const [codeRaw, value] of Object.entries(planOverridesRaw)) {
    const code = normalizePlanCode(codeRaw);
    if (!code) continue;
    const entry = asRecord(value);
    if (Object.keys(entry).length === 0) continue;
    const override: PlanOverride = {};
    if (typeof entry.planName === "string" && entry.planName.trim()) {
      override.planName = entry.planName.trim();
    }
    if (entry.limits !== undefined) {
      override.limits = parsePlanLimits(entry.limits);
    }
    if (typeof entry.publicVisible === "boolean") {
      override.publicVisible = entry.publicVisible;
    }
    if (entry.allowedTerms !== undefined) {
      override.allowedTerms = parseAllowedTerms(entry.allowedTerms);
    }
    if (
      override.planName !== undefined ||
      override.limits !== undefined ||
      override.publicVisible !== undefined ||
      override.allowedTerms !== undefined
    ) {
      planOverrides[code] = override;
    }
  }
  return planOverrides;
}

/** Build catalog from stored array or seed + legacy overrides. */
export function resolvePlanCatalog(
  planCatalog: DynamicPlanDefinition[] | undefined,
  planOverrides: Partial<Record<string, PlanOverride>> = {}
): DynamicPlanDefinition[] {
  const base =
    planCatalog && planCatalog.length > 0
      ? planCatalog.map((p) => ({
          ...p,
          limits: { ...p.limits },
          allowedTerms: parseAllowedTerms(p.allowedTerms),
        }))
      : DEFAULT_PLAN_CATALOG.map((p) => ({
          ...p,
          limits: { ...p.limits },
          allowedTerms: [...p.allowedTerms],
        }));

  const byCode = new Map(base.map((p) => [p.planCode, p]));
  for (const [code, override] of Object.entries(planOverrides)) {
    if (!override) continue;
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, {
        planCode: code,
        planName: override.planName?.trim() || code,
        limits: override.limits ?? { maxBranches: 1, maxStaff: 3 },
        publicVisible: override.publicVisible !== false,
        allowedTerms: override.allowedTerms
          ? parseAllowedTerms(override.allowedTerms)
          : [...DEFAULT_ALLOWED_TERMS],
        isBuiltIn: false,
      });
      continue;
    }
    byCode.set(code, {
      ...existing,
      planName: override.planName?.trim() || existing.planName,
      limits: override.limits
        ? { ...existing.limits, ...override.limits }
        : existing.limits,
      publicVisible:
        override.publicVisible !== undefined
          ? override.publicVisible
          : existing.publicVisible,
      allowedTerms:
        override.allowedTerms !== undefined
          ? parseAllowedTerms(override.allowedTerms)
          : parseAllowedTerms(existing.allowedTerms),
    });
  }
  return Array.from(byCode.values());
}

export function parsePlatformSettingsPayload(raw: unknown): PlatformSettingsPayload {
  const obj = asRecord(raw);
  const planOverrides = parseLegacyOverrides(obj.planOverrides);
  const planCatalog = parsePlanCatalog(obj.planCatalog);
  const subscriptionPricing = parseSubscriptionPricingPatch(obj.subscriptionPricing);

  const trialDaysDefault =
    typeof obj.trialDaysDefault === "number" && Number.isFinite(obj.trialDaysDefault)
      ? Math.min(90, Math.max(1, Math.floor(obj.trialDaysDefault)))
      : undefined;
  const defaultTermMonths =
    typeof obj.defaultTermMonths === "number" && [1, 3, 12, 24, 36, 60].includes(obj.defaultTermMonths)
      ? obj.defaultTermMonths
      : undefined;
  const defaultGstPercent =
    typeof obj.defaultGstPercent === "number" && Number.isFinite(obj.defaultGstPercent)
      ? Math.max(0, obj.defaultGstPercent)
      : undefined;

  return {
    trialDaysDefault,
    defaultTermMonths,
    defaultGstPercent,
    defaultContactUsUrl:
      obj.defaultContactUsUrl === null
        ? null
        : typeof obj.defaultContactUsUrl === "string"
          ? obj.defaultContactUsUrl
          : undefined,
    defaultContactPhone:
      obj.defaultContactPhone === null
        ? null
        : typeof obj.defaultContactPhone === "string"
          ? obj.defaultContactPhone
          : undefined,
    defaultUpgradeUrl:
      obj.defaultUpgradeUrl === null
        ? null
        : typeof obj.defaultUpgradeUrl === "string"
          ? obj.defaultUpgradeUrl
          : undefined,
    planCatalog,
    planOverrides: Object.keys(planOverrides).length ? planOverrides : undefined,
    subscriptionPricing,
    invoiceSettings:
      obj.invoiceSettings && typeof obj.invoiceSettings === "object" && !Array.isArray(obj.invoiceSettings)
        ? (obj.invoiceSettings as Record<string, unknown>)
        : undefined,
  };
}

function parseSubscriptionPricingPatch(raw: unknown): SubscriptionPricingPatch | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const patch: SubscriptionPricingPatch = {};
  if (typeof obj.currency === "string" && obj.currency.trim()) {
    patch.currency = obj.currency.trim();
  }
  if (typeof obj.gstPercent === "number" && Number.isFinite(obj.gstPercent)) {
    patch.gstPercent = Math.max(0, obj.gstPercent);
  }
  const terms = obj.termBasePrices;
  if (terms && typeof terms === "object" && !Array.isArray(terms)) {
    const t = terms as Record<string, unknown>;
    const termBasePrices: SubscriptionPricingPatch["termBasePrices"] = {};
    for (const m of [1, 3, 12, 24, 36, 60] as const) {
      const v = t[String(m)] ?? t[m as unknown as string];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) termBasePrices[m] = v;
    }
    if (Object.keys(termBasePrices).length) patch.termBasePrices = termBasePrices;
  }
  const mult = obj.planMultipliers;
  if (mult && typeof mult === "object" && !Array.isArray(mult)) {
    const m = mult as Record<string, unknown>;
    const planMultipliers: NonNullable<SubscriptionPricingPatch["planMultipliers"]> = {};
    for (const [codeRaw, v] of Object.entries(m)) {
      const code = normalizePlanCode(codeRaw);
      if (!code) continue;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) planMultipliers[code] = v;
    }
    if (Object.keys(planMultipliers).length) patch.planMultipliers = planMultipliers;
  }
  const addOnsRaw = obj.addOns;
  if (addOnsRaw && typeof addOnsRaw === "object" && !Array.isArray(addOnsRaw)) {
    const a = addOnsRaw as Record<string, unknown>;
    const addOns: NonNullable<SubscriptionPricingPatch["addOns"]> = {};
    for (const key of ["extraBranchPrice", "extraUserPrice", "onboardingFee", "referralDiscount"] as const) {
      const v = a[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) addOns[key] = v;
    }
    if (Object.keys(addOns).length) patch.addOns = addOns;
  }
  return Object.keys(patch).length ? patch : undefined;
}

export type ResolvedPlatformSettings = {
  trialDaysDefault: number;
  defaultTermMonths: number;
  defaultGstPercent: number;
  defaultContactUsUrl: string | null;
  defaultContactPhone: string | null;
  defaultUpgradeUrl: string | null;
  planCatalog: DynamicPlanDefinition[];
  /** Derived map for backward-compatible admin responses. */
  planOverrides: Partial<Record<string, PlanOverride>>;
  subscriptionPricing: SubscriptionPricingConfig;
  subscriptionPricingPatch: SubscriptionPricingPatch | null;
  invoiceSettings: Record<string, unknown> | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

function envContactPhone(): string | null {
  const v = process.env.DEFAULT_CONTACT_PHONE?.trim();
  return v || null;
}

function catalogToOverrides(catalog: DynamicPlanDefinition[]): Partial<Record<string, PlanOverride>> {
  const out: Partial<Record<string, PlanOverride>> = {};
  for (const p of catalog) {
    out[p.planCode] = {
      planName: p.planName,
      limits: p.limits,
      publicVisible: p.publicVisible,
      allowedTerms: parseAllowedTerms(p.allowedTerms),
    };
  }
  return out;
}

export function resolvePlatformSettings(
  payload: PlatformSettingsPayload,
  meta?: { updatedAt?: Date | null; updatedBy?: string | null }
): ResolvedPlatformSettings {
  const envPricing = getSubscriptionPricingConfigFromEnv();
  const hasPricingPatch = Boolean(payload.subscriptionPricing);
  const subscriptionPricing = mergeSubscriptionPricingConfig(
    envPricing,
    payload.subscriptionPricing,
    hasPricingPatch ? "platform_settings" : "environment"
  );
  const planCatalog = resolvePlanCatalog(payload.planCatalog, payload.planOverrides);
  return {
    trialDaysDefault: payload.trialDaysDefault ?? 14,
    defaultTermMonths: payload.defaultTermMonths ?? 12,
    defaultGstPercent:
      payload.subscriptionPricing?.gstPercent ??
      payload.defaultGstPercent ??
      18,
    defaultContactUsUrl:
      payload.defaultContactUsUrl !== undefined
        ? payload.defaultContactUsUrl
        : env.DEFAULT_CONTACT_US_URL ?? null,
    defaultContactPhone:
      payload.defaultContactPhone !== undefined
        ? payload.defaultContactPhone
        : envContactPhone(),
    defaultUpgradeUrl:
      payload.defaultUpgradeUrl !== undefined
        ? payload.defaultUpgradeUrl
        : env.DEFAULT_UPGRADE_URL ?? null,
    planCatalog,
    planOverrides: catalogToOverrides(planCatalog),
    subscriptionPricing,
    subscriptionPricingPatch: payload.subscriptionPricing ?? null,
    invoiceSettings: payload.invoiceSettings ?? null,
    updatedAt: meta?.updatedAt?.toISOString() ?? null,
    updatedBy: meta?.updatedBy ?? null,
  };
}

async function readRawPayload(): Promise<{
  payload: PlatformSettingsPayload;
  updatedAt: Date | null;
  updatedBy: string | null;
}> {
  const row = await prisma.platformSettings.findUnique({
    where: { id: PLATFORM_SETTINGS_ID },
  });
  return {
    payload: parsePlatformSettingsPayload(row?.payload ?? {}),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

async function writePayload(
  next: PlatformSettingsPayload,
  updatedBy: string
): Promise<ResolvedPlatformSettings> {
  const row = await prisma.platformSettings.upsert({
    where: { id: PLATFORM_SETTINGS_ID },
    create: {
      id: PLATFORM_SETTINGS_ID,
      payload: next as Prisma.InputJsonValue,
      updatedBy,
    },
    update: {
      payload: next as Prisma.InputJsonValue,
      updatedBy,
    },
  });
  return resolvePlatformSettings(parsePlatformSettingsPayload(row.payload), {
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  });
}

export async function getPlatformSettings(): Promise<ResolvedPlatformSettings> {
  const { payload, updatedAt, updatedBy } = await readRawPayload();
  return resolvePlatformSettings(payload, { updatedAt, updatedBy });
}

export async function updatePlatformSettings(input: {
  patch: PlatformSettingsPayload;
  updatedBy: string;
}): Promise<ResolvedPlatformSettings> {
  const { payload: currentPayload } = await readRawPayload();
  const currentCatalog = resolvePlanCatalog(
    currentPayload.planCatalog,
    currentPayload.planOverrides
  );

  let nextCatalog = currentCatalog;
  if (input.patch.planCatalog) {
    nextCatalog = resolvePlanCatalog(input.patch.planCatalog, {});
  } else if (input.patch.planOverrides) {
    nextCatalog = resolvePlanCatalog(currentCatalog, input.patch.planOverrides);
  }

  const next: PlatformSettingsPayload = {
    ...currentPayload,
    ...input.patch,
    planCatalog: nextCatalog,
    planOverrides: undefined,
  };

  if (input.patch.subscriptionPricing) {
    next.subscriptionPricing = {
      ...(currentPayload.subscriptionPricing ?? {}),
      ...input.patch.subscriptionPricing,
      termBasePrices: {
        ...(currentPayload.subscriptionPricing?.termBasePrices ?? {}),
        ...(input.patch.subscriptionPricing.termBasePrices ?? {}),
      },
      planMultipliers: {
        ...(currentPayload.subscriptionPricing?.planMultipliers ?? {}),
        ...(input.patch.subscriptionPricing.planMultipliers ?? {}),
      },
      addOns: {
        ...(currentPayload.subscriptionPricing?.addOns ?? {}),
        ...(input.patch.subscriptionPricing.addOns ?? {}),
      },
    };
  }

  return writePayload(next, input.updatedBy);
}

export type EffectivePlanTemplate = PlanTemplate & {
  publicVisible: boolean;
  allowedTerms: TermMonths[];
};

export function getEffectivePlanCatalog(
  planCatalogOrOverrides:
    | DynamicPlanDefinition[]
    | Partial<Record<string, PlanOverride>> = {}
): EffectivePlanTemplate[] {
  const catalog = Array.isArray(planCatalogOrOverrides)
    ? planCatalogOrOverrides
    : resolvePlanCatalog(undefined, planCatalogOrOverrides);
  return catalog.map((p) => ({
    planCode: p.planCode,
    planName: p.planName,
    limits: { ...p.limits },
    publicVisible: p.publicVisible !== false,
    allowedTerms: parseAllowedTerms(p.allowedTerms),
  }));
}

export async function getEffectivePlanCatalogFromDb(): Promise<EffectivePlanTemplate[]> {
  const settings = await getPlatformSettings();
  return getEffectivePlanCatalog(settings.planCatalog);
}

export async function getPlanTemplate(code: string): Promise<PlanTemplate | null> {
  const normalized = normalizePlanCode(code);
  const catalog = await getEffectivePlanCatalogFromDb();
  const plan = catalog.find((p) => p.planCode === normalized);
  if (!plan) return null;
  return {
    planCode: plan.planCode,
    planName: plan.planName,
    limits: plan.limits,
  };
}

export async function getResolvedSubscriptionPricing(): Promise<SubscriptionPricingConfig> {
  const settings = await getPlatformSettings();
  return settings.subscriptionPricing;
}

export type CreatePlanInput = {
  planCode: string;
  planName: string;
  limits?: PlanLimits;
  publicVisible?: boolean;
  allowedTerms?: TermMonths[];
  multiplier?: number;
};

export async function createPlatformPlan(
  input: CreatePlanInput,
  updatedBy: string
): Promise<ResolvedPlatformSettings> {
  const code = normalizePlanCode(input.planCode);
  if (!PLAN_CODE_REGEX.test(code)) {
    throw new AppHttpError(
      400,
      "Plan code must be 2–24 chars: uppercase letters, numbers, underscores (e.g. PRO_PLUS).",
      "INVALID_PLAN_CODE"
    );
  }
  const name = input.planName.trim();
  if (!name) {
    throw new AppHttpError(400, "Plan name is required.", "INVALID_PLAN_NAME");
  }

  const { payload } = await readRawPayload();
  const catalog = resolvePlanCatalog(payload.planCatalog, payload.planOverrides);
  if (catalog.some((p) => p.planCode === code)) {
    throw new AppHttpError(409, `Plan ${code} already exists.`, "PLAN_EXISTS");
  }

  const nextPlan: DynamicPlanDefinition = {
    planCode: code,
    planName: name,
    limits: parsePlanLimits(input.limits ?? { maxBranches: 1, maxStaff: 3 }),
    publicVisible: input.publicVisible !== false,
    allowedTerms: parseAllowedTerms(input.allowedTerms ?? DEFAULT_ALLOWED_TERMS),
    isBuiltIn: false,
  };

  const pricingPatch: SubscriptionPricingPatch = {
    ...(payload.subscriptionPricing ?? {}),
    planMultipliers: {
      ...(payload.subscriptionPricing?.planMultipliers ?? {}),
      ...(typeof input.multiplier === "number" && Number.isFinite(input.multiplier)
        ? { [code]: Math.max(0, input.multiplier) }
        : { [code]: 1 }),
    },
  };

  return writePayload(
    {
      ...payload,
      planCatalog: [...catalog, nextPlan],
      planOverrides: undefined,
      subscriptionPricing: pricingPatch,
    },
    updatedBy
  );
}

export type UpdatePlanInput = {
  planName?: string;
  limits?: PlanLimits;
  publicVisible?: boolean;
  allowedTerms?: TermMonths[];
  multiplier?: number;
};

export async function updatePlatformPlan(
  planCode: string,
  input: UpdatePlanInput,
  updatedBy: string
): Promise<ResolvedPlatformSettings> {
  const code = normalizePlanCode(planCode);
  const { payload } = await readRawPayload();
  const catalog = resolvePlanCatalog(payload.planCatalog, payload.planOverrides);
  const idx = catalog.findIndex((p) => p.planCode === code);
  if (idx < 0) {
    throw new AppHttpError(404, `Plan ${code} not found.`, "PLAN_NOT_FOUND");
  }

  const current = catalog[idx];
  const next = [...catalog];
  next[idx] = {
    ...current,
    planName:
      input.planName !== undefined
        ? input.planName.trim() || current.planName
        : current.planName,
    limits:
      input.limits !== undefined
        ? parsePlanLimits({ ...current.limits, ...input.limits })
        : current.limits,
    publicVisible:
      input.publicVisible !== undefined ? input.publicVisible : current.publicVisible,
    allowedTerms:
      input.allowedTerms !== undefined
        ? parseAllowedTerms(input.allowedTerms)
        : parseAllowedTerms(current.allowedTerms),
  };

  let pricingPatch = payload.subscriptionPricing;
  if (typeof input.multiplier === "number" && Number.isFinite(input.multiplier)) {
    pricingPatch = {
      ...(payload.subscriptionPricing ?? {}),
      planMultipliers: {
        ...(payload.subscriptionPricing?.planMultipliers ?? {}),
        [code]: Math.max(0, input.multiplier),
      },
    };
  }

  return writePayload(
    {
      ...payload,
      planCatalog: next,
      planOverrides: undefined,
      subscriptionPricing: pricingPatch,
    },
    updatedBy
  );
}

export async function deletePlatformPlan(
  planCode: string,
  updatedBy: string
): Promise<ResolvedPlatformSettings> {
  const code = normalizePlanCode(planCode);
  const { payload } = await readRawPayload();
  const catalog = resolvePlanCatalog(payload.planCatalog, payload.planOverrides);
  if (!catalog.some((p) => p.planCode === code)) {
    throw new AppHttpError(404, `Plan ${code} not found.`, "PLAN_NOT_FOUND");
  }

  const inUse = await prisma.organizationSubscription.count({
    where: { planCode: code },
  });
  if (inUse > 0) {
    throw new AppHttpError(
      409,
      `Cannot delete ${code}: ${inUse} organization(s) still use this plan. Reassign them first, or hide the plan from the website.`,
      "PLAN_IN_USE"
    );
  }

  const nextCatalog = catalog.filter((p) => p.planCode !== code);
  if (nextCatalog.length === 0) {
    throw new AppHttpError(400, "Cannot delete the last plan.", "LAST_PLAN");
  }

  const multipliers = { ...(payload.subscriptionPricing?.planMultipliers ?? {}) };
  delete multipliers[code];

  return writePayload(
    {
      ...payload,
      planCatalog: nextCatalog,
      planOverrides: undefined,
      subscriptionPricing: {
        ...(payload.subscriptionPricing ?? {}),
        planMultipliers: multipliers,
      },
    },
    updatedBy
  );
}

export type { PlanCode };

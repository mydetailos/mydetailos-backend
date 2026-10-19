/**
 * Customer-portal bootstrap: single call returning all data the portal needs.
 * `customerId`/`organizationId` are always taken from the verified JWT (`req.auth`),
 * never from request params — see `customer-bootstrap.controller.ts`.
 */
import { prisma } from "../../lib/prisma.js";
import { SINGLETON_ENTITY_ID } from "../../constants/json-collections.js";
import { toApiCustomer } from "./customer.service.js";

export interface CustomerRewardConfig {
  pointsPer100: number;
  pointValue: number;
  referralBonus: number;
  minRedeem: number;
}

const DEFAULT_REWARD_CONFIG: CustomerRewardConfig = {
  pointsPer100: 1,
  pointValue: 0.25,
  referralBonus: 100,
  minRedeem: 200,
};

async function readArrayCollectionForCustomer(
  collection: string,
  organizationId: string,
  customerId: string
): Promise<unknown[]> {
  const rows = await prisma.appJsonRow.findMany({
    where: { collection, organizationId },
    select: { payload: true },
  });
  return rows
    .map((r) => r.payload as Record<string, unknown>)
    .filter((p) => p.customerId === customerId);
}

async function readRewardConfig(organizationId: string): Promise<CustomerRewardConfig> {
  const row = await prisma.appJsonRow.findFirst({
    where: {
      collection: "customerRewardSettings",
      entityId: SINGLETON_ENTITY_ID,
      organizationId,
    },
    select: { payload: true },
  });
  const payload = (row?.payload as Partial<CustomerRewardConfig> | undefined) ?? {};
  return {
    pointsPer100: payload.pointsPer100 ?? DEFAULT_REWARD_CONFIG.pointsPer100,
    pointValue: payload.pointValue ?? DEFAULT_REWARD_CONFIG.pointValue,
    referralBonus: payload.referralBonus ?? DEFAULT_REWARD_CONFIG.referralBonus,
    minRedeem: payload.minRedeem ?? DEFAULT_REWARD_CONFIG.minRedeem,
  };
}

async function readMembershipsForCustomer(
  organizationId: string,
  customerId: string,
  customerInvoices?: unknown[],
  customerJobCards?: unknown[],
  customerVehicles?: unknown[]
): Promise<unknown[]> {
  // 1. Fetch invoices, jobCards, vehicles if not passed
  const [invoices, jobCards, vehicles] = await Promise.all([
    customerInvoices !== undefined
      ? Promise.resolve(customerInvoices)
      : readArrayCollectionForCustomer("invoices", organizationId, customerId),
    customerJobCards !== undefined
      ? Promise.resolve(customerJobCards)
      : readArrayCollectionForCustomer("jobCards", organizationId, customerId),
    customerVehicles !== undefined
      ? Promise.resolve(customerVehicles)
      : prisma.vehicle.findMany({ where: { customerId, organizationId } }),
  ]);

  // 2. Fetch membership singleton documents (both 'membership' and 'memberships' collections)
  const rows = await prisma.appJsonRow.findMany({
    where: {
      collection: { in: ["membership", "memberships"] },
      organizationId,
    },
    select: { entityId: true, payload: true },
  });

  const packageNameById = new Map<string, string>();
  const packagePriceById = new Map<string, number>();
  const rawSubscriptions: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const payload = r.payload as { packages?: unknown[]; subscriptions?: unknown[] } | undefined;
    if (!payload || typeof payload !== "object") continue;

    if (Array.isArray(payload.packages)) {
      for (const pkg of payload.packages) {
        if (!pkg || typeof pkg !== "object") continue;
        const p = pkg as Record<string, unknown>;
        if (typeof p.id === "string") {
          if (typeof p.name === "string") {
            packageNameById.set(p.id, p.name);
          }
          if (typeof p.price === "number") {
            packagePriceById.set(p.id, p.price);
          }
        }
      }
    }

    if (Array.isArray(payload.subscriptions)) {
      for (const sub of payload.subscriptions) {
        if (sub && typeof sub === "object") {
          const s = sub as Record<string, unknown>;
          if (s.customerId === customerId) {
            rawSubscriptions.push(s);
          }
        }
      }
    }
  }

  // 3. Also check standalone rows in customerMemberships or memberships collections
  const standaloneRows = await prisma.appJsonRow.findMany({
    where: {
      collection: { in: ["customerMemberships", "customerMembership"] },
      organizationId,
    },
    select: { payload: true },
  });
  for (const r of standaloneRows) {
    if (r.payload && typeof r.payload === "object") {
      const s = r.payload as Record<string, unknown>;
      if (s.customerId === customerId) {
        rawSubscriptions.push(s);
      }
    }
  }

  // 4. Index by id and enrich
  const membershipsById = new Map<string, Record<string, unknown>>();

  for (const sub of rawSubscriptions) {
    const id = typeof sub.id === "string" && sub.id.trim() ? sub.id.trim() : `mem-${Date.now()}`;
    const embeddedPackage = sub.package;
    const embeddedPackageName =
      embeddedPackage && typeof embeddedPackage === "object"
        ? (embeddedPackage as Record<string, unknown>).name
        : undefined;
    const resolvedPackageName =
      typeof embeddedPackageName === "string"
        ? embeddedPackageName
        : typeof sub.packageName === "string" && sub.packageName.trim()
          ? sub.packageName.trim()
          : typeof sub.packageId === "string"
            ? packageNameById.get(sub.packageId) ?? null
            : null;

    const resolvedPrice =
      typeof sub.price === "number"
        ? sub.price
        : typeof sub.packageId === "string"
          ? packagePriceById.get(sub.packageId)
          : undefined;

    // Check status expiration
    let status = typeof sub.status === "string" ? sub.status : "ACTIVE";
    if (status === "ACTIVE" && typeof sub.endDate === "string" && sub.endDate) {
      const endMs = new Date(sub.endDate).getTime();
      if (!isNaN(endMs) && endMs < Date.now()) {
        status = "EXPIRED";
      }
    }

    const rawUsage = Array.isArray(sub.usageHistory) ? (sub.usageHistory as Array<Record<string, unknown>>) : [];
    const usageHistory = rawUsage.map((u) => {
      if (!u || typeof u !== "object") return u;
      return {
        ...u,
        membershipId:
          typeof u.membershipId === "string" && u.membershipId.trim()
            ? u.membershipId.trim()
            : id,
      };
    });

    membershipsById.set(id, {
      ...sub,
      id,
      status,
      packageName: resolvedPackageName,
      price: resolvedPrice,
      usageHistory,
    });
  }

  // 5. Synthesize / fallback from customer invoices (source === "MEMBERSHIP", membershipId, membershipPackageName)
  const castInvoices = invoices as Array<Record<string, any>>;
  const castVehicles = vehicles as Array<Record<string, any>>;
  const castJobCards = jobCards as Array<Record<string, any>>;

  for (const inv of castInvoices) {
    const isMembershipInvoice =
      inv.source === "MEMBERSHIP" ||
      Boolean(inv.membershipId) ||
      Boolean(inv.membershipPackageName);

    if (isMembershipInvoice) {
      const memId = inv.membershipId || `mem-${inv.id}`;
      const start = inv.membershipStartDate || inv.createdAt;
      const end =
        inv.membershipEndDate ||
        (start ? new Date(new Date(start).setFullYear(new Date(start).getFullYear() + 1)).toISOString() : null);
      const isExpired = end ? new Date(end).getTime() < Date.now() : false;

      const matchedVeh = castVehicles.find(
        (v) =>
          (inv.vehicleRegNumber && inv.vehicleRegNumber !== "—" && v.registrationNumber === inv.vehicleRegNumber) ||
          (inv.vehicleMakeModel && `${v.make} ${v.model}`.toLowerCase() === String(inv.vehicleMakeModel).toLowerCase())
      );

      const existing = membershipsById.get(memId);
      if (existing) {
        if (!existing.invoiceId) existing.invoiceId = inv.id;
        if (existing.price === undefined && typeof inv.grandTotal === "number") existing.price = inv.grandTotal;
        if (!existing.packageName && inv.membershipPackageName) existing.packageName = inv.membershipPackageName;
        if (!existing.vehicleId && matchedVeh?.id) existing.vehicleId = matchedVeh.id;
      } else {
        membershipsById.set(memId, {
          id: memId,
          customerId,
          packageId: inv.membershipPackageId || inv.membershipPackageName || "MEMBERSHIP",
          packageName: inv.membershipPackageName || inv.lineItems?.[0]?.description || "Service Plan",
          startDate: start,
          endDate: end,
          status: isExpired ? "EXPIRED" : "ACTIVE",
          invoiceId: inv.id,
          price: typeof inv.grandTotal === "number" ? inv.grandTotal : undefined,
          vehicleId: matchedVeh?.id,
          usageHistory: [],
        });
      }
    }
  }

  // 6. Synthesize from job cards with membership activation
  for (const job of castJobCards) {
    if (job.membershipActivationId || job.membershipActivationPackageName) {
      const memId = job.membershipActivationId || `mem-job-${job.id}`;
      const start = job.membershipActivationStartDate || job.createdAt;
      const end =
        job.membershipActivationEndDate ||
        (start ? new Date(new Date(start).setFullYear(new Date(start).getFullYear() + 1)).toISOString() : null);
      const isExpired = end ? new Date(end).getTime() < Date.now() : false;

      const existing = membershipsById.get(memId);
      if (existing) {
        if (!existing.vehicleId && job.vehicleId) existing.vehicleId = job.vehicleId;
        if (!existing.packageName && job.membershipActivationPackageName) existing.packageName = job.membershipActivationPackageName;
      } else {
        membershipsById.set(memId, {
          id: memId,
          customerId,
          packageId: job.membershipActivationPackageId || "MEMBERSHIP",
          packageName: job.membershipActivationPackageName || "Service Plan",
          startDate: start,
          endDate: end,
          status: isExpired ? "EXPIRED" : "ACTIVE",
          vehicleId: job.vehicleId,
          usageHistory: [],
        });
      }
    }
  }

  // 7. Final enrichment pass: cross-reference any still-missing invoiceId, price, vehicleId
  for (const mem of membershipsById.values()) {
    const matchedInv = castInvoices.find(
      (inv) => inv.id === mem.invoiceId || (inv.membershipId && inv.membershipId === mem.id)
    );
    if (matchedInv) {
      if (!mem.invoiceId) mem.invoiceId = matchedInv.id;
      if (mem.price === undefined && typeof matchedInv.grandTotal === "number") mem.price = matchedInv.grandTotal;
      if (!mem.packageName && matchedInv.membershipPackageName) mem.packageName = matchedInv.membershipPackageName;
      if (!mem.vehicleId && matchedInv.vehicleRegNumber && matchedInv.vehicleRegNumber !== "—") {
        const v = castVehicles.find((veh) => veh.registrationNumber === matchedInv.vehicleRegNumber);
        if (v) mem.vehicleId = v.id;
      }
    }

    if (!mem.packageName) {
      mem.packageName = "Service Plan";
    }
  }

  return Array.from(membershipsById.values());
}

export interface CustomerBootstrapPayload {
  customer: ReturnType<typeof toApiCustomer>;
  jobCards: unknown[];
  invoices: unknown[];
  vehicles: unknown[];
  memberships: unknown[];
  subscriptions: unknown[];
  customerMemberships: unknown[];
  walletTransactions: unknown[];
  rewardConfig: CustomerRewardConfig;
}

export async function getCustomerBootstrapPayload(
  customerId: string,
  organizationId: string
): Promise<CustomerBootstrapPayload | null> {
  const customerRow = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
  });
  if (!customerRow) return null;

  const [jobCards, invoices, vehicles, walletTransactions, rewardConfig] =
    await Promise.all([
      readArrayCollectionForCustomer("jobCards", organizationId, customerId),
      readArrayCollectionForCustomer("invoices", organizationId, customerId),
      prisma.vehicle.findMany({ where: { customerId, organizationId } }),
      readArrayCollectionForCustomer("walletTransactions", organizationId, customerId),
      readRewardConfig(organizationId),
    ]);

  const memberships = await readMembershipsForCustomer(
    organizationId,
    customerId,
    invoices,
    jobCards,
    vehicles
  );

  return {
    customer: toApiCustomer(customerRow),
    jobCards,
    invoices,
    vehicles,
    memberships,
    subscriptions: memberships,
    customerMemberships: memberships,
    walletTransactions,
    rewardConfig,
  };
}

export async function getCustomerMembershipsPayload(
  customerId: string,
  organizationId: string
): Promise<unknown[]> {
  return readMembershipsForCustomer(organizationId, customerId);
}

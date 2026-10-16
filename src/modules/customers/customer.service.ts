import type { Customer as CustomerRow } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import { REFERRAL_EXISTING_CUSTOMER_MESSAGE } from "../../lib/referral-eligibility.js";
import { generateCustomerPassword } from "../../lib/generate-password.js";

async function resolveAdvocateReferralCode(
  organizationId: string,
  referredBy: string | undefined | null
): Promise<string | null> {
  const code = referredBy?.trim().toUpperCase() || "";
  if (!code) return null;
  const advocate = await prisma.customer.findFirst({
    where: {
      organizationId,
      referralCode: { equals: code, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (!advocate) {
    throw AppError.validation("Invalid referral code.");
  }
  return code;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export function toApiCustomer(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    referralCode: row.referralCode,
    referredBy: row.referredBy ?? undefined,
    totalVisits: row.totalVisits,
    rewardPoints: row.rewardPoints,
    walletBalance: row.walletBalance,
    lastVisitDate: row.lastVisitDate ?? undefined,
    notes: row.notes ?? undefined,
    isInactive: row.isInactive || undefined,
    emailVerified: row.emailVerified || undefined,
    avatar: row.avatar ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listCustomers(opts?: {
  organizationId: string;
  customerIds?: Set<string> | null;
  page?: number;
  pageSize?: number;
}) {
  if (!opts?.organizationId) return [];
  if (opts.customerIds && opts.customerIds.size === 0) {
    return [];
  }
  const where = {
    organizationId: opts.organizationId,
    ...(opts.customerIds && opts.customerIds.size > 0
      ? { id: { in: [...opts.customerIds] } }
      : {}),
  };

  if (opts.page && opts.pageSize) {
    const total = await prisma.customer.count({ where });
    const rows = await prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    });
    return {
      items: rows.map(toApiCustomer),
      page: opts.page,
      pageSize: opts.pageSize,
      total,
      totalPages: Math.ceil(total / opts.pageSize)
    };
  }

  const rows = await prisma.customer.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toApiCustomer);
}

export async function getCustomerById(id: string, organizationId: string) {
  const row = await prisma.customer.findFirst({ where: { id, organizationId } });
  return row ? toApiCustomer(row) : null;
}

export async function createCustomer(data: {
  organizationId: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  referralCode: string;
  referredBy?: string | null;
  totalVisits?: number;
  rewardPoints?: number;
  walletBalance?: number;
  lastVisitDate?: string;
  notes?: string;
  isInactive?: boolean;
  emailVerified?: boolean;
  /** Explicit password bypasses the fallback generation (used when creating a customer from the SaaS Admin panel or Studio with an explicit initial password). */
  password?: string;
  /** Staff `User.id` setting the password, when tracked. */
  passwordCreatedBy?: string;
  createdByUserId?: string;
  updatedByUserId?: string;
}): Promise<{ customer: ReturnType<typeof toApiCustomer>; temporaryPassword?: string }> {
  const norm = normalizePhone(data.phone);
  if (norm.length === 10) {
    const clash = await prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM "Customer" 
      WHERE "organizationId" = ${data.organizationId} 
        AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ${norm}
      LIMIT 1
    `;
    if (Array.isArray(clash) && clash.length > 0) throw new Error("Phone already in use");
  }

  const referredBy = await resolveAdvocateReferralCode(data.organizationId, data.referredBy);

  const id = `cust-${randomBytes(4).toString("hex")}`;
  const createdAt = new Date();

  /**
   * Every new customer gets portal login credentials: use the admin-provided
   * password when given, otherwise auto-generate a deterministic default
   * (first 4 letters of name + first 4 digits of phone, e.g. "AMAR7004")
   * sent via WhatsApp by the caller — see `customer-credentials-notify.service.ts`.
   */
  const useExplicitPassword = Boolean(data.password);
  const plainPassword = useExplicitPassword
    ? data.password!
    : generateCustomerPassword(data.name, data.phone);
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const row = await prisma.customer.create({
    data: {
      id,
      organizationId: data.organizationId,
      name: data.name.trim(),
      phone: data.phone.trim(),
      email: data.email.trim(),
      address: data.address.trim(),
      referralCode: data.referralCode.trim(),
      referredBy,
      totalVisits: data.totalVisits ?? 0,
      rewardPoints: data.rewardPoints ?? 0,
      walletBalance: data.walletBalance ?? 0,
      lastVisitDate: data.lastVisitDate?.trim() || null,
      notes: data.notes?.trim() || null,
      isInactive: data.isInactive ?? false,
      emailVerified: data.emailVerified ?? false,
      createdAt,
      passwordHash,
      passwordCreatedBy: data.passwordCreatedBy || null,
      createdByUserId: data.createdByUserId || null,
      updatedByUserId: data.updatedByUserId || null,
    },
  });

  if (data.createdByUserId) {
    const { logBusinessActivity } = await import("../../services/activity-logger.service.js");
    await logBusinessActivity({ organizationId: data.organizationId, hasJobCardPricingPermission: false, userId: data.createdByUserId }, {
      action: "CREATE_CUSTOMER",
      entityType: "CUSTOMER",
      entityId: id,
    });
  }

  return {
    customer: toApiCustomer(row),
    temporaryPassword: plainPassword,
  };
}

export async function updateCustomer(
  id: string,
  organizationId: string,
  data: Partial<{
    name: string;
    phone: string;
    email: string;
    address: string;
    referralCode: string;
    referredBy: string | null;
    totalVisits: number;
    rewardPoints: number;
    walletBalance: number;
    lastVisitDate: string | null;
    notes: string | null;
    isInactive: boolean;
    emailVerified: boolean;
    avatar: string | null;
    /** Customer-portal login password reset by admin/staff. */
    password: string;
    /** Staff `User.id` setting the password, when tracked. */
    passwordCreatedBy: string;
    updatedByUserId: string;
  }>
) {
  if (data.phone !== undefined) {
    const norm = normalizePhone(data.phone);
    if (norm.length === 10) {
      const clash = await prisma.$queryRaw<unknown[]>`
        SELECT 1 FROM "Customer" 
        WHERE "organizationId" = ${organizationId} 
          AND "id" != ${id}
          AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ${norm}
        LIMIT 1
      `;
      if (Array.isArray(clash) && clash.length > 0) throw new Error("Phone already in use");
    }
  }

  const current = await prisma.customer.findFirst({ where: { id, organizationId } });
  if (!current) return null;

  if (data.referredBy !== undefined) {
    const next = data.referredBy === null ? "" : data.referredBy.trim();
    const currentVal = current.referredBy?.trim() || "";
    if (next && !currentVal) {
      throw AppError.validation(REFERRAL_EXISTING_CUSTOMER_MESSAGE);
    }
    if (next && currentVal && next.toUpperCase() !== currentVal.toUpperCase()) {
      throw AppError.validation("Referral code cannot be changed after customer creation.");
    }
  }

  const row = await prisma.customer.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name.trim() }),
      ...(data.phone !== undefined && { phone: data.phone.trim() }),
      ...(data.email !== undefined && { email: data.email.trim() }),
      ...(data.address !== undefined && { address: data.address.trim() }),
      ...(data.referralCode !== undefined && { referralCode: data.referralCode.trim() }),
      ...(data.referredBy !== undefined && {
        referredBy: current.referredBy,
      }),
      ...(data.totalVisits !== undefined && { totalVisits: data.totalVisits }),
      ...(data.rewardPoints !== undefined && { rewardPoints: data.rewardPoints }),
      ...(data.walletBalance !== undefined && { walletBalance: data.walletBalance }),
      ...(data.lastVisitDate !== undefined && { lastVisitDate: data.lastVisitDate }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.isInactive !== undefined && { isInactive: data.isInactive }),
      ...(data.emailVerified !== undefined && { emailVerified: data.emailVerified }),
      ...(data.avatar !== undefined && { avatar: data.avatar ?? null }),
      ...(data.password !== undefined && {
        passwordHash: await bcrypt.hash(data.password, 10),
        passwordCreatedBy: data.passwordCreatedBy ?? null,
        passwordUpdatedAt: new Date(),
      }),
      ...(data.updatedByUserId !== undefined && { updatedByUserId: data.updatedByUserId }),
    },
  });

  if (data.updatedByUserId) {
    const { logBusinessActivity } = await import("../../services/activity-logger.service.js");
    await logBusinessActivity({ organizationId, hasJobCardPricingPermission: false, userId: data.updatedByUserId }, {
      action: "UPDATE_CUSTOMER",
      entityType: "CUSTOMER",
      entityId: id,
    });
  }

  return toApiCustomer(row);
}

export async function deleteCustomer(id: string, organizationId: string, userId?: string) {
  const owned = await prisma.customer.findFirst({ where: { id, organizationId } });
  if (!owned) return false;
  await prisma.vehicle.deleteMany({ where: { customerId: id, organizationId } });
  try {
    await prisma.customer.delete({ where: { id } });
    if (userId) {
      const { logBusinessActivity } = await import("../../services/activity-logger.service.js");
      await logBusinessActivity({ organizationId, hasJobCardPricingPermission: false, userId }, {
        action: "DELETE_CUSTOMER",
        entityType: "CUSTOMER",
        entityId: id,
      });
    }
  } catch {
    return false;
  }
  return true;
}

export async function adjustWallet(
  customerId: string,
  organizationId: string,
  amount: number,
  type: "CREDIT" | "DEBIT",
  reason: string
) {
  if (amount <= 0 || !Number.isFinite(amount)) throw new Error("Invalid amount");

  return await prisma.$transaction(async (tx) => {
    const current = await tx.customer.findFirst({ where: { id: customerId, organizationId } });
    if (!current) return null;

    let newBalance = current.walletBalance;
    if (type === "CREDIT") {
      newBalance = Math.round((newBalance + amount) * 100) / 100;
    } else {
      newBalance = Math.round((newBalance - amount) * 100) / 100;
      if (newBalance < 0) {
        throw new Error("Wallet balance cannot be negative");
      }
    }

    // Update customer balance
    const updatedCustomer = await tx.customer.update({
      where: { id: customerId },
      data: { walletBalance: newBalance },
    });

    // Create wallet transaction record
    const txId = `wtx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const transaction = {
      id: txId,
      customerId,
      customerName: current.name,
      type,
      amount,
      source: "ADMIN_CREDIT" as const,
      description: reason,
      balanceAfter: newBalance,
      createdAt: new Date().toISOString(),
    };

    // Save transaction in AppJsonRow
    await tx.appJsonRow.create({
      data: {
        collection: "walletTransactions",
        entityId: txId,
        organizationId,
        payload: transaction as any,
      },
    });

    return toApiCustomer(updatedCustomer);
  });
}

export async function creditWallet(
  customerId: string,
  organizationId: string,
  amount: number
) {
  return adjustWallet(customerId, organizationId, amount, "CREDIT", "Referral Reward");
}

function generateReferralCode(): string {
  return `REF-${randomBytes(2).toString("hex").toUpperCase()}`;
}

export type BulkCustomerInput = {
  name: string;
  phone: string;
  email?: string;
  address?: string;
};

export type BulkCustomerSkipped = {
  index: number;
  name: string;
  phone: string;
  reason: "DUPLICATE" | "INVALID" | "DUPLICATE_IN_BATCH";
  message: string;
};

/**
 * Creates many customers in one pass. Skips rows that clash on last-10 phone digits
 * (existing DB or earlier rows in this batch). Does not update existing customers.
 */
export async function createCustomersBulk(
  organizationId: string,
  inputs: BulkCustomerInput[]
): Promise<{
  created: ReturnType<typeof toApiCustomer>[];
  skipped: BulkCustomerSkipped[];
}> {
  const existing = await prisma.customer.findMany({
    where: { organizationId },
    select: { phone: true },
  });
  const usedPhones = new Set(
    existing
      .map((c) => normalizePhone(c.phone))
      .filter((p) => p.length === 10)
  );

  const skipped: BulkCustomerSkipped[] = [];
  const toCreate: Array<{
    id: string;
    organizationId: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    referralCode: string;
    createdAt: Date;
  }> = [];

  for (let index = 0; index < inputs.length; index++) {
    const raw = inputs[index]!;
    const name = (raw.name ?? "").trim();
    const phone = (raw.phone ?? "").trim();
    const email = (raw.email ?? "").trim();
    const address = (raw.address ?? "").trim();
    const norm = normalizePhone(phone);

    if (!name || norm.length !== 10) {
      skipped.push({
        index,
        name,
        phone,
        reason: "INVALID",
        message: !name ? "Name is required" : "Phone must contain 10 digits",
      });
      continue;
    }

    if (usedPhones.has(norm)) {
      const alreadyInBatch = toCreate.some((c) => normalizePhone(c.phone) === norm);
      skipped.push({
        index,
        name,
        phone,
        reason: alreadyInBatch ? "DUPLICATE_IN_BATCH" : "DUPLICATE",
        message: alreadyInBatch
          ? "Duplicate phone in this import batch"
          : "Phone already in use",
      });
      continue;
    }

    usedPhones.add(norm);
    toCreate.push({
      id: `cust-${randomBytes(4).toString("hex")}`,
      organizationId,
      name,
      phone,
      email,
      address,
      referralCode: generateReferralCode(),
      createdAt: new Date(),
    });
  }

  if (toCreate.length === 0) {
    return { created: [], skipped };
  }

  await prisma.customer.createMany({ data: toCreate });
  const ids = toCreate.map((c) => c.id);
  const rows = await prisma.customer.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "desc" },
  });

  return { created: rows.map(toApiCustomer), skipped };
}

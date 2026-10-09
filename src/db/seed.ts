import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, UserRole } from "../lib/prisma-client.js";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(__dirname, "../../prisma/seed-data.json"), "utf8");

type SeedFile = {
  branches: {
    id: string;
    name: string;
    address: string;
    phone: string;
    isActive: boolean;
    qrCodeId?: string;
    code?: string;
    city?: string;
    state?: string;
    pincode?: string;
    email?: string;
    managerName?: string;
    managerPhone?: string;
  }[];
  staff: {
    id: string;
    name: string;
    email: string;
    phone: string;
    role: string;
    branchId: string;
    avatar?: string;
    isActive: boolean;
    emailVerified?: boolean;
    attendancePin?: string;
    totalJobsCompleted?: number;
    totalIncentiveEarned?: number;
    birthday?: string;
    anniversary?: string;
  }[];
  customers: {
    id: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    referralCode: string;
    referredBy?: string;
    totalVisits: number;
    rewardPoints: number;
    walletBalance: number;
    lastVisitDate?: string;
    isInactive?: boolean;
    emailVerified?: boolean;
    createdAt: string;
  }[];
  vehicles: {
    id: string;
    customerId: string;
    customerName: string;
    registrationNumber: string;
    make: string;
    model: string;
    segment: string;
    variant?: string;
    fuelType: string;
    color: string;
    year: number;
    notes?: string;
    previousOwners?: { customerId: string; customerName: string; transferDate: string; reason?: string }[];
  }[];
  collections?: Record<string, unknown>;
};

const file = JSON.parse(raw) as SeedFile;
const { branches, staff, customers, vehicles } = file;
const collections = file.collections ?? {};

const ARRAY_COLLECTIONS = [
  "jobCards",
  "invoices",
  "quotations",
  "appointments",
  "expenses",
  "activityLogs",
  "serviceReminders",
  "walletTransactions",
  "serviceCatalog",
  "parts",
  "stockMovements",
  "productPurchases",
  "branchStocks",
  "stockTransfers",
  "partCategories",
  "followUps",
  "offers",
  "supportTickets",
  "demoRequests",
  "serviceCategories",
  "notifications",
  "pickupDropRequests",
] as const;

const SINGLETON_COLLECTIONS = [
  "dashboardStats",
  "expenseMeta",
  "cashBank",
  "payroll",
  "membership",
  "appSettings",
  "referralProgram",
  "balanceSheetManual",
  "highEndServices",
  "reportSchedules",
  "vehicleCatalog",
] as const;
const SINGLETON_ENTITY_ID = "default";

const prisma = new PrismaClient();

/**
 * OTP login sends 10 digits; API matches `digitsOnly(user.phone).endsWith(ten)`.
 * Accept 10-digit India mobile or full international digits.
 */
function normalizeSuperAdminPhone(raw: string | undefined): string {
  const digits = (raw ?? "").trim().replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return "+919999999999";
}

async function main() {
  const passwordHash = await bcrypt.hash("password", 10);

  const orgId = "org-default";
  /** Starter SaaS default: one location. Keep only the primary seed branch. */
  const primaryBranch = branches[0];
  if (!primaryBranch) {
    throw new Error("seed-data.json must include at least one branch");
  }
  const seedBranches = [primaryBranch];
  const primaryBranchId = primaryBranch.id;
  const maxBranchesForDemo = 1;

  await prisma.organization.upsert({
    where: { id: orgId },
    create: {
      id: orgId,
      name: "My Detail OS",
      slug: "my-detail-os",
    },
    update: {
      name: "My Detail OS",
      slug: "my-detail-os",
    },
  });

  await prisma.organizationSubscription.upsert({
    where: { organizationId: orgId },
    create: {
      id: "sub-default",
      organizationId: orgId,
      planCode: "STARTER",
      planName: "Starter",
      status: "ACTIVE",
      limits: { maxBranches: maxBranchesForDemo },
      maxBranchesOverride: null,
      termMonths: 12,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      paymentStatus: "PAID",
      contactUsUrl:
        process.env.DEFAULT_CONTACT_US_URL?.trim() ||
        "mailto:support@mydetailos.com?subject=Branch%20limit%20help",
      contactPhone: process.env.DEFAULT_CONTACT_PHONE?.trim() || "+919876543210",
      upgradeUrl:
        process.env.DEFAULT_UPGRADE_URL?.trim() ||
        "mailto:support@mydetailos.com?subject=Upgrade%20plan%20request",
    },
    update: {
      planCode: "STARTER",
      planName: "Starter",
      status: "ACTIVE",
      limits: { maxBranches: maxBranchesForDemo },
      maxBranchesOverride: null,
      termMonths: 12,
      paymentStatus: "PAID",
      contactUsUrl:
        process.env.DEFAULT_CONTACT_US_URL?.trim() ||
        "mailto:support@mydetailos.com?subject=Branch%20limit%20help",
      contactPhone: process.env.DEFAULT_CONTACT_PHONE?.trim() || "+919876543210",
      upgradeUrl:
        process.env.DEFAULT_UPGRADE_URL?.trim() ||
        "mailto:support@mydetailos.com?subject=Upgrade%20plan%20request",
    },
  });

  // Ensure demo org always has a usable expiry window (do not wipe a shorter admin-set window).
  const demoSub = await prisma.organizationSubscription.findUnique({
    where: { organizationId: orgId },
  });
  if (demoSub && !demoSub.expiresAt && !demoSub.currentPeriodEnd) {
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await prisma.organizationSubscription.update({
      where: { organizationId: orgId },
      data: {
        startsAt: demoSub.startsAt ?? new Date(),
        expiresAt,
        currentPeriodEnd: expiresAt,
        termMonths: demoSub.termMonths || 12,
      },
    });
  }
  for (const b of seedBranches) {
    await prisma.branch.upsert({
      where: { id: b.id },
      create: {
        id: b.id,
        name: b.name,
        address: b.address,
        phone: b.phone,
        isActive: b.isActive,
        qrCodeId: b.qrCodeId ?? null,
        code: b.code ?? null,
        city: b.city ?? null,
        state: b.state ?? null,
        pincode: b.pincode ?? null,
        email: b.email ?? null,
        managerName: b.managerName ?? null,
        managerPhone: b.managerPhone ?? null,
        organizationId: orgId,
      },
      update: {
        name: b.name,
        address: b.address,
        phone: b.phone,
        isActive: b.isActive,
        qrCodeId: b.qrCodeId ?? null,
        code: b.code ?? null,
        city: b.city ?? null,
        state: b.state ?? null,
        pincode: b.pincode ?? null,
        email: b.email ?? null,
        managerName: b.managerName ?? null,
        managerPhone: b.managerPhone ?? null,
        organizationId: orgId,
      },
    });
  }

  const ALL_PERMISSION_KEYS = [
    "DASHBOARD",
    "JOB_CARDS",
    "BOOKINGS",
    "PICKUP_DROP",
    "QUOTATIONS",
    "APPOINTMENTS",
    "CUSTOMERS",
    "MEMBERSHIP",
    "VEHICLES",
    "REMINDERS",
    "FOLLOW_UPS",
    "REFERRALS",
    "OFFERS",
    "SUPPORT",
    "BILLING",
    "REPORTS",
    "CASH_BANK",
    "PARTIES",
    "SHARED_LEDGER",
    "EXPENSES",
    "VENDORS",
    "STAFF",
    "ATTENDANCE",
    "LEAVE",
    "PAYROLL",
    "STAFF_REWARDS",
    "SERVICES",
    "INVENTORY",
    "BRANCHES",
    "PERFORMANCE",
    "MECHANICS",
    "ANALYTICS",
    "ADVANCED_REPORTS",
    "ACTIVITY",
    "MESSAGES",
    "SETTINGS"
  ];

  for (const u of staff) {
    const staffBranchId = seedBranches.some((b) => b.id === u.branchId)
      ? u.branchId
      : primaryBranchId;
    await prisma.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        name: u.name,
        email: u.email.toLowerCase(),
        phone: u.phone,
        role: u.role as Parameters<typeof prisma.user.create>[0]["data"]["role"],
        branchId: staffBranchId,
        organizationId: orgId,
        avatar: u.avatar ?? null,
        isActive: u.isActive,
        emailVerified: u.emailVerified ?? false,
        attendancePin: u.attendancePin ?? null,
        totalJobsCompleted: u.totalJobsCompleted ?? null,
        totalIncentiveEarned: u.totalIncentiveEarned ?? null,
        birthday: u.birthday ?? null,
        anniversary: u.anniversary ?? null,
        passwordHash,
        permissions: ALL_PERMISSION_KEYS,
      },
      update: {
        name: u.name,
        email: u.email.toLowerCase(),
        phone: u.phone,
        role: u.role as Parameters<typeof prisma.user.update>[0]["data"]["role"],
        branchId: staffBranchId,
        organizationId: orgId,
        avatar: u.avatar ?? null,
        isActive: u.isActive,
        emailVerified: u.emailVerified ?? false,
        attendancePin: u.attendancePin ?? null,
        totalJobsCompleted: u.totalJobsCompleted ?? null,
        totalIncentiveEarned: u.totalIncentiveEarned ?? null,
        birthday: u.birthday ?? null,
        anniversary: u.anniversary ?? null,
        passwordHash,
        permissions: ALL_PERMISSION_KEYS,
      },
    });
  }

  for (const c of customers) {
    await prisma.customer.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        organizationId: orgId,
        name: c.name,
        phone: c.phone,
        email: c.email,
        address: c.address,
        referralCode: c.referralCode,
        referredBy: c.referredBy ?? null,
        totalVisits: c.totalVisits,
        rewardPoints: c.rewardPoints,
        walletBalance: c.walletBalance,
        lastVisitDate: c.lastVisitDate ?? null,
        isInactive: c.isInactive ?? false,
        emailVerified: c.emailVerified ?? false,
        createdAt: new Date(c.createdAt),
      },
      update: {
        organizationId: orgId,
        name: c.name,
        phone: c.phone,
        email: c.email,
        address: c.address,
        referralCode: c.referralCode,
        referredBy: c.referredBy ?? null,
        totalVisits: c.totalVisits,
        rewardPoints: c.rewardPoints,
        walletBalance: c.walletBalance,
        lastVisitDate: c.lastVisitDate ?? null,
        isInactive: c.isInactive ?? false,
        emailVerified: c.emailVerified ?? false,
        createdAt: new Date(c.createdAt),
      },
    });
  }

  await prisma.party.upsert({
    where: { id: "c:cust-hitech" },
    create: {
      id: "c:cust-hitech",
      organizationId: orgId,
      kind: "CUSTOMER",
      name: "HI TECH CAR SPA & DETAILING",
      mobile: "+919876543299",
      email: "hitech@example.test",
      gstin: "09AABCU9603R1ZM",
      pan: "AABCU9603R",
      billingAddress: "Sector 63, Noida, Uttar Pradesh",
      shippingAddress: "Sector 63, Noida, Uttar Pradesh",
      customerId: "cust-hitech",
    },
    update: {
      organizationId: orgId,
      name: "HI TECH CAR SPA & DETAILING",
      gstin: "09AABCU9603R1ZM",
      pan: "AABCU9603R",
    },
  });

  for (const v of vehicles) {
    await prisma.vehicle.upsert({
      where: { id: v.id },
      create: {
        id: v.id,
        organizationId: orgId,
        customerId: v.customerId,
        customerName: v.customerName,
        registrationNumber: v.registrationNumber,
        make: v.make,
        model: v.model,
        segment: v.segment as Parameters<typeof prisma.vehicle.create>[0]["data"]["segment"],
        variant: v.variant ?? null,
        fuelType: v.fuelType as Parameters<typeof prisma.vehicle.create>[0]["data"]["fuelType"],
        color: v.color,
        year: v.year,
        notes: v.notes ?? null,
        previousOwners: v.previousOwners ? (v.previousOwners as object) : undefined,
      },
      update: {
        organizationId: orgId,
        customerId: v.customerId,
        customerName: v.customerName,
        registrationNumber: v.registrationNumber,
        make: v.make,
        model: v.model,
        segment: v.segment as Parameters<typeof prisma.vehicle.update>[0]["data"]["segment"],
        variant: v.variant ?? null,
        fuelType: v.fuelType as Parameters<typeof prisma.vehicle.update>[0]["data"]["fuelType"],
        color: v.color,
        year: v.year,
        notes: v.notes ?? null,
        previousOwners: v.previousOwners ? (v.previousOwners as object) : undefined,
      },
    });
  }

  for (const name of ARRAY_COLLECTIONS) {
    const arr = collections[name];
    if (!Array.isArray(arr)) continue;
    await prisma.appJsonRow.deleteMany({ where: { collection: name } });
    for (const item of arr as { id: string; branchId?: string }[]) {
      if (!item?.id) continue;
      const payload =
        item.branchId && !seedBranches.some((b) => b.id === item.branchId)
          ? { ...item, branchId: primaryBranchId }
          : item;
      let rowCreatedAt: Date | undefined;
      const rawCreated =
        payload && typeof payload === "object"
          ? (payload as { createdAt?: unknown }).createdAt
          : undefined;
      if (typeof rawCreated === "string" && rawCreated) {
        const t = new Date(rawCreated);
        if (!Number.isNaN(t.getTime())) rowCreatedAt = t;
      }
      await prisma.appJsonRow.create({
        data: {
          collection: name,
          entityId: item.id,
          organizationId: orgId,
          payload: payload as object,
          ...(rowCreatedAt ? { createdAt: rowCreatedAt } : {}),
        },
      });
    }
  }

  for (const name of SINGLETON_COLLECTIONS) {
    const payload = collections[name];
    if (payload === undefined || payload === null) continue;
    const remapped =
      typeof payload === "object"
        ? JSON.parse(JSON.stringify(payload).replaceAll("br-002", primaryBranchId))
        : payload;
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: { collection: name, entityId: SINGLETON_ENTITY_ID },
      },
      create: {
        collection: name,
        entityId: SINGLETON_ENTITY_ID,
        organizationId: orgId,
        payload: remapped as object,
      },
      update: { payload: remapped as object, organizationId: orgId },
    });
  }

  const allowedBranchIds = seedBranches.map((b) => b.id);
  const fallbackBranchId = primaryBranchId;

  const superEmail = (process.env.SUPER_ADMIN_EMAIL ?? "superadmin@company.com").trim().toLowerCase();
  const superPassword = process.env.SUPER_ADMIN_PASSWORD ?? "ChangeMe!SuperAdmin1";
  const superBranchRaw = process.env.SUPER_ADMIN_BRANCH_ID?.trim();
  const superBranchId =
    superBranchRaw && allowedBranchIds.includes(superBranchRaw) ? superBranchRaw : fallbackBranchId;
  const superHash = await bcrypt.hash(superPassword, 10);
  const superPhone = normalizeSuperAdminPhone(process.env.SUPER_ADMIN_PHONE);

  const emailConflict = await prisma.user.findFirst({
    where: { email: superEmail, NOT: { id: "usr-admin" } },
    select: { id: true },
  });
  if (emailConflict) {
    const freedEmail = `${emailConflict.id}-archived-${Date.now()}@seed.local`;
    await prisma.user.update({
      where: { id: emailConflict.id },
      data: { email: freedEmail },
    });
    console.warn(
      `[seed] Email "${superEmail}" was already used by ${emailConflict.id}; moved that account to ${freedEmail} so bootstrap Super Admin can use it.`
    );
  }

  const bootstrapNow = new Date();

  await prisma.user.upsert({
    where: { id: "usr-admin" },
    create: {
      id: "usr-admin",
      name: "Super Admin",
      email: superEmail,
      phone: superPhone,
      role: UserRole.SUPER_ADMIN,
      branchId: superBranchId,
      organizationId: orgId,
      passwordHash: superHash,
      mustChangePassword: false,
      isActive: true,
      emailVerified: true,
      attendancePin: "1000",
      totalJobsCompleted: 120,
      totalIncentiveEarned: 45000,
      passwordUpdatedAt: bootstrapNow,
    },
    update: {
      name: "Super Admin",
      email: superEmail,
      phone: superPhone,
      branchId: superBranchId,
      organizationId: orgId,
      passwordHash: superHash,
      role: UserRole.SUPER_ADMIN,
      mustChangePassword: false,
      isActive: true,
      passwordUpdatedAt: bootstrapNow,
    },
  });

  const platformEmail = (process.env.PLATFORM_OWNER_EMAIL ?? "admin@mydetailos.com").trim().toLowerCase();
  const platformPassword = process.env.PLATFORM_OWNER_PASSWORD ?? "Test@12345";
  const platformHash = await bcrypt.hash(platformPassword, 10);
  const platformPhone = normalizeSuperAdminPhone(process.env.PLATFORM_OWNER_PHONE ?? "9999999998");

  const platformEmailConflict = await prisma.user.findFirst({
    where: { email: platformEmail, NOT: { id: "usr-platform" } },
    select: { id: true },
  });
  if (platformEmailConflict) {
    const freedEmail = `${platformEmailConflict.id}-archived-${Date.now()}@seed.local`;
    await prisma.user.update({
      where: { id: platformEmailConflict.id },
      data: { email: freedEmail },
    });
    console.warn(
      `[seed] Email "${platformEmail}" was already used by ${platformEmailConflict.id}; moved that account to ${freedEmail}.`
    );
  }

  await prisma.user.upsert({
    where: { id: "usr-platform" },
    create: {
      id: "usr-platform",
      name: "Platform Owner",
      email: platformEmail,
      phone: platformPhone,
      role: UserRole.PLATFORM_OWNER,
      branchId: fallbackBranchId,
      organizationId: orgId,
      passwordHash: platformHash,
      mustChangePassword: false,
      isActive: true,
      emailVerified: true,
      permissions: [],
      passwordUpdatedAt: bootstrapNow,
    },
    update: {
      name: "Platform Owner",
      email: platformEmail,
      phone: platformPhone,
      branchId: fallbackBranchId,
      organizationId: orgId,
      passwordHash: platformHash,
      role: UserRole.PLATFORM_OWNER,
      mustChangePassword: false,
      isActive: true,
      passwordUpdatedAt: bootstrapNow,
    },
  });

  console.info(
    `[seed] SaaS: org=${orgId}, maxBranches=${maxBranchesForDemo}, branches=${allowedBranchIds.join(",")}, platform owner=${platformEmail}`
  );

  // Move any leftover users/attendance off branches we are about to delete.
  if (allowedBranchIds.length > 0) {
    await prisma.user.updateMany({
      where: { branchId: { notIn: allowedBranchIds } },
      data: { branchId: fallbackBranchId },
    });
    await prisma.attendance.updateMany({
      where: { branchId: { notIn: allowedBranchIds } },
      data: { branchId: fallbackBranchId },
    });
  }
  await prisma.branch.deleteMany({
    where: { id: { notIn: allowedBranchIds } },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

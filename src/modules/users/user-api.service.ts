import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { Prisma, User as PrismaUser } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { toStaffDirectoryEntry } from "../../lib/data-scope.js";
import {
  assertCanCreateUser,
  isBillableUserSeatRole,
} from "../organization/organization-subscription.service.js";
import { generateTemporaryPassword } from "../../lib/generate-password.js";
import {
  permissionsForStaffAccessLevel,
  type StaffAccessLevel,
} from "../../lib/staff-access.js";
import { resolvePermissionsOnCreate } from "../../lib/staff-role-defaults.js";

export { generateTemporaryPassword };



/** Trim; empty string becomes null (clears optional HR fields / unique employeeCode). */
function nullIfEmpty(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function toApiUser(u: PrismaUser) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    employeeCode: u.employeeCode ?? undefined,
    designation: u.designation ?? undefined,
    department: u.department ?? undefined,
    joiningDate: u.joiningDate ?? undefined,
    role: u.role,
    branchId: u.branchId,
    organizationId: u.organizationId,
    avatar: u.avatar ?? undefined,
    isActive: u.isActive,
    emailVerified: u.emailVerified || undefined,
    attendancePin: u.attendancePin ?? undefined,
    isAttendanceTracked: u.isAttendanceTracked,
    baseSalary: u.baseSalary ?? undefined,
    totalJobsCompleted: u.totalJobsCompleted ?? undefined,
    totalIncentiveEarned: u.totalIncentiveEarned ?? undefined,
    birthday: u.birthday ?? undefined,
    anniversary: u.anniversary ?? undefined,
    notes: u.notes ?? undefined,
    mustChangePassword: u.mustChangePassword === true ? true : undefined,
    passwordCreatedBy: u.passwordCreatedBy ?? undefined,
    passwordUpdatedAt: u.passwordUpdatedAt?.toISOString(),
    permissions: u.permissions || [],
  };
}

export async function listUsersApi(opts?: {
  organizationId?: string | null;
  /** When set, only users on these branches. null/undefined = all org users. */
  branchIds?: string[] | null;
}) {
  const where: Prisma.UserWhereInput = {
    role: { not: "PLATFORM_OWNER" },
  };
  if (opts?.organizationId) {
    where.organizationId = opts.organizationId;
  }
  if (opts?.branchIds && opts.branchIds.length > 0) {
    where.branchId = { in: opts.branchIds };
  } else if (opts?.branchIds && opts.branchIds.length === 0) {
    return [];
  }
  const rows = await prisma.user.findMany({
    where,
    orderBy: { id: "asc" },
  });
  return rows.map(toApiUser);
}

export async function listStaffDirectoryApi(opts: {
  organizationId: string;
  branchIds?: string[] | null;
}) {
  const where: Prisma.UserWhereInput = {
    role: { not: "PLATFORM_OWNER" },
    organizationId: opts.organizationId,
  };
  if (opts.branchIds && opts.branchIds.length > 0) {
    where.branchId = { in: opts.branchIds };
  } else if (opts.branchIds && opts.branchIds.length === 0) {
    return [];
  }
  const rows = await prisma.user.findMany({
    where,
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      role: true,
      branchId: true,
      organizationId: true,
      isActive: true,
      avatar: true,
    },
  });
  return rows.map(toStaffDirectoryEntry);
}

export async function createUserApi(input: {
  id?: string;
  name: string;
  email: string;
  phone: string;
  role: PrismaUser["role"];
  branchId: string;
  organizationId: string;
  password?: string;
  avatar?: string | null;
  isActive?: boolean;
  emailVerified?: boolean;
  attendancePin?: string | null;
  isAttendanceTracked?: boolean;
  baseSalary?: number | null;
  totalJobsCompleted?: number | null;
  totalIncentiveEarned?: number | null;
  birthday?: string | null;
  anniversary?: string | null;
  employeeCode?: string | null;
  designation?: string | null;
  department?: string | null;
  joiningDate?: string | null;
  notes?: string | null;
  /** Creator `User.id` when provisioned by an authenticated admin. */
  createdById?: string | null;
  permissions?: string[];
  /** Used when permissions is omitted or [] — mirrors frontend Add User access radios. */
  accessLevel?: StaffAccessLevel;
}): Promise<{ user: ReturnType<typeof toApiUser>; temporaryPassword?: string }> {
  if (input.role === "PLATFORM_OWNER" || input.role === "SUPER_ADMIN") {
    throw AppError.validation(`Cannot create ${input.role} accounts via studio user management.`);
  }

  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) {
    throw AppError.validation("Selected branch was not found.");
  }
  // SUPER_ADMIN (and other billable roles) always consume a seat; MECHANIC / PLATFORM_OWNER do not.
  if ((input.isActive ?? true) && isBillableUserSeatRole(input.role)) {
    await assertCanCreateUser(branch.organizationId);
  }

  const email = input.email.trim().toLowerCase();
  const emailClash = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (emailClash) {
    throw AppError.validation("A user with this email already exists.");
  }

  let finalUserId = input.id?.trim();
  if (finalUserId) {
    const idClash = await prisma.user.findUnique({
      where: { id: finalUserId },
      select: { id: true },
    });
    if (idClash) {
      finalUserId = undefined;
    }
  }

  if (!finalUserId) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `usr-${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
      const idClash = await prisma.user.findUnique({
        where: { id: candidate },
        select: { id: true },
      });
      if (!idClash) {
        finalUserId = candidate;
        break;
      }
    }
    if (!finalUserId) {
      finalUserId = `usr-${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
    }
  }

  const useExplicitPassword = input.password !== undefined && input.password.trim() !== "";
  const plainPassword = useExplicitPassword ? input.password!.trim() : generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  const now = new Date();

  const data: Prisma.UserUncheckedCreateInput = {
    id: finalUserId,
    name: input.name,
    email,
    phone: input.phone,
    role: input.role,
    branchId: input.branchId,
    organizationId: branch.organizationId,
    passwordHash,
    mustChangePassword: !useExplicitPassword,
    passwordCreatedBy: input.createdById ?? null,
    passwordUpdatedAt: now,
    avatar: input.avatar ?? null,
    isActive: input.isActive ?? true,
    emailVerified: input.emailVerified ?? false,
    attendancePin: input.attendancePin ?? null,
    isAttendanceTracked: input.isAttendanceTracked ?? true,
    baseSalary: input.baseSalary ?? null,
    totalJobsCompleted: input.totalJobsCompleted ?? null,
    totalIncentiveEarned: input.totalIncentiveEarned ?? null,
    birthday: nullIfEmpty(input.birthday) ?? null,
    anniversary: nullIfEmpty(input.anniversary) ?? null,
    employeeCode: nullIfEmpty(input.employeeCode) ?? null,
    designation: nullIfEmpty(input.designation) ?? null,
    department: nullIfEmpty(input.department) ?? null,
    joiningDate: nullIfEmpty(input.joiningDate) ?? null,
    notes: nullIfEmpty(input.notes) ?? null,
    permissions: resolvePermissionsOnCreate(input.role, input.permissions, input.accessLevel),
  };

  const code = data.employeeCode as string | null;
  if (code) {
    const clash = await prisma.user.findFirst({ where: { employeeCode: code } });
    if (clash) {
      throw AppError.validation("Employee code is already in use.");
    }
  }

  let row: PrismaUser;
  try {
    row = await prisma.user.create({ data });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "P2002"
    ) {
      const meta = (err as { meta?: { target?: string[] | string } }).meta;
      const target = meta?.target;
      const msg = err instanceof Error ? err.message : String(err);
      const isIdClash =
        Array.isArray(target)
          ? target.includes("id")
          : target === "id" || msg.includes("(id)");
      if (isIdClash) {
        const fallbackId = `usr-${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
        row = await prisma.user.create({ data: { ...data, id: fallbackId } });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  return {
    user: toApiUser(row),
    ...(!useExplicitPassword ? { temporaryPassword: plainPassword } : {}),
  };
}

export async function updateUserApi(
  id: string,
  patch: Partial<{
    name: string;
    email: string;
    phone: string;
    role: PrismaUser["role"];
    branchId: string;
    avatar: string | null;
    isActive: boolean;
    emailVerified: boolean;
    attendancePin: string | null;
    isAttendanceTracked: boolean;
    baseSalary: number | null;
    totalJobsCompleted: number | null;
    totalIncentiveEarned: number | null;
    birthday: string | null;
    anniversary: string | null;
    employeeCode: string | null;
    designation: string | null;
    department: string | null;
    joiningDate: string | null;
    notes: string | null;
    permissions: string[];
    /** Same as create — maps With/Without Edit Access onto granular *_EDIT keys. */
    accessLevel: StaffAccessLevel;
  }>
): Promise<ReturnType<typeof toApiUser> | null> {
  try {
    const current = await prisma.user.findUnique({ where: { id } });
    if (!current) return null;

    // Never pass accessLevel to Prisma — it is not a DB column.
    const { accessLevel, permissions: patchPermissions, ...rest } = patch;
    const data: Prisma.UserUncheckedUpdateInput = { ...rest };

    if (accessLevel !== undefined) {
      // Apply radio choice on update (create already did this via resolvePermissionsOnCreate).
      const base = patchPermissions ?? current.permissions ?? [];
      data.permissions = permissionsForStaffAccessLevel(base, accessLevel);
    } else if (patchPermissions !== undefined) {
      data.permissions = patchPermissions;
    }

    if (patch.email !== undefined) data.email = patch.email.toLowerCase();
    if (patch.employeeCode !== undefined) data.employeeCode = nullIfEmpty(patch.employeeCode) ?? null;
    if (patch.designation !== undefined) data.designation = nullIfEmpty(patch.designation) ?? null;
    if (patch.department !== undefined) data.department = nullIfEmpty(patch.department) ?? null;
    if (patch.joiningDate !== undefined) data.joiningDate = nullIfEmpty(patch.joiningDate) ?? null;
    if (patch.notes !== undefined) data.notes = nullIfEmpty(patch.notes) ?? null;
    if (patch.birthday !== undefined) data.birthday = nullIfEmpty(patch.birthday) ?? null;
    if (patch.anniversary !== undefined) data.anniversary = nullIfEmpty(patch.anniversary) ?? null;
    if (patch.branchId !== undefined) {
      const branch = await prisma.branch.findUnique({ where: { id: patch.branchId } });
      if (!branch) return null;
      data.organizationId = branch.organizationId;
    }

    const nextActive = patch.isActive ?? current.isActive;
    const wasInactive = !current.isActive;
    const effectiveRole = patch.role ?? current.role;
    const wasBillable = isBillableUserSeatRole(current.role);
    const willBeBillable = nextActive && isBillableUserSeatRole(effectiveRole);
    // Seat check when a billable seat is newly occupied (reactivate, or promote e.g. MECHANIC → SUPER_ADMIN).
    // SUPER_ADMIN always counts as a user seat.
    if (willBeBillable && (wasInactive || !wasBillable)) {
      const nextOrgId =
        typeof data.organizationId === "string" && data.organizationId.trim()
          ? data.organizationId
          : current.organizationId;
      await assertCanCreateUser(nextOrgId);
    }

    if (typeof data.employeeCode === "string" && data.employeeCode) {
      const clash = await prisma.user.findFirst({
        where: { employeeCode: data.employeeCode, NOT: { id } },
      });
      if (clash) {
        throw AppError.validation("Employee code is already in use.");
      }
    }
    const row = await prisma.user.update({ where: { id }, data });
    return toApiUser(row);
  } catch (e) {
    if (e && typeof e === "object" && "statusCode" in e) throw e;
    return null;
  }
}

export async function resetUserPasswordApi(input: {
  userId: string;
  password: string;
  mustChangePassword: boolean;
  actorUserId: string;
}): Promise<ReturnType<typeof toApiUser> | null> {
  const existing = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!existing) return null;

  const passwordHash = await bcrypt.hash(input.password, 10);
  const updated = await prisma.user.update({
    where: { id: input.userId },
    data: {
      passwordHash,
      mustChangePassword: input.mustChangePassword,
      passwordCreatedBy: input.actorUserId,
      passwordUpdatedAt: new Date(),
    },
  });
  return toApiUser(updated);
}

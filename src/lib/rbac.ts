import type { UserRole } from "@prisma/client";
import type { AppRole } from "../middleware/auth.js";

/** Can list/create/edit staff users (non–role-assignment edits). */
export const STAFF_MANAGEMENT_ROLES: readonly UserRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "BRANCH_MANAGER",
  "MANAGER",
] as const;

/** Can assign or change roles (including elevating to admin). */
export const ROLE_ASSIGNMENT_ROLES: readonly UserRole[] = ["SUPER_ADMIN"] as const;

/** Branch create/update. */
export const BRANCH_MUTATION_ROLES: readonly UserRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "BRANCH_MANAGER",
  "MANAGER",
] as const;

/** Payroll / salary JSON collection read/write. */
export const PAYROLL_ACCESS_ROLES: readonly UserRole[] = ["SUPER_ADMIN", "ADMIN", "MANAGER", "BRANCH_MANAGER"] as const;

export function isStaffManager(role: AppRole): boolean {
  return (STAFF_MANAGEMENT_ROLES as readonly string[]).includes(role);
}

export function canAssignUserRole(actor: AppRole, targetRole: UserRole): boolean {
  if (targetRole === "PLATFORM_OWNER" || targetRole === "SUPER_ADMIN") return false;
  return actor === "SUPER_ADMIN";
}

export function isPlatformOwner(role: AppRole | undefined): boolean {
  return role === "PLATFORM_OWNER";
}

export function canChangeRoles(actor: AppRole): boolean {
  return (ROLE_ASSIGNMENT_ROLES as readonly string[]).includes(actor);
}

/** Super Admin and Admin may onboard accounts (no public signup). */
export function canCreateStaffAccounts(actor: AppRole): boolean {
  return actor === "SUPER_ADMIN" || actor === "ADMIN";
}

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { UserRole } from "@prisma/client";
import {
  granularPermissionKey,
  isGranularPermissionModule,
  type GranularAction,
} from "../constants/permission-keys.js";

/** Staff roles (Prisma `UserRole`) plus the customer-portal pseudo-role. */
export type AppRole = UserRole | "CUSTOMER";

export interface AuthUser {
  id: string;
  email: string;
  role: AppRole;
  /** Empty string for customer-portal tokens (customers aren't branch-scoped). */
  branchId: string;
  organizationId?: string;
  /** Present only for customer-portal tokens (`role === "CUSTOMER"`). */
  customerId?: string;
  name: string;
  permissions?: string[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

/** Skip org-suspension gate for vendor platform operators. */
function isPlatformBypassRole(role: AppRole): boolean {
  return role === "PLATFORM_OWNER";
}

/**
 * After JWT is valid, block studio/customer access when the org was suspended
 * (isActive=false or subscription CANCELLED). Without this, an existing tab
 * keeps working until a hard refresh because the JWT is still valid.
 */
async function assertOrganizationAccess(
  req: Request,
  auth: AuthUser
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (isPlatformBypassRole(auth.role)) return { ok: true };

  // Always allow logout so a suspended session can clear itself.
  const path = (req.originalUrl || req.path || "").split("?")[0] ?? "";
  if (path === "/api/auth/logout" || path.endsWith("/auth/logout")) return { ok: true };

  const orgId = auth.organizationId?.trim();
  if (!orgId) {
    return { ok: false, message: "Organization not found on session." };
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      isActive: true,
      subscription: { select: { status: true } },
    },
  });

  if (!org) {
    return { ok: false, message: "Organization not found." };
  }
  if (!org.isActive || org.subscription?.status === "CANCELLED") {
    return {
      ok: false,
      message: "This workshop has been suspended. Contact support to restore access.",
    };
  }
  return { ok: true };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ data: null, error: { message: "Missing authorization token" } });
    return;
  }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & {
      sub: string;
      email?: string;
      role: AppRole;
      branchId?: string;
      organizationId?: string;
      customerId?: string;
      name: string;
      permissions?: string[];
    };
    req.auth = {
      id: decoded.sub,
      email: decoded.email ?? "",
      role: decoded.role,
      branchId: decoded.branchId ?? "",
      organizationId: decoded.organizationId,
      customerId: decoded.customerId,
      name: decoded.name,
      permissions: decoded.permissions || [],
    };

    void assertOrganizationAccess(req, req.auth).then((result) => {
      if (!result.ok) {
        res.status(403).json({
          data: null,
          error: { message: result.message, code: "ORG_SUSPENDED" },
        });
        return;
      }
      next();
    }).catch(next);
  } catch {
    res.status(401).json({ data: null, error: { message: "Invalid or expired token" } });
  }
}

/** Gate customer-portal routes: requires a valid `role: "CUSTOMER"` token with a customerId claim. */
export function requireCustomerAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.role !== "CUSTOMER" || !req.auth.customerId) {
    res.status(401).json({ data: null, error: { message: "Unauthorized" } });
    return;
  }
  next();
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    if (hasPermissionForMethod(req.auth, permission, req.method)) {
      next();
      return;
    }
    res.status(403).json({ data: null, error: { message: `Forbidden: Missing permission ${permission}` } });
  };
}

/** Pass if the user holds any of the listed permissions (SUPER_ADMIN bypasses). */
export function requireAnyPermission(permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    if (permissions.some((p) => hasPermissionForMethod(req.auth!, p, req.method))) {
      next();
      return;
    }
    res.status(403).json({
      data: null,
      error: {
        message: `Forbidden: Missing one of permissions ${permissions.join(", ")}`,
      },
    });
  };
}

function actionFromHttpMethod(method: string): GranularAction | null {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "VIEW";
    case "POST":
      return "CREATE";
    case "PUT":
    case "PATCH":
      return "EDIT";
    case "DELETE":
      return "DELETE";
    default:
      return null;
  }
}

/**
 * Modules whose primary write path is PUT upsert (no dedicated POST create).
 * Staff with *_CREATE must be able to PUT — otherwise "Without Edit Access"
 * can open the create UI but gets 403 on save (job cards, bookings, etc.).
 */
const UPSERT_VIA_PUT_MODULES = new Set<string>([
  "JOB_CARDS",
  "BOOKINGS",
  "APPOINTMENTS",
  "QUOTATIONS",
  "PICKUP_DROP",
  "BILLING",
  "MEMBERSHIP",
  "REFERRALS",
  "EXPENSES",
  "INVENTORY",
  "ATTENDANCE",
]);

/**
 * Method-aware permission resolver:
 * - SUPER_ADMIN / ADMIN bypass all checks.
 * - Base permission key remains backward-compatible and implies all actions.
 * - Granular modules may use *_CREATE / *_VIEW / *_EDIT / *_DELETE.
 * - Upsert-via-PUT modules: *_CREATE also authorizes PUT/PATCH (create + workflow writes).
 */
export function hasPermissionForMethod(auth: AuthUser, permission: string, method: string): boolean {
  if (auth.role === "SUPER_ADMIN" || auth.role === "ADMIN" || auth.role === "PLATFORM_OWNER") {
    return true;
  }

  const held = auth.permissions ?? [];
  if (held.includes(permission)) return true;

  const action = actionFromHttpMethod(method);
  if (!action) return false;

  if (held.includes(`${permission}_${action}`)) return true;

  if (
    action === "EDIT" &&
    UPSERT_VIA_PUT_MODULES.has(permission) &&
    held.includes(`${permission}_CREATE`)
  ) {
    return true;
  }

  if (!isGranularPermissionModule(permission)) {
    if (
      held.includes(`${permission}_VIEW`) ||
      held.includes(`${permission}_CREATE`) ||
      held.includes(`${permission}_EDIT`) ||
      held.includes(`${permission}_DELETE`)
    ) {
      return true;
    }
  }

  return false;
}

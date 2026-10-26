import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Branch, User } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import type { UserRole } from "@prisma/client";

/**
 * Authenticates a user and returns user + branch + organization together.
 * Fetches user, branch, and organization in a single query to minimize DB round-trips.
 */
export async function authenticateUser(
  email: string,
  password: string
): Promise<{
  user: User;
  branch: Branch | null;
  organization: { id: string; name: string; slug: string | null; isActive: boolean } | null;
} | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: {
      organization: {
        select: { id: true, name: true, slug: true, isActive: true },
      },
      branch: true,
    },
  });
  if (!user?.isActive) return null;

  // Non-platform owners must belong to an existing, active organization
  if (user.role !== "PLATFORM_OWNER") {
    if (!user.organization || !user.organization.isActive) {
      return null;
    }
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  // Fire-and-forget: lastLoginAt is informational; don't block the auth response on it.
  prisma.user
    .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch(() => {});

  return {
    user,
    branch: user.branch,
    organization: user.organization,
  };
}

/** Record successful OTP (or other non-password) login. */
export async function touchUserLastLogin(userId: string) {
  // Fire-and-forget: informational field, should not block response.
  prisma.user
    .update({ where: { id: userId }, data: { lastLoginAt: new Date() } })
    .catch(() => {});
}

export function signAuthToken(user: {
  id: string;
  email: string;
  role: UserRole;
  branchId: string;
  organizationId?: string;
  name: string;
  mustChangePassword?: boolean;
  permissions?: string[];
}) {
  const expiresSeconds = 7 * 24 * 60 * 60;
  const options: jwt.SignOptions = { expiresIn: expiresSeconds };
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
      organizationId: user.organizationId,
      name: user.name,
      mustChangePassword: user.mustChangePassword === true,
      permissions: user.permissions || [],
    },
    env.JWT_SECRET,
    options
  );
}

import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export const PLATFORM_USER_ID = "usr-platform";

function normalizePhone(raw: string | undefined): string {
  const digits = (raw ?? "").trim().replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return "+919999999998";
}

export type EnsurePlatformOwnerResult = {
  email: string;
  action: "created" | "updated" | "skipped";
};

function isTransientPrismaConnectionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();
  return (
    m.includes("error in postgresql connection") ||
    m.includes("kind: closed") ||
    m.includes("can't reach database server") ||
    m.includes("connection terminated")
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upsert YOUR vendor PLATFORM_OWNER login from env.
 * Does not wipe customer data.
 */
async function ensurePlatformOwnerOnce(opts?: {
  /** When false, existing user’s password is left unchanged. Default true. */
  syncPassword?: boolean;
}): Promise<EnsurePlatformOwnerResult> {
  const syncPassword = opts?.syncPassword !== false;
  const email = (process.env.PLATFORM_OWNER_EMAIL ?? "admin@mydetailos.com").trim().toLowerCase();
  const password = process.env.PLATFORM_OWNER_PASSWORD ?? "Test@12345";
  const name = (process.env.PLATFORM_OWNER_NAME ?? "Platform Owner").trim() || "Platform Owner";
  const phone = normalizePhone(process.env.PLATFORM_OWNER_PHONE);

  if (!email.includes("@")) {
    throw new Error("PLATFORM_OWNER_EMAIL must be a valid email");
  }
  if (password.length < 8) {
    throw new Error("PLATFORM_OWNER_PASSWORD must be at least 8 characters");
  }

  const org =
    (await prisma.organization.findUnique({ where: { id: "org-default" } })) ??
    (await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } }));
  const branch =
    (await prisma.branch.findFirst({
      where: org ? { organizationId: org.id } : undefined,
      orderBy: { id: "asc" },
    })) ?? (await prisma.branch.findFirst({ orderBy: { id: "asc" } }));

  if (!org || !branch) {
    throw new Error(
      "Organization or Branch missing. Apply SaaS schema before ensuring platform owner."
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();

  const byId = await prisma.user.findUnique({ where: { id: PLATFORM_USER_ID } });
  const byEmail = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  });

  if (byEmail && byEmail.id !== PLATFORM_USER_ID && byEmail.role !== UserRole.PLATFORM_OWNER) {
    throw new Error(
      `Email ${email} is already used by non-platform user ${byEmail.id} (${byEmail.role}). Pick another PLATFORM_OWNER_EMAIL.`
    );
  }

  const targetId =
    byEmail?.role === UserRole.PLATFORM_OWNER ? byEmail.id : PLATFORM_USER_ID;

  const existing = await prisma.user.findUnique({ where: { id: targetId } });

  if (!existing) {
    await prisma.user.create({
      data: {
        id: PLATFORM_USER_ID,
        name,
        email,
        phone,
        role: UserRole.PLATFORM_OWNER,
        branchId: branch.id,
        organizationId: org.id,
        passwordHash,
        mustChangePassword: false,
        isActive: true,
        emailVerified: true,
        permissions: [],
        passwordUpdatedAt: now,
      },
    });
    return { email, action: "created" };
  }

  await prisma.user.update({
    where: { id: existing.id },
    data: {
      name,
      email,
      phone,
      role: UserRole.PLATFORM_OWNER,
      branchId: branch.id,
      organizationId: org.id,
      mustChangePassword: false,
      isActive: true,
      emailVerified: true,
      ...(syncPassword
        ? { passwordHash, passwordUpdatedAt: now }
        : {}),
    },
  });

  return { email, action: byId || existing ? "updated" : "updated" };
}

export async function ensurePlatformOwner(opts?: {
  /** When false, existing user’s password is left unchanged. Default true. */
  syncPassword?: boolean;
}): Promise<EnsurePlatformOwnerResult> {
  try {
    return await ensurePlatformOwnerOnce(opts);
  } catch (err) {
    if (!isTransientPrismaConnectionError(err)) throw err;
    await delay(800);
    return ensurePlatformOwnerOnce(opts);
  }
}

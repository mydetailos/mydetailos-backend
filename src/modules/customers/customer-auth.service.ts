/**
 * Customer-portal authentication service.
 * Separate from staff auth (`modules/auth`) — customers log in with phone + password
 * and get a `role: "CUSTOMER"` JWT (see `middleware/auth.ts` `AppRole`).
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

interface CustomerAuthRow {
  id: string;
  organizationId: string;
  name: string;
  phone: string;
  email: string;
  passwordHash: string | null;
  isInactive: boolean;
}

/**
 * Verify phone + password. Matches on the last 10 digits of the stored phone
 * (mirrors the phone-clash check used by `customer.service.ts`).
 * Returns null on any mismatch (unknown phone, inactive, no password set, wrong password).
 */
/**
 * Authenticate customer within a specific organization (tenant-scoped).
 * organizationId is required — never match phone across all orgs.
 */
export async function authenticateCustomer(
  phone: string,
  password: string,
  organizationId: string
): Promise<CustomerAuthRow | null> {
  const norm = normalizePhone(phone);
  const orgId = organizationId.trim();
  if (norm.length !== 10 || !orgId) return null;

  const rows = await prisma.$queryRaw<CustomerAuthRow[]>`
    SELECT id, "organizationId", name, phone, email, "passwordHash", "isInactive"
    FROM "Customer"
    WHERE "organizationId" = ${orgId}
      AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ${norm}
    LIMIT 1
  `;
  const customer = rows[0];
  if (!customer || customer.isInactive || !customer.passwordHash) return null;

  const ok = await bcrypt.compare(password, customer.passwordHash);
  if (!ok) return null;

  // Fire-and-forget: lastLoginAt is informational; don't block the auth response on it.
  markCustomerLoggedIn(customer.id);

  return customer;
}

export async function findCustomerByPhoneAndOrg(
  phone: string,
  organizationId: string
): Promise<CustomerAuthRow | null> {
  const norm = normalizePhone(phone);
  const orgId = organizationId.trim();
  if (norm.length !== 10 || !orgId) return null;

  const rows = await prisma.$queryRaw<CustomerAuthRow[]>`
    SELECT id, "organizationId", name, phone, email, "passwordHash", "isInactive"
    FROM "Customer"
    WHERE "organizationId" = ${orgId}
      AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ${norm}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export function markCustomerLoggedIn(customerId: string): void {
  prisma.customer
    .update({ where: { id: customerId }, data: { lastLoginAt: new Date() } })
    .catch(() => {});
}

export function signCustomerAuthToken(customer: {
  id: string;
  organizationId: string;
  name: string;
  email: string;
}): string {
  const expiresSeconds = 30 * 24 * 60 * 60; // 30 days
  const options: jwt.SignOptions = { expiresIn: expiresSeconds };
  return jwt.sign(
    {
      sub: customer.id,
      customerId: customer.id,
      role: "CUSTOMER",
      organizationId: customer.organizationId,
      name: customer.name,
      email: customer.email,
    },
    env.JWT_SECRET,
    options
  );
}

/**
 * Optional, self-service password change while logged in (not forced — customers
 * may keep their default/generated password indefinitely if they prefer).
 * Requires the customer's current password to authorize the change.
 * Returns null when the customerId is unknown or currentPassword is wrong.
 */
export async function setCustomerPassword(
  customerId: string,
  organizationId: string,
  currentPassword: string,
  newPassword: string
): Promise<CustomerAuthRow | null> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
  });
  if (!customer || !customer.passwordHash) return null;

  const ok = await bcrypt.compare(currentPassword, customer.passwordHash);
  if (!ok) return null;

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.customer.update({
    where: { id: customer.id },
    data: { passwordHash, passwordUpdatedAt: new Date() },
  });

  return {
    id: updated.id,
    organizationId: updated.organizationId,
    name: updated.name,
    phone: updated.phone,
    email: updated.email,
    passwordHash: updated.passwordHash,
    isInactive: updated.isInactive,
  };
}

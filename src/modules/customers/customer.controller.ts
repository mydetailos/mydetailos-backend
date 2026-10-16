import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  listCustomers,
  getCustomerById,
  createCustomer,
  createCustomersBulk,
  updateCustomer,
  deleteCustomer,
  adjustWallet,
} from "./customer.service.js";
import { sendCustomerCredentialsWhatsApp } from "./customer-credentials-notify.service.js";
import { resolveBranchScope } from "../../lib/data-scope.js";
import { parsePagination } from "../../lib/pagination.js";
import { customerPasswordSchema } from "../../lib/password-policy.js";

const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);

const createSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.preprocess(trimmed, z.union([z.literal(""), z.string().email()])),
  address: z.preprocess(trimmed, z.string()),
  referralCode: z.string().min(1),
  referredBy: z.string().optional(),
  totalVisits: z.number().int().nonnegative().optional(),
  rewardPoints: z.number().int().nonnegative().optional(),
  walletBalance: z.number().nonnegative().optional(),
  lastVisitDate: z.string().optional(),
  isInactive: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
  avatar: z.string().optional().nullable(),
  /** Optional customer-portal login password (admin-set onboarding). */
  password: customerPasswordSchema.optional(),
});

const updateSchema = createSchema.partial().omit({ referredBy: true });

const bulkItemSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.preprocess(
    trimmed,
    z.union([z.literal(""), z.string().email()]).optional()
  ),
  address: z.preprocess(trimmed, z.string().optional()),
});

const bulkSchema = z.object({
  customers: z.array(bulkItemSchema).min(1).max(5000),
});

const walletSchema = z.object({
  amount: z.number().positive(),
  type: z.enum(["CREDIT", "DEBIT"]).default("CREDIT"),
  reason: z.string().min(1).default("Manual Adjustment"),
});

async function requireOrg(req: Request) {
  if (!req.auth) return null;
  return resolveBranchScope(req.auth);
}

function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0]! : raw!;
}

export async function getCustomers(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.json({ data: { customers: [] }, error: null });
      return;
    }
    const { page, pageSize } = parsePagination(req);
    const result = await listCustomers({ organizationId: scope.organizationId, page, pageSize });
    if (Array.isArray(result)) {
       res.json({ data: { customers: result }, error: null });
    } else {
       res.json({ data: { ...result, customers: result.items }, error: null });
    }
  } catch (e) {
    next(e);
  }
}

export async function getCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const customer = await getCustomerById(paramId(req), scope.organizationId);
    if (!customer) {
      res.status(404).json({ data: null, error: { message: "Customer not found" } });
      return;
    }
    res.json({ data: { customer }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function postCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = createSchema.parse(req.body);
    const result = await createCustomer({
      ...body,
      organizationId: scope.organizationId,
      passwordCreatedBy: body.password ? req.auth?.id : undefined,
      createdByUserId: req.auth?.id,
      updatedByUserId: req.auth?.id,
    });

    let credentialsSent = false;
    const passwordToSend = result.temporaryPassword || body.password;
    if (passwordToSend) {
      const outcome = await sendCustomerCredentialsWhatsApp({
        organizationId: scope.organizationId,
        customerId: result.customer.id,
        customerName: result.customer.name,
        phone: result.customer.phone,
        plainPassword: passwordToSend,
      });
      credentialsSent = outcome.sent;
    }

    res.status(201).json({
      data: {
        customer: result.customer,
        temporaryPassword: result.temporaryPassword,
        credentialsSent,
      },
      error: null,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "Phone already in use") {
      res.status(409).json({ data: null, error: { message: e.message } });
      return;
    }
    next(e);
  }
}

export async function postCustomersBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = bulkSchema.parse(req.body);
    const result = await createCustomersBulk(
      scope.organizationId,
      body.customers.map((c) => ({
        name: c.name,
        phone: c.phone,
        email: c.email ?? "",
        address: c.address ?? "",
      }))
    );
    res.status(201).json({
      data: {
        created: result.created,
        skipped: result.skipped,
        createdCount: result.created.length,
        skippedCount: result.skipped.length,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function putCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = updateSchema.parse(req.body);
    const customer = await updateCustomer(paramId(req), scope.organizationId, {
      ...body,
      passwordCreatedBy: body.password ? req.auth?.id : undefined,
      updatedByUserId: req.auth?.id,
    });
    if (!customer) {
      res.status(404).json({ data: null, error: { message: "Customer not found" } });
      return;
    }

    let credentialsSent = false;
    if (body.password) {
      const outcome = await sendCustomerCredentialsWhatsApp({
        organizationId: scope.organizationId,
        customerId: customer.id,
        customerName: customer.name,
        phone: customer.phone,
        plainPassword: body.password,
      });
      credentialsSent = outcome.sent;
    }

    res.json({
      data: body.password ? { customer, credentialsSent } : { customer },
      error: null,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "Phone already in use") {
      res.status(409).json({ data: null, error: { message: e.message } });
      return;
    }
    next(e);
  }
}

export async function removeCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const ok = await deleteCustomer(paramId(req), scope.organizationId, req.auth?.id);
    if (!ok) {
      res.status(404).json({ data: null, error: { message: "Customer not found" } });
      return;
    }
    res.json({ data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function patchWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = walletSchema.parse(req.body);
    const customer = await adjustWallet(
      paramId(req),
      scope.organizationId,
      body.amount,
      body.type,
      body.reason
    );
    if (!customer) {
      res.status(404).json({ data: null, error: { message: "Customer not found" } });
      return;
    }
    res.json({ data: { customer }, error: null });
  } catch (e) {
    if (e instanceof Error && e.message === "Wallet balance cannot be negative") {
      res.status(400).json({ data: null, error: { message: e.message } });
      return;
    }
    next(e);
  }
}

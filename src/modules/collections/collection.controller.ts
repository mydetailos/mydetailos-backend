import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AppRole } from "../../middleware/auth.js";
import {
  isArrayCollection,
  isSingletonCollection,
  SINGLETON_ENTITY_ID,
} from "../../constants/json-collections.js";
import { PAYROLL_ACCESS_ROLES } from "../../lib/rbac.js";
import { persistBusinessLogoFile } from "../../services/object-storage.service.js";
import {
  assertPayloadEntityIdMatch,
  parseCollectionPayload,
  parseCollectionSnapshotItems,
} from "../../validations/collection-payloads.js";
import { ApiErrorCode } from "../../lib/app-error.js";
import { intersectQueryBranchId, resolveBranchScope } from "../../lib/data-scope.js";
import {
  getCollectionDomainHandlers,
  type CollectionWriteContext,
} from "./collection.dispatcher.js";
import { parsePagination } from "../../lib/pagination.js";

function forbidden(res: Response, message: string) {
  res.status(403).json({
    data: null,
    error: { message, code: ApiErrorCode.FORBIDDEN },
  });
}

function assertPayrollAccess(
  res: Response,
  collection: string,
  role: AppRole | undefined
): boolean {
  if (collection !== "payroll") return true;
  if (role && (PAYROLL_ACCESS_ROLES as readonly string[]).includes(role)) return true;
  forbidden(res, "You do not have access to payroll data.");
  return false;
}

function collectionParam(req: Request): string {
  const raw = req.params.collection;
  return Array.isArray(raw) ? raw[0]! : raw!;
}

function isPickupDropWriteBlocked(): boolean {
  const raw = process.env.BLOCK_PICKUP_DROP_WRITES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function assertPickupDropWritesAllowed(res: Response, collection: string): boolean {
  if (collection !== "pickupDropRequests") return true;
  if (!isPickupDropWriteBlocked()) return true;
  res.status(403).json({
    data: null,
    error: {
      message: "Pickup/Drop writes are temporarily blocked.",
      code: ApiErrorCode.FORBIDDEN,
    },
  });
  return false;
}

function entityParam(req: Request): string {
  const raw = req.params.entityId;
  return Array.isArray(raw) ? raw[0]! : raw!;
}

export function writeContext(req: Request, organizationId: string): CollectionWriteContext {
  const hasJobCardPricingPermission = Boolean(
    req.auth &&
      (req.auth.role === "SUPER_ADMIN" || req.auth.permissions?.includes("JOB_CARD_PRICING"))
  );
  return { organizationId, hasJobCardPricingPermission, userId: req.auth?.id };
}

export async function getCollection(req: Request, res: Response, next: NextFunction) {
  try {
    const collection = collectionParam(req);
    if (!isArrayCollection(collection) && !isSingletonCollection(collection)) {
      res.status(400).json({ data: null, error: { message: "Unknown collection" } });
      return;
    }
    if (!assertPayrollAccess(res, collection, req.auth?.role)) return;

    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const scope = await resolveBranchScope(req.auth);
    if (!scope) {
      res.json({ data: { items: [] }, error: null });
      return;
    }
    const q = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
    const allowedBranchIds = intersectQueryBranchId(scope, q);

    const { page, pageSize } = parsePagination(req);

    const domain = getCollectionDomainHandlers(collection);
    const result = await domain.list(scope.organizationId, allowedBranchIds, { page, pageSize });
    if (Array.isArray(result)) {
      res.json({ data: { items: result }, error: null });
    } else {
      res.json({ data: result, error: null });
    }
  } catch (e) {
    next(e);
  }
}

export async function getCollectionItem(req: Request, res: Response, next: NextFunction) {
  try {
    const collection = collectionParam(req);
    if (!isArrayCollection(collection) && !isSingletonCollection(collection)) {
      res.status(400).json({ data: null, error: { message: "Unknown collection" } });
      return;
    }
    if (!assertPayrollAccess(res, collection, req.auth?.role)) return;
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const scope = await resolveBranchScope(req.auth);
    if (!scope) {
      res.status(404).json({ data: null, error: { message: "Not found" } });
      return;
    }
    const entityId = entityParam(req);
    const domain = getCollectionDomainHandlers(collection);
    const item = await domain.get(scope.organizationId, entityId);
    if (item === null || item === undefined) {
      res.status(404).json({ data: null, error: { message: "Not found" } });
      return;
    }
    res.json({ data: { item }, error: null });
  } catch (e) {
    next(e);
  }
}

const snapshotSchema = z.object({
  items: z.array(z.unknown()),
});

export async function postSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const collection = collectionParam(req);
    if (!isArrayCollection(collection)) {
      res.status(400).json({ data: null, error: { message: "Snapshot only for array collections" } });
      return;
    }
    if (!assertPickupDropWritesAllowed(res, collection)) return;
    if (!assertPayrollAccess(res, collection, req.auth?.role)) return;
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const scope = await resolveBranchScope(req.auth);
    if (!scope) {
      forbidden(res, "Organization not found on user");
      return;
    }
    const body = snapshotSchema.parse(req.body);
    const items = parseCollectionSnapshotItems(collection, body.items);

    const domain = getCollectionDomainHandlers(collection);
    const ctx = writeContext(req, scope.organizationId);
    await domain.replace(items, ctx);
    res.json({ data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function putCollectionItem(req: Request, res: Response, next: NextFunction) {
  try {
    const collection = collectionParam(req);
    const entityId = entityParam(req);
    if (!isArrayCollection(collection) && !isSingletonCollection(collection)) {
      res.status(400).json({
        data: null,
        error: { message: "Unknown collection", code: ApiErrorCode.VALIDATION },
      });
      return;
    }
    if (isSingletonCollection(collection) && entityId !== SINGLETON_ENTITY_ID) {
      res.status(400).json({
        data: null,
        error: { message: "Invalid singleton id", code: ApiErrorCode.VALIDATION },
      });
      return;
    }
    if (!assertPickupDropWritesAllowed(res, collection)) return;
    if (!assertPayrollAccess(res, collection, req.auth?.role)) return;
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const scope = await resolveBranchScope(req.auth);
    if (!scope) {
      forbidden(res, "Organization not found on user");
      return;
    }
    const payload = parseCollectionPayload(collection, req.body);
    assertPayloadEntityIdMatch(collection, entityId, payload);

    const domain = getCollectionDomainHandlers(collection);
    const ctx = writeContext(req, scope.organizationId);
    await domain.upsert(entityId, payload, ctx);
    res.json({ data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function deleteCollectionRow(req: Request, res: Response, next: NextFunction) {
  try {
    const collection = collectionParam(req);
    const entityId = entityParam(req);
    if (!isArrayCollection(collection)) {
      res.status(400).json({ data: null, error: { message: "Delete only for array collections" } });
      return;
    }
    if (!assertPayrollAccess(res, collection, req.auth?.role)) return;
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const scope = await resolveBranchScope(req.auth);
    if (!scope) {
      forbidden(res, "Organization not found on user");
      return;
    }
    const domain = getCollectionDomainHandlers(collection);
    const ctx = writeContext(req, scope.organizationId);
    const ok = await domain.delete(scope.organizationId, entityId, ctx);
    if (!ok) {
      res.status(404).json({ data: null, error: { message: "Not found" } });
      return;
    }
    res.json({ data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function postAppSettingsLogo(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const file = req.file;
    if (!file?.buffer) {
      res.status(400).json({ data: null, error: { message: "No image file provided." } });
      return;
    }
    const url = await persistBusinessLogoFile({
      buffer: file.buffer,
      mimeType: file.mimetype,
      uploadedBy: req.auth.id,
    });
    res.json({ data: { url }, error: null });
  } catch (e) {
    next(e);
  }
}

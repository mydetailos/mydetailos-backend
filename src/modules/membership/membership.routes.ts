import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { resolveBranchScope } from "../../lib/data-scope.js";
import { membershipPayloadSchema } from "../../validations/collection-payloads.js";
import { getCollectionItem, upsertCollectionItem } from "../collections/app-json-store.js";
import { writeContext } from "../collections/collection.controller.js";

export const membershipRouter = Router();

membershipRouter.use(requireAuth);

/**
 * GET /api/v1/membership or /api/membership
 * Read the organization's membership singleton document.
 */
membershipRouter.get(
  ["/", "/default"],
  requirePermission("MEMBERSHIP"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        res.status(401).json({ data: null, error: { message: "Unauthorized" } });
        return;
      }
      const scope = await resolveBranchScope(req.auth);
      if (!scope) {
        res.status(404).json({ data: null, error: { message: "Organization not found" } });
        return;
      }
      const item = await getCollectionItem("membership", "default", scope.organizationId);
      res.json({ data: { item: item ?? { packages: [], subscriptions: [] } }, error: null });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * PUT /api/v1/membership or /api/membership
 * Upsert the membership singleton document, validating packages and subscriptions.
 * Permits and preserves membershipId?: string in usageHistory items.
 */
membershipRouter.put(
  ["/", "/default"],
  requirePermission("MEMBERSHIP"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        res.status(401).json({ data: null, error: { message: "Unauthorized" } });
        return;
      }
      const scope = await resolveBranchScope(req.auth);
      if (!scope) {
        res.status(403).json({ data: null, error: { message: "Organization not found on user" } });
        return;
      }

      const payload = membershipPayloadSchema.parse(req.body);
      const ctx = writeContext(req, scope.organizationId);
      await upsertCollectionItem("membership", "default", payload, scope.organizationId, ctx);

      res.json({ data: { ok: true, item: payload }, error: null });
    } catch (e) {
      next(e);
    }
  }
);

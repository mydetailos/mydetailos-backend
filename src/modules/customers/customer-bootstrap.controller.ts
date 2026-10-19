import type { Request, Response, NextFunction } from "express";
import { AppError } from "../../lib/app-error.js";
import {
  getCustomerBootstrapPayload,
  getCustomerMembershipsPayload,
} from "./customer-bootstrap.service.js";

/**
 * GET /api/customer/bootstrap
 * `customerId` and `organizationId` come only from the verified JWT (`req.auth`),
 * never from query/body — enforced by `requireCustomerAuth` upstream.
 */
export async function getCustomerBootstrap(req: Request, res: Response, next: NextFunction) {
  try {
    const customerId = req.auth?.customerId;
    const organizationId = req.auth?.organizationId;
    if (!customerId || !organizationId) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }

    const payload = await getCustomerBootstrapPayload(customerId, organizationId);
    if (!payload) {
      throw AppError.notFound("Customer not found");
    }

    res.json({ data: payload, error: null });
  } catch (e) {
    next(e);
  }
}

/**
 * GET /api/customer/memberships
 * Dedicated endpoint returning customer's membership records.
 */
export async function getCustomerMemberships(req: Request, res: Response, next: NextFunction) {
  try {
    const customerId = req.auth?.customerId;
    const organizationId = req.auth?.organizationId;
    if (!customerId || !organizationId) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }

    const memberships = await getCustomerMembershipsPayload(customerId, organizationId);
    res.json({
      data: {
        memberships,
        subscriptions: memberships,
        customerMemberships: memberships,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

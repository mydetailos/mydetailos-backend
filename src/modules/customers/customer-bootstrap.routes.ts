import { Router } from "express";
import { requireAuth, requireCustomerAuth } from "../../middleware/auth.js";
import {
  getCustomerBootstrap,
  getCustomerMemberships,
} from "./customer-bootstrap.controller.js";

export const customerBootstrapRouter = Router();

customerBootstrapRouter.get(
  "/bootstrap",
  requireAuth,
  requireCustomerAuth,
  getCustomerBootstrap
);

customerBootstrapRouter.get(
  "/memberships",
  requireAuth,
  requireCustomerAuth,
  getCustomerMemberships
);

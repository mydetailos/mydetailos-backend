import { Router } from "express";
import { requireAuth, requireCustomerAuth } from "../../middleware/auth.js";
import {
  postCustomerLogin,
  postCustomerSendOtp,
  getCustomerMe,
  postCustomerLogout,
  postCustomerSetPassword,
  getCustomerLookup,
} from "./customer-auth.controller.js";

export const customerAuthRouter = Router();

customerAuthRouter.get("/lookup", getCustomerLookup);
customerAuthRouter.post("/otp/send", postCustomerSendOtp);
customerAuthRouter.post("/otp/verify", postCustomerLogin);
customerAuthRouter.post("/login", postCustomerLogin);
customerAuthRouter.get("/me", requireAuth, requireCustomerAuth, getCustomerMe);
customerAuthRouter.post("/logout", requireAuth, requireCustomerAuth, postCustomerLogout);
customerAuthRouter.post(
  "/set-password",
  requireAuth,
  requireCustomerAuth,
  postCustomerSetPassword
);

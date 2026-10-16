import { Router } from "express";
import {
  getPublicPlans,
  getPublicReferral,
  postPublicContact,
  postPublicPricingQuote,
  postPublicSignup,
  postPublicSignupSendOtp,
} from "../controllers/public.controller.js";
import { getPublicInspectionDocument } from "../modules/inspections/inspections.controller.js";

export const publicRouter = Router();

publicRouter.post("/signup/otp/send", postPublicSignupSendOtp);
publicRouter.post("/signup", postPublicSignup);
publicRouter.post("/contact", postPublicContact);
publicRouter.get("/plans", getPublicPlans);
publicRouter.get("/referral/:code", getPublicReferral);
publicRouter.post("/pricing/quote", postPublicPricingQuote);
publicRouter.post("/subscription/pricing", postPublicPricingQuote);
publicRouter.get("/inspection-documents/:versionId", getPublicInspectionDocument);

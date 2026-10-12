import { Router } from "express";
import { requirePlatformAuth } from "../../middleware/platform-auth.js";
import {
  getPlatformOrganization,
  listPlatformOrganizations,
  patchPlatformOrganizationSubscription,
  postPlatformMarkPaid,
  postPlatformPaymentLink,
  postPlatformPaymentLinkResend,
  postPlatformVerifyPayment,
} from "../organization/organization.controller.js";
import {
  getPlatformDashboard,
  listPlatformUsers,
  listPlatformBranches,
  postPlatformOrganizationBranch,
  listPlatformRenewals,
  listPlatformBills,
  listPlatformPayments,
  listPlatformAudit,
  listPlatformOrganizationActivity,
  listPlatformReferrals,
  createPlatformReferral,
  patchPlatformReferral,
  listPlatformReferralWallets,
  getPlatformPlans,
  putPlatformPlans,
  postPlatformPlan,
  patchPlatformPlan,
  deletePlatformPlanHandler,
  getPlatformSettingsHandler,
  putPlatformSettingsHandler,
  getPlatformMessagingStatus,
  postPlatformMessagingTest,
  getPlatformSmsMessageStatus,
  suspendOrganization,
  restoreOrganization,
  deletePlatformOrganization,
  postPlatformProvisionOrganization,
  postPlatformConvertTrial,
  listPlatformContacts,
} from "./platform.controller.js";
import {
  listPlatformBanners,
  createPlatformBanner,
  patchPlatformBanner,
  deletePlatformBanner,
} from "./marketing-banners.controller.js";
import {
  listSupportTickets,
  getSupportTicket,
  patchSupportTicket,
  replySupportTicket,
} from "./support-tickets.controller.js";
import {
  listDemoRequests,
  getDemoRequest,
  patchDemoRequest,
} from "./demo-requests.controller.js";

export const platformRouter = Router();

platformRouter.use(requirePlatformAuth);

platformRouter.get("/dashboard", getPlatformDashboard);

platformRouter.get("/users", listPlatformUsers);
platformRouter.get("/branches", listPlatformBranches);

// Existing org endpoints
platformRouter.get("/organizations", listPlatformOrganizations);
// Static path must be registered before :orgId
platformRouter.post("/organizations/provision", postPlatformProvisionOrganization);
platformRouter.get("/organizations/:orgId", getPlatformOrganization);
platformRouter.patch("/organizations/:orgId/subscription", patchPlatformOrganizationSubscription);
platformRouter.post("/organizations/:orgId/subscription/verify-payment", postPlatformVerifyPayment);
platformRouter.post("/organizations/:orgId/subscription/mark-paid", postPlatformMarkPaid);
platformRouter.post("/organizations/:orgId/subscription/payment-link", postPlatformPaymentLink);
platformRouter.post(
  "/organizations/:orgId/subscription/payment-link/:paymentId/resend",
  postPlatformPaymentLinkResend
);
platformRouter.post("/organizations/:orgId/subscription/convert-trial", postPlatformConvertTrial);
platformRouter.post("/organizations/:orgId/branches", postPlatformOrganizationBranch);

// Suspend / restore / delete
platformRouter.post("/organizations/:orgId/suspend", suspendOrganization);
platformRouter.post("/organizations/:orgId/restore", restoreOrganization);
platformRouter.delete("/organizations/:orgId", deletePlatformOrganization);
platformRouter.get("/organizations/:orgId/activity", listPlatformOrganizationActivity);

// Cross-org data endpoints
platformRouter.get("/renewals", listPlatformRenewals);
platformRouter.get("/bills", listPlatformBills);
platformRouter.get("/payments", listPlatformPayments);
platformRouter.get("/audit", listPlatformAudit);
platformRouter.get("/referrals", listPlatformReferrals);
platformRouter.post("/referrals", createPlatformReferral);
platformRouter.patch("/referrals/:id", patchPlatformReferral);
platformRouter.get("/referral-wallets", listPlatformReferralWallets);

platformRouter.get("/banners", listPlatformBanners);
platformRouter.post("/banners", createPlatformBanner);
platformRouter.patch("/banners/:id", patchPlatformBanner);
platformRouter.delete("/banners/:id", deletePlatformBanner);

platformRouter.get("/plans", getPlatformPlans);
platformRouter.put("/plans", putPlatformPlans);
platformRouter.post("/plans", postPlatformPlan);
platformRouter.patch("/plans/:code", patchPlatformPlan);
platformRouter.delete("/plans/:code", deletePlatformPlanHandler);

platformRouter.get("/settings", getPlatformSettingsHandler);
platformRouter.put("/settings", putPlatformSettingsHandler);

platformRouter.get("/messaging", getPlatformMessagingStatus);
platformRouter.get("/messaging/sms/:sid", getPlatformSmsMessageStatus);
platformRouter.post("/messaging/test", postPlatformMessagingTest);

platformRouter.get("/contacts", listPlatformContacts);

platformRouter.get("/support-tickets", listSupportTickets);
platformRouter.get("/support-tickets/:id", getSupportTicket);
platformRouter.patch("/support-tickets/:id", patchSupportTicket);
platformRouter.post("/support-tickets/:id/reply", replySupportTicket);

platformRouter.get("/demo-requests", listDemoRequests);
platformRouter.get("/demo-requests/:id", getDemoRequest);
platformRouter.patch("/demo-requests/:id", patchDemoRequest);

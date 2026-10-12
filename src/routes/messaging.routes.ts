import { Router } from "express";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import {
  postSmsTest,
  postSmsStatus,
  postTransactionalEmail,
  postWhatsApp,
  postWhatsAppTest,
} from "../controllers/messaging.controller.js";

export const messagingRouter = Router();

messagingRouter.post("/sms/status", postSmsStatus);

messagingRouter.use(requireAuth);

/** Test/diagnostic sends — settings admins only. Operational send stays auth-only (cross-feature). */
messagingRouter.post("/sms/test", requirePermission("SETTINGS"), postSmsTest);
messagingRouter.post("/whatsapp/test", requirePermission("SETTINGS"), postWhatsAppTest);
messagingRouter.post("/whatsapp", postWhatsApp);
messagingRouter.post("/email", postTransactionalEmail);

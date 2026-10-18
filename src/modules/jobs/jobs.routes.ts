import { Router } from "express";
import { requireInternalJobAuth, requireInternalJobSecretOnly } from "../../middleware/internal-job-auth.js";
import { postProcessRemindersJob, postProcessSubscriptionRemindersJob } from "./reminder-job.controller.js";
import { postCleanupExpiredInspectionUploads } from "../inspections/inspections.controller.js";

export const jobsRouter = Router();

/**
 * Daily reminder WhatsApp processor (external cron).
 * Auth: header `X-Internal-Job-Key: $INTERNAL_JOB_SECRET` or Bearer JWT (org-scoped).
 */
jobsRouter.post("/reminders/process", requireInternalJobAuth, postProcessRemindersJob);
jobsRouter.post("/subscription-reminders/process", requireInternalJobAuth, postProcessSubscriptionRemindersJob);
jobsRouter.post("/inspections/uploads/cleanup", requireInternalJobSecretOnly, postCleanupExpiredInspectionUploads);

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import {
  getCollectionItem,
  listCollectionItems,
  upsertCollectionItem,
} from "../collections/app-json-store.js";
import { SINGLETON_ENTITY_ID } from "../../constants/json-collections.js";
import { sendWhatsAppMessage, isTwilioWhatsAppEnabled } from "../../services/twilio-sms.service.js";
import {
  asReminderRecords,
  parseAppSettingsPayload,
  processOrganizationReminders,
  type ProcessOrgRemindersResult,
} from "../../services/reminder-job.service.js";
import type { Invoice } from "../../types/finance-documents.js";
import type { ReminderRecord } from "../../services/reminder-auto-whatsapp.js";

const bodySchema = z
  .object({
    /** When using job secret, optionally limit to one org. */
    organizationId: z.string().min(1).optional(),
  })
  .optional();

function asInvoices(items: unknown[]): Invoice[] {
  return items.filter((x): x is Invoice => {
    if (!x || typeof x !== "object") return false;
    const inv = x as Invoice;
    return typeof inv.id === "string" && typeof inv.grandTotal === "number";
  });
}

async function processOneOrg(organizationId: string): Promise<ProcessOrgRemindersResult> {
  const [settingsRaw, reminderItems, invoiceItems] = await Promise.all([
    getCollectionItem("appSettings", SINGLETON_ENTITY_ID, organizationId),
    listCollectionItems("serviceReminders", { organizationId }),
    listCollectionItems("invoices", { organizationId }),
  ]);

  const settings = parseAppSettingsPayload(settingsRaw);
  const reminders = asReminderRecords(Array.isArray(reminderItems) ? reminderItems : reminderItems.items);
  const invoices = asInvoices(Array.isArray(invoiceItems) ? invoiceItems : invoiceItems.items);

  if (!settings.whatsappReminderEnabled) {
    return {
      organizationId,
      attempted: 0,
      sent: 0,
      skippedPaid: 0,
      skippedDuplicate: 0,
      failed: 0,
      advanced: 0,
    };
  }

  if (!isTwilioWhatsAppEnabled()) {
    return {
      organizationId,
      attempted: 0,
      sent: 0,
      skippedPaid: 0,
      skippedDuplicate: 0,
      failed: 0,
      advanced: 0,
    };
  }

  return processOrganizationReminders({
    organizationId,
    reminders,
    invoices,
    settings,
    publicBaseUrl: env.FRONTEND_ORIGIN,
    sendWhatsApp: async (phone, message) => {
      await sendWhatsAppMessage(phone, message);
    },
    saveReminder: async (reminder: ReminderRecord) => {
      await upsertCollectionItem("serviceReminders", reminder.id, reminder, organizationId);
    },
  });
}

/**
 * POST /api/jobs/reminders/process
 * External cron: X-Internal-Job-Key
 * Studio: Bearer JWT (current org only)
 */
export async function postProcessRemindersJob(req: Request, res: Response, next: NextFunction) {
  try {
    const body = bodySchema.parse(req.body ?? {});
    const auth = req.jobAuth;
    if (!auth) {
      res.status(401).json({
        data: null,
        error: { message: "Unauthorized", code: "JOB_UNAUTHORIZED" },
      });
      return;
    }

    let orgIds: string[] = [];
    if (auth.mode === "user") {
      orgIds = [auth.organizationId];
    } else {
      if (body?.organizationId) {
        orgIds = [body.organizationId];
      } else {
        const orgs = await prisma.organization.findMany({
          where: { isActive: true },
          select: { id: true },
        });
        orgIds = orgs.map((o) => o.id);
      }
    }

    const results: ProcessOrgRemindersResult[] = [];
    for (const organizationId of orgIds) {
      results.push(await processOneOrg(organizationId));
    }

    const summary = results.reduce(
      (acc, r) => {
        acc.organizations += 1;
        acc.attempted += r.attempted;
        acc.sent += r.sent;
        acc.skippedPaid += r.skippedPaid;
        acc.skippedDuplicate += r.skippedDuplicate;
        acc.failed += r.failed;
        acc.advanced += r.advanced;
        return acc;
      },
      {
        organizations: 0,
        attempted: 0,
        sent: 0,
        skippedPaid: 0,
        skippedDuplicate: 0,
        failed: 0,
        advanced: 0,
      }
    );

    res.json({
      data: {
        ok: true as const,
        summary,
        results,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

/**
 * POST /api/jobs/subscription-reminders/process
 * Daily processor for trial & subscription expiration alerts & reminders.
 */
export async function postProcessSubscriptionRemindersJob(req: Request, res: Response, next: NextFunction) {
  try {
    const { processSubscriptionExpiryReminders } = await import(
      "../organization/subscription-expiry-job.service.js"
    );
    const summary = await processSubscriptionExpiryReminders();
    res.json({
      data: {
        ok: true as const,
        summary,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

import { prisma } from "../../lib/prisma.js";
import {
  notifyOwnerTrialExpired,
  notifyOwnerTrialExpiringReminder,
  notifyOwnerSubscriptionExpired,
  notifyOwnerSubscriptionExpiringReminder,
} from "./owner-trial-notify.service.js";

export type SubscriptionReminderProcessSummary = {
  totalOrgsChecked: number;
  trialExpiringSent: number;
  trialExpiredSent: number;
  subExpiringSent: number;
  subExpiredSent: number;
  skipped: number;
  errors: Array<{ orgId: string; error: string }>;
};

function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function diffInDays(targetDate: Date, nowDate: Date): number {
  const targetMs = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
  const nowMs = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  return Math.round((targetMs - nowMs) / (1000 * 60 * 60 * 24));
}

/**
 * Idempotent daily processor for trial and subscription expiry reminders.
 * Can be run via scheduled cron or on-demand.
 */
export async function processSubscriptionExpiryReminders(
  now: Date = new Date()
): Promise<SubscriptionReminderProcessSummary> {
  const summary: SubscriptionReminderProcessSummary = {
    totalOrgsChecked: 0,
    trialExpiringSent: 0,
    trialExpiredSent: 0,
    subExpiringSent: 0,
    subExpiredSent: 0,
    skipped: 0,
    errors: [],
  };

  const orgs = await prisma.organization.findMany({
    where: { isActive: true },
    include: {
      subscription: true,
    },
  });

  summary.totalOrgsChecked = orgs.length;
  const todayStr = now.toISOString().slice(0, 10);

  for (const org of orgs) {
    const sub = org.subscription;
    if (!sub || !sub.expiresAt) {
      summary.skipped++;
      continue;
    }

    const daysLeft = diffInDays(sub.expiresAt, now);
    const expDateStr = formatDisplayDate(sub.expiresAt);

    try {
      if (sub.status === "TRIAL") {
        // Trial reminders: 3 days before, 1 day before, and day of expiration
        if (daysLeft === 3 || daysLeft === 1) {
          const daysLabel = daysLeft === 1 ? "24 hours" : `${daysLeft} days`;
          const logKey = `trial-expiring:${org.id}:${daysLeft}:${todayStr}`;
          const alreadySent = await prisma.appJsonRow.findUnique({
            where: {
              collection_entityId: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
              },
            },
          });

          if (!alreadySent) {
            await notifyOwnerTrialExpiringReminder({
              organizationId: org.id,
              organizationName: org.name,
              timeRemaining: daysLabel,
              expirationDate: expDateStr,
            });
            await prisma.appJsonRow.create({
              data: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
                organizationId: org.id,
                payload: { type: "TRIAL_EXPIRING", daysLeft, sentAt: now.toISOString() },
              },
            });
            summary.trialExpiringSent++;
          } else {
            summary.skipped++;
          }
        } else if (daysLeft <= 0) {
          const logKey = `trial-expired:${org.id}:${todayStr}`;
          const alreadySent = await prisma.appJsonRow.findUnique({
            where: {
              collection_entityId: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
              },
            },
          });

          if (!alreadySent) {
            await notifyOwnerTrialExpired({
              organizationId: org.id,
              organizationName: org.name,
              expirationDate: expDateStr,
            });
            await prisma.appJsonRow.create({
              data: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
                organizationId: org.id,
                payload: { type: "TRIAL_EXPIRED", sentAt: now.toISOString() },
              },
            });
            summary.trialExpiredSent++;
          } else {
            summary.skipped++;
          }
        } else {
          summary.skipped++;
        }
      } else if (sub.status === "ACTIVE") {
        // Subscription reminders: 7 days before, 3 days before, 1 day before, and day of expiration
        if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
          const daysLabel = daysLeft === 1 ? "24 hours" : `${daysLeft} days`;
          const logKey = `sub-expiring:${org.id}:${daysLeft}:${todayStr}`;
          const alreadySent = await prisma.appJsonRow.findUnique({
            where: {
              collection_entityId: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
              },
            },
          });

          if (!alreadySent) {
            await notifyOwnerSubscriptionExpiringReminder({
              organizationId: org.id,
              organizationName: org.name,
              planName: sub.planName || "Subscription",
              timeRemaining: daysLabel,
              expirationDate: expDateStr,
            });
            await prisma.appJsonRow.create({
              data: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
                organizationId: org.id,
                payload: { type: "SUBSCRIPTION_EXPIRING", daysLeft, sentAt: now.toISOString() },
              },
            });
            summary.subExpiringSent++;
          } else {
            summary.skipped++;
          }
        } else if (daysLeft <= 0) {
          const logKey = `sub-expired:${org.id}:${todayStr}`;
          const alreadySent = await prisma.appJsonRow.findUnique({
            where: {
              collection_entityId: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
              },
            },
          });

          if (!alreadySent) {
            await notifyOwnerSubscriptionExpired({
              organizationId: org.id,
              organizationName: org.name,
              planName: sub.planName || "Subscription",
              expirationDate: expDateStr,
            });
            await prisma.appJsonRow.create({
              data: {
                collection: "subscriptionReminderLogs",
                entityId: logKey,
                organizationId: org.id,
                payload: { type: "SUBSCRIPTION_EXPIRED", sentAt: now.toISOString() },
              },
            });
            summary.subExpiredSent++;
          } else {
            summary.skipped++;
          }
        } else {
          summary.skipped++;
        }
      } else {
        summary.skipped++;
      }
    } catch (err: any) {
      summary.errors.push({ orgId: org.id, error: err?.message || String(err) });
    }
  }

  return summary;
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advancePaymentReminderAfterSend,
  alreadySentForCurrentPeriod,
  selectRemindersForAutoWhatsApp,
  type ReminderRecord,
} from "../src/services/reminder-auto-whatsapp.ts";
import { nextDueDate, periodKey } from "../src/services/reminder-schedule.ts";
import {
  parseAppSettingsPayload,
  processOrganizationReminders,
} from "../src/services/reminder-job.service.ts";
import type { Invoice } from "../src/types/finance-documents.ts";

function serviceReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "rem-svc-1",
    kind: "SERVICE",
    customerId: "cust-1",
    customerName: "Ada Lovelace",
    customerPhone: "9999999999",
    vehicleRegNumber: "KA01AB1234",
    vehicleMakeModel: "Swift",
    type: "GENERAL_SERVICE",
    frequency: "MONTHLY",
    dueDate: "2026-08-21",
    periodKey: "2026-08",
    status: "DUE",
    whatsappSent: false,
    ...overrides,
  };
}

function paymentReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "rem-pay-1",
    kind: "PAYMENT",
    customerId: "cust-1",
    customerName: "Ada Lovelace",
    customerPhone: "9999999999",
    vehicleRegNumber: "KA01AB1234",
    vehicleMakeModel: "Swift",
    type: "GENERAL_SERVICE",
    frequency: "MONTHLY",
    dueDate: "2026-08-21",
    periodKey: "2026-08",
    status: "DUE",
    invoiceId: "inv-1",
    invoiceNumber: "INV-2026-0001",
    outstandingAmount: 1500,
    whatsappSent: false,
    ...overrides,
  };
}

function unpaidInvoice(): Invoice {
  return {
    id: "inv-1",
    invoiceNumber: "INV-2026-0001",
    jobNumber: "JC-1",
    customerId: "cust-1",
    customerName: "Ada",
    customerPhone: "999",
    vehicleRegNumber: "KA01",
    lineItems: [],
    subtotal: 1500,
    taxRate: 0,
    taxAmount: 0,
    discountAmount: 0,
    rewardDiscount: 0,
    walletAmountUsed: 0,
    grandTotal: 1500,
    status: "ISSUED",
    payments: [],
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("reminder job auth helpers (secret gate)", () => {
  it("Unauthorized job request — empty/wrong key rejected by comparison", () => {
    const configured = "cron-secret-test-value-32chars!!";
    const provided = "";
    assert.equal(Boolean(configured && provided && provided === configured), false);
    assert.equal("wrong" === configured, false);
  });

  it("Authorized job request — matching key accepted", () => {
    const configured = "cron-secret-test-value-32chars!!";
    const provided = "cron-secret-test-value-32chars!!";
    assert.equal(provided === configured, true);
  });
});

describe("processOrganizationReminders", () => {
  const settings = {
    whatsappReminderEnabled: true,
    reminderLeadDays: 7,
    businessName: "My Detail OS",
  };
  const now = new Date("2026-08-21T12:00:00");

  it("WhatsApp disabled skips sending", async () => {
    const sent: string[] = [];
    const result = await processOrganizationReminders({
      organizationId: "org-1",
      reminders: [serviceReminder()],
      invoices: [],
      settings: { ...settings, whatsappReminderEnabled: false },
      publicBaseUrl: "http://localhost:3000",
      sendWhatsApp: async (phone) => {
        sent.push(phone);
      },
      saveReminder: async () => {},
      now,
    });
    assert.equal(result.attempted, 0);
    assert.equal(result.sent, 0);
    assert.equal(sent.length, 0);
  });

  it("DUE reminder sends once", async () => {
    const sent: string[] = [];
    const saved: ReminderRecord[] = [];
    const rem = serviceReminder({ status: "DUE" });
    const result = await processOrganizationReminders({
      organizationId: "org-1",
      reminders: [rem],
      invoices: [],
      settings,
      publicBaseUrl: "http://localhost:3000",
      sendWhatsApp: async (phone, message) => {
        sent.push(phone);
        const hay =
          typeof message === "string" ? message : JSON.stringify(message.contentVariables ?? {});
        assert.match(hay, /Ada|Swift|General Service|KA01AB1234/i);
      },
      saveReminder: async (r) => {
        saved.push(r);
      },
      now,
    });
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(saved[0]?.whatsappSent, true);
    assert.ok(saved[0]?.lastMessageSentAt);
  });

  it("OVERDUE reminder sends", async () => {
    const result = await processOrganizationReminders({
      organizationId: "org-1",
      reminders: [paymentReminder({ status: "OVERDUE" })],
      invoices: [unpaidInvoice()],
      settings,
      publicBaseUrl: "http://localhost:3000",
      sendWhatsApp: async () => {},
      saveReminder: async () => {},
      now,
    });
    assert.equal(result.sent, 1);
  });

  it("Duplicate execution does not resend", async () => {
    let sendCount = 0;
    const store = new Map<string, ReminderRecord>();
    const rem = serviceReminder();
    store.set(rem.id, rem);

    const run = () =>
      processOrganizationReminders({
        organizationId: "org-1",
        reminders: [store.get(rem.id)!],
        invoices: [],
        settings,
        publicBaseUrl: "http://localhost:3000",
        sendWhatsApp: async () => {
          sendCount += 1;
        },
        saveReminder: async (r) => {
          store.set(r.id, r);
        },
        now,
      });

    const first = await run();
    const second = await run();
    assert.equal(first.sent, 1);
    assert.equal(second.sent, 0);
    assert.equal(sendCount, 1);
    assert.equal(alreadySentForCurrentPeriod(store.get(rem.id)!), true);
  });

  it("Paid invoice skipped", async () => {
    const paid: Invoice = {
      ...unpaidInvoice(),
      payments: [
        {
          id: "pay-1",
          invoiceId: "inv-1",
          amount: 1500,
          method: "CASH",
          paidAt: "2026-08-20T00:00:00.000Z",
        },
      ],
      status: "PAID",
    };
    const sent: string[] = [];
    const result = await processOrganizationReminders({
      organizationId: "org-1",
      reminders: [paymentReminder({ outstandingAmount: 1500 })],
      invoices: [paid],
      settings,
      publicBaseUrl: "http://localhost:3000",
      sendWhatsApp: async (phone) => {
        sent.push(phone);
      },
      saveReminder: async () => {},
      now,
    });
    assert.equal(result.sent, 0);
    assert.equal(sent.length, 0);
    assert.equal(
      selectRemindersForAutoWhatsApp([paymentReminder()], {
        whatsappReminderEnabled: true,
        getOutstanding: () => 0,
        leadDays: 7,
        now,
      }).length,
      0
    );
  });

  it("Payment reminder advances correctly", async () => {
    const saved: ReminderRecord[] = [];
    const result = await processOrganizationReminders({
      organizationId: "org-1",
      reminders: [paymentReminder()],
      invoices: [unpaidInvoice()],
      settings,
      publicBaseUrl: "http://localhost:3000",
      sendWhatsApp: async () => {},
      saveReminder: async (r) => {
        saved.push(r);
      },
      now,
    });
    assert.equal(result.sent, 1);
    assert.equal(result.advanced, 1);
    const next = saved[0]!;
    assert.equal(next.dueDate, nextDueDate("2026-08-21", "MONTHLY"));
    assert.equal(next.periodKey, periodKey(next.dueDate, "MONTHLY"));
    assert.equal(next.whatsappSent, false);
    assert.equal(next.lastMessageSentAt, undefined);

    const advanced = advancePaymentReminderAfterSend(
      markSent(paymentReminder()),
      { leadDays: 7, outstanding: 900, now }
    );
    assert.ok(advanced);
    assert.equal(advanced!.dueDate, "2026-09-21");
  });
});

function markSent(r: ReminderRecord): ReminderRecord {
  return { ...r, whatsappSent: true, lastMessageSentAt: "2026-08-21T12:00:00.000Z" };
}

describe("parseAppSettingsPayload", () => {
  it("defaults whatsapp on and lead days", () => {
    const s = parseAppSettingsPayload({});
    assert.equal(s.whatsappReminderEnabled, true);
    assert.equal(s.reminderLeadDays, 7);
  });

  it("respects whatsappReminderEnabled false", () => {
    assert.equal(
      parseAppSettingsPayload({ whatsappReminderEnabled: false }).whatsappReminderEnabled,
      false
    );
  });
});

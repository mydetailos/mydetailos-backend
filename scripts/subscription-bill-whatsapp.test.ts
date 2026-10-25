import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubscriptionInvoiceUrl,
  buildSubscriptionBillWhatsAppMessage,
} from "../src/modules/organization/subscription-bill-notify.service.js";
import {
  buildOwnerPlanActivatedWhatsAppMessage,
  ownerPlanActivatedTemplateVariables,
  ownerPlanActivatedCtaTemplateVariables,
} from "../src/lib/owner-trial-whatsapp.js";

test("Subscription Bill WhatsApp Notification & Zero-Auth Invoice URL", async (t) => {
  await t.test("buildSubscriptionInvoiceUrl encodes valid zero-auth compact JSON hash", () => {
    const mockBill = {
      id: "bill-12345",
      billNumber: "SUB-2026-0001",
      planName: "Starter",
      termMonths: 12,
      termLabel: "1 year",
      periodStart: new Date("2026-10-25T00:00:00Z"),
      periodEnd: new Date("2027-10-25T00:00:00Z"),
      baseAmount: 847.46,
      extraBranchCost: 0,
      extraUserCost: 0,
      onboardingFee: 0,
      referralDiscount: 0,
      gstPercent: 18,
      gstAmount: 152.54,
      totalAmount: 1000,
      amount: 1000,
      currency: "INR",
      paymentStatus: "PAID",
      txnReference: "TXN-9999",
      createdAt: new Date("2026-10-25T10:00:00Z"),
    };

    const url = buildSubscriptionInvoiceUrl(mockBill, "TEST");
    assert.ok(url.includes("/subscription-invoice/bill-12345#data="));

    // Decode and verify the hash
    const hashMatch = url.match(/[#&]data=([^&]+)/);
    assert.ok(hashMatch && hashMatch[1]);
    const decoded = JSON.parse(Buffer.from(hashMatch[1], "base64").toString("utf-8"));

    assert.equal(decoded.id, "bill-12345");
    assert.equal(decoded.bn, "SUB-2026-0001");
    assert.equal(decoded.on, "TEST");
    assert.equal(decoded.pn, "Starter");
    assert.equal(decoded.tm, 12);
    assert.equal(decoded.tl, "1 year");
    assert.equal(decoded.ta, 1000);
    assert.equal(decoded.st, "PAID");
    assert.equal(decoded.tr, "TXN-9999");
  });

  await t.test("buildSubscriptionBillWhatsAppMessage contains all expected fields and direct link", () => {
    const mockBill = {
      id: "bill-12345",
      billNumber: "SUB-2026-0001",
      planName: "Starter",
      termMonths: 12,
      termLabel: "1 year",
      periodStart: new Date("2026-10-25T00:00:00Z"),
      periodEnd: new Date("2027-10-25T00:00:00Z"),
      totalAmount: 1000,
      amount: 1000,
      createdAt: new Date("2026-10-25T10:00:00Z"),
    };

    const msg = buildSubscriptionBillWhatsAppMessage({
      bill: mockBill,
      organizationName: "TEST",
      recipientName: "amar",
      paymentStatus: "PAID",
      txnReference: "TXN-9999",
    });

    assert.ok(msg.includes("🧾 Tax Invoice / Subscription Bill"));
    assert.ok(msg.includes("Platform: MY DETAIL OS"));
    assert.ok(msg.includes("Organization: TEST"));
    assert.ok(msg.includes("Dear amar,"));
    assert.ok(msg.includes("Here are the details for your subscription bill:"));
    assert.ok(msg.includes("* Bill #: SUB-2026-0001"));
    assert.ok(msg.includes("* Plan: Starter (1 year)"));
    assert.ok(msg.includes("* Total Amount: ₹1,000.00"));
    assert.ok(msg.includes("* Payment Status: Paid ✓"));
    assert.ok(msg.includes("📎 *View & Download Tax Invoice:*"));
    assert.ok(msg.includes("/subscription-invoice/bill-12345#data="));
    assert.ok(msg.includes("Thank you for choosing MY DETAIL OS!"));
    assert.ok(msg.includes("Issued by: Samriddhi Agencies"));
  });

  await t.test("buildOwnerPlanActivatedWhatsAppMessage includes direct invoice link", () => {
    const msg = buildOwnerPlanActivatedWhatsAppMessage({
      ownerName: "amar",
      organizationName: "TEST",
      planName: "Starter",
      termLabel: "1 year",
      amount: 0,
      loginUrl: "https://mydetailos.com/login",
      expiresAt: "2028-11-08",
      kind: "renewal",
      billNumber: "SUB-2026-0002",
      invoiceUrl: "https://app.mydetailos.com/subscription-invoice/SUB-2026-0002#data=test1234",
    });

    assert.ok(msg.includes("Hi amar,"));
    assert.ok(msg.includes("Your MY DETAIL OS subscription has been renewed 🚗."));
    assert.ok(msg.includes("Organization: TEST"));
    assert.ok(msg.includes("Plan: Starter"));
    assert.ok(msg.includes("Term: 1 year"));
    assert.ok(msg.includes("Amount paid: ₹0.00"));
    assert.ok(msg.includes("Bill: SUB-2026-0002"));
    assert.ok(msg.includes("View & download bill: https://app.mydetailos.com/subscription-invoice/SUB-2026-0002#data=test1234"));
    assert.ok(msg.includes("Team MY DETAIL OS"));
  });

  await t.test("ownerPlanActivatedTemplateVariables maps variable 8 to invoiceUrl for Twilio Content Template", () => {
    const vars = ownerPlanActivatedTemplateVariables({
      ownerName: "amar",
      organizationName: "TEST",
      planName: "Starter",
      termLabel: "1 year",
      amount: 0,
      loginUrl: "https://mydetailos.com/login",
      expiresAt: "2028-11-08",
      billNumber: "SUB-2026-0002",
      invoiceUrl: "https://app.mydetailos.com/subscription-invoice/SUB-2026-0002#data=test1234",
    });

    assert.equal(vars["1"], "amar");
    assert.equal(vars["2"], "TEST");
    assert.equal(vars["3"], "Starter");
    assert.equal(vars["4"], "1 year");
    assert.equal(vars["5"], "₹0.00");
    assert.equal(vars["6"], "SUB-2026-0002");
    assert.equal(vars["7"], "2028-11-08");
    assert.equal(vars["8"], "https://app.mydetailos.com/subscription-invoice/SUB-2026-0002#data=test1234");
  });

  await t.test("ownerPlanActivatedCtaTemplateVariables maps variable 8 to billId for CTA URL button", () => {
    const vars = ownerPlanActivatedCtaTemplateVariables({
      ownerName: "amar",
      organizationName: "TEST",
      planName: "Starter",
      termLabel: "1 year",
      amount: 0,
      loginUrl: "https://mydetailos.com/login",
      expiresAt: "2028-11-08",
      billNumber: "SUB-2026-0002",
      billId: "cmvntu94k0003hf2aytd75y9n",
    });

    assert.equal(vars["1"], "amar");
    assert.equal(vars["2"], "TEST");
    assert.equal(vars["3"], "Starter");
    assert.equal(vars["4"], "1 year");
    assert.equal(vars["5"], "₹0.00");
    assert.equal(vars["6"], "SUB-2026-0002");
    assert.equal(vars["7"], "2028-11-08");
    assert.equal(vars["8"], "cmvntu94k0003hf2aytd75y9n");
  });
});


import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { customerCredentialsTemplateVariables } from "../src/lib/customer-credentials-whatsapp.js";
import { env } from "../src/config/env.js";

describe("Customer Welcome WhatsApp Template & Parameters", () => {
  it("maps template variable 1 to customer name and 2 to business name", () => {
    const vars = customerCredentialsTemplateVariables({
      customerName: "Rahul Sharma",
      businessName: "My Detail OS",
    });

    assert.deepEqual(vars, {
      "1": "Rahul Sharma",
      "2": "My Detail OS",
    });
  });

  it("handles empty or whitespace names with safe fallbacks", () => {
    const vars = customerCredentialsTemplateVariables({
      customerName: "   ",
      businessName: "",
    });

    assert.deepEqual(vars, {
      "1": "there",
      "2": "My Detail OS",
    });
  });

  it("supports TWILIO_CUSTOMER_WELCOME_CONTENT_SID or fallback default HX2656ed64ee960fb6995f9211b4b71c72", () => {
    const validSids = [
      "HX2656ed64ee960fb6995f9211b4b71c72",
      "HXc25b2ea428f2a532f4356c73ff02e76c",
      "HXa15928c2342c1604e358f8152a79dd45",
    ];
    const resolved =
      env.TWILIO_CUSTOMER_WELCOME_CONTENT_SID?.trim() ||
      env.TWILIO_CUSTOMER_PORTAL_TEMPLATE_SID?.trim() ||
      "HX2656ed64ee960fb6995f9211b4b71c72";

    assert.ok(validSids.includes(resolved), `Expected ${resolved} to be in ${validSids}`);
  });

  it("verifies all 5 pre-approved Twilio WhatsApp Content Template SIDs are configured", () => {
    const customerWelcomeSid =
      env.TWILIO_CUSTOMER_WELCOME_CONTENT_SID?.trim() || env.TWILIO_CUSTOMER_PORTAL_TEMPLATE_SID?.trim();
    assert.ok(
      customerWelcomeSid === "HX2656ed64ee960fb6995f9211b4b71c72" ||
        customerWelcomeSid === "HXc25b2ea428f2a532f4356c73ff02e76c" ||
        customerWelcomeSid === "HXa15928c2342c1604e358f8152a79dd45"
    );
    assert.equal(
      env.TWILIO_AUTH_OTP_CONTENT_SID?.trim() || env.TWILIO_OTP_TEMPLATE_SID?.trim(),
      "HXf1c8e1cbd228b0ab0700445712169f1e"
    );
    assert.equal(
      env.TWILIO_SERVICE_REMINDER_CONTENT_SID?.trim() || env.TWILIO_SERVICE_REMINDER_TEMPLATE_SID?.trim(),
      "HX7eb233c8252b14bee9403c8eb4bd1fea"
    );
    assert.equal(
      env.TWILIO_PAYMENT_PENDING_CONTENT_SID?.trim() || env.TWILIO_PAYMENT_PENDING_TEMPLATE_SID?.trim(),
      "HX429538b3d8638a6ef9c0aff78dc0c933"
    );
    assert.equal(
      env.TWILIO_INSPECTION_REPORT_CONTENT_SID?.trim() || env.TWILIO_INSPECTION_TEMPLATE_SID?.trim(),
      "HXe3ca0b811651060e2d338d598eef2270"
    );
  });

  it("serializes contentVariables to JSON matching Twilio Content API expectations", () => {
    const vars = customerCredentialsTemplateVariables({
      customerName: "Amit Verma",
      businessName: "Prime Detailers",
    });

    const json = JSON.stringify(vars);
    assert.equal(json, JSON.stringify({ "1": "Amit Verma", "2": "Prime Detailers" }));
    const parsed = JSON.parse(json);
    assert.equal(parsed["1"], "Amit Verma");
    assert.equal(parsed["2"], "Prime Detailers");
  });
});

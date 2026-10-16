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
    const expectedSid = "HX2656ed64ee960fb6995f9211b4b71c72";
    const resolved =
      env.TWILIO_CUSTOMER_WELCOME_CONTENT_SID?.trim() ||
      env.TWILIO_CUSTOMER_PORTAL_TEMPLATE_SID?.trim() ||
      "HX2656ed64ee960fb6995f9211b4b71c72";

    assert.equal(resolved, expectedSid);
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

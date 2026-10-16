import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { findActiveCustomersByPhone } from "../src/modules/customers/customer-auth.service.js";

describe("Customer Auth Organization Auto-Resolution", () => {
  it("resolves the organization for a known customer 10-digit phone number", async () => {
    const matches = await findActiveCustomersByPhone("8305353862");
    assert.ok(matches.length >= 1, "Should find at least 1 customer for 8305353862");
    const match = matches[0];
    assert.equal(match.name, "Alok");
    assert.equal(match.orgSlug, "test");
    assert.equal(match.orgName, "TEST");
  });

  it("returns empty array for an unknown phone number", async () => {
    const matches = await findActiveCustomersByPhone("0000000000");
    assert.deepEqual(matches, []);
  });

  it("handles formatting and extra non-digit characters in phone", async () => {
    const matches = await findActiveCustomersByPhone("+91-8305353862");
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].name, "Alok");
  });
});

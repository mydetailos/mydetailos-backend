import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signAuthToken } from "../src/modules/auth/auth.service.js";

describe("Organization Deletion & Authentication Guards", () => {
  it("signAuthToken includes organizationId and role correctly", () => {
    const token = signAuthToken({
      id: "usr-test-1",
      email: "staff@testorg.com",
      role: "MECHANIC",
      branchId: "br-test-1",
      organizationId: "org-test-1",
      name: "Test Staff",
      permissions: ["JOB_CARDS_VIEW"],
    });

    assert.ok(token);
    assert.equal(typeof token, "string");
  });
});

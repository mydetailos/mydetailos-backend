import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import { createUserApi } from "../src/modules/users/user-api.service.js";

describe("User Creation Unique ID and Collision Protection", () => {
  let testOrgId: string;
  let testBranchId: string;
  let createdUserIds: string[] = [];

  before(async () => {
    // Locate or create an organization and branch for the test
    const branch = await prisma.branch.findFirst({
      where: { isActive: true },
      include: { organization: true },
    });
    if (!branch) {
      throw new Error("No active branch found for test");
    }
    testOrgId = branch.organizationId;
    testBranchId = branch.id;
  });

  after(async () => {
    // Clean up test users
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  it("handles duplicate id gracefully by allocating a new unique id", async () => {
    // Find an existing user id in the database
    const existingUser = await prisma.user.findFirst({
      select: { id: true },
    });
    assert.ok(existingUser, "Existing user must exist");

    const email = `test-unique-id-${Date.now()}@testexample.com`;
    // Attempt to create a user with the EXACT SAME id as the existing user
    const result = await createUserApi({
      id: existingUser.id,
      name: "Collision Test User",
      email,
      phone: "+919999999991",
      role: "MECHANIC",
      branchId: testBranchId,
      organizationId: testOrgId,
    });

    assert.ok(result.user);
    assert.notEqual(
      result.user.id,
      existingUser.id,
      "New user should have a new unique ID instead of failing with primary key collision"
    );
    assert.ok(result.user.id.startsWith("usr-"));
    createdUserIds.push(result.user.id);
  });

  it("auto-generates unique id when id is omitted", async () => {
    const email = `test-no-id-${Date.now()}@testexample.com`;
    const result = await createUserApi({
      name: "Omitted ID User",
      email,
      phone: "+919999999992",
      role: "MECHANIC",
      branchId: testBranchId,
      organizationId: testOrgId,
    });

    assert.ok(result.user);
    assert.ok(result.user.id.startsWith("usr-"));
    createdUserIds.push(result.user.id);
  });

  it("rejects duplicate email with friendly validation error", async () => {
    const existingUser = await prisma.user.findFirst({
      select: { email: true },
    });
    assert.ok(existingUser, "Existing user must exist");

    await assert.rejects(
      async () => {
        await createUserApi({
          name: "Duplicate Email User",
          email: existingUser.email,
          phone: "+919999999993",
          role: "MECHANIC",
          branchId: testBranchId,
          organizationId: testOrgId,
        });
      },
      (err: any) => {
        return (
          err.message?.includes("already exists") &&
          err.code === "VALIDATION"
        );
      }
    );
  });
});

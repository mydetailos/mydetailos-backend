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

  it("auto-allocates next available employeeCode when omitted", async () => {
    const email = `test-no-empcode-${Date.now()}@testexample.com`;
    const result = await createUserApi({
      name: "No EmpCode User",
      email,
      phone: "+919999999994",
      role: "MECHANIC",
      branchId: testBranchId,
      organizationId: testOrgId,
    });

    assert.ok(result.user);
    assert.ok(result.user.employeeCode, "employeeCode must be auto-assigned");
    assert.match(result.user.employeeCode, /^EMP-\d+$/);
    createdUserIds.push(result.user.id);
  });

  it("auto-advances to next unique employeeCode when an EMP-xxx collision occurs", async () => {
    // Find an existing user with an employeeCode or use EMP-001
    const existingWithCode = await prisma.user.findFirst({
      where: { employeeCode: { not: null } },
      select: { employeeCode: true },
    });
    const clashingCode = existingWithCode?.employeeCode || "EMP-001";

    const email = `test-empcode-clash-${Date.now()}@testexample.com`;
    // Attempt to create with the exact same clashing code
    const result = await createUserApi({
      name: "EMP Code Clash User",
      email,
      phone: "+919999999995",
      role: "MECHANIC",
      branchId: testBranchId,
      organizationId: testOrgId,
      employeeCode: clashingCode,
    });

    assert.ok(result.user);
    assert.ok(result.user.employeeCode);
    assert.notEqual(
      result.user.employeeCode,
      clashingCode,
      "Should auto-advance to a new employeeCode instead of failing"
    );
    assert.match(result.user.employeeCode, /^EMP-\d+$/);
    createdUserIds.push(result.user.id);
  });

  it("rejects duplicate custom non-EMP employeeCode with validation error", async () => {
    const customCode = `CUST-${Date.now().toString(36)}`;
    const email1 = `test-custom-code-1-${Date.now()}@testexample.com`;
    const user1 = await createUserApi({
      name: "Custom Code User 1",
      email: email1,
      phone: "+919999999996",
      role: "MECHANIC",
      branchId: testBranchId,
      organizationId: testOrgId,
      employeeCode: customCode,
    });
    createdUserIds.push(user1.user.id);

    const email2 = `test-custom-code-2-${Date.now()}@testexample.com`;
    await assert.rejects(
      async () => {
        await createUserApi({
          name: "Custom Code User 2",
          email: email2,
          phone: "+919999999997",
          role: "MECHANIC",
          branchId: testBranchId,
          organizationId: testOrgId,
          employeeCode: customCode,
        });
      },
      (err: any) => {
        return (
          err.message?.includes("Employee code is already in use") &&
          err.code === "VALIDATION"
        );
      }
    );
  });
});


import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import { createUserApi } from "../src/modules/users/user-api.service.js";
import { canAssignUserRole } from "../src/lib/rbac.js";

describe("User API SUPER_ADMIN Defense-in-Depth Guard", () => {
  let testOrgId = "";
  let testBranchId = "";

  before(async () => {
    const branch = await prisma.branch.findFirst({
      where: { isActive: true },
    });
    if (!branch) {
      throw new Error("No active branch found for test");
    }
    testOrgId = branch.organizationId;
    testBranchId = branch.id;
  });

  it("canAssignUserRole rejects SUPER_ADMIN assignment even for SUPER_ADMIN actors", () => {
    assert.equal(canAssignUserRole("SUPER_ADMIN", "ADMIN"), true);
    assert.equal(canAssignUserRole("SUPER_ADMIN", "MANAGER"), true);
    assert.equal(canAssignUserRole("SUPER_ADMIN", "SUPER_ADMIN"), false);
    assert.equal(canAssignUserRole("SUPER_ADMIN", "PLATFORM_OWNER"), false);
    assert.equal(canAssignUserRole("ADMIN", "ADMIN"), false);
  });

  it("createUserApi rejects creating user with role: SUPER_ADMIN", async () => {
    await assert.rejects(
      async () => {
        await createUserApi({
          name: "Illegal Super Admin",
          email: `superadmin-test-${Date.now()}@testexample.com`,
          phone: "+919999999990",
          role: "SUPER_ADMIN",
          branchId: testBranchId,
          organizationId: testOrgId,
        });
      },
      (err: any) => {
        return (
          err.message?.includes("Cannot create SUPER_ADMIN accounts") &&
          err.code === "VALIDATION"
        );
      }
    );
  });

  it("createUserApi rejects creating user with role: PLATFORM_OWNER", async () => {
    await assert.rejects(
      async () => {
        await createUserApi({
          name: "Illegal Platform Owner",
          email: `platformowner-test-${Date.now()}@testexample.com`,
          phone: "+919999999999",
          role: "PLATFORM_OWNER",
          branchId: testBranchId,
          organizationId: testOrgId,
        });
      },
      (err: any) => {
        return (
          err.message?.includes("Cannot create PLATFORM_OWNER accounts") &&
          err.code === "VALIDATION"
        );
      }
    );
  });
});

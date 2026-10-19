/**
 * Lightweight backend RBAC assertions (no test runner dependency).
 * Run: npm run test:rbac
 */
import assert from "node:assert/strict";
import {
  canAssignUserRole,
  canChangeRoles,
  canCreateStaffAccounts,
  isStaffManager,
  PAYROLL_ACCESS_ROLES,
} from "../src/lib/rbac.js";
import { collectionPermissionMapIsComplete } from "../src/constants/collection-permissions.js";
import { PERMISSION_KEYS } from "../src/constants/permission-keys.js";

assert.equal(isStaffManager("MANAGER"), true);
assert.equal(isStaffManager("MECHANIC"), false);
assert.equal(canCreateStaffAccounts("ADMIN"), true);
assert.equal(canCreateStaffAccounts("RECEPTIONIST"), false);
assert.equal(canChangeRoles("SUPER_ADMIN"), true);
assert.equal(canChangeRoles("ADMIN"), false);
assert.equal(canAssignUserRole("SUPER_ADMIN", "ADMIN"), true);
assert.equal(canAssignUserRole("SUPER_ADMIN", "SUPER_ADMIN"), false);
assert.equal(canAssignUserRole("ADMIN", "MECHANIC"), false);
assert.ok(PAYROLL_ACCESS_ROLES.includes("MANAGER"));
assert.ok(!PAYROLL_ACCESS_ROLES.includes("MECHANIC"));
assert.equal(collectionPermissionMapIsComplete(), true);
assert.equal(PERMISSION_KEYS.length, 37);
assert.ok(PERMISSION_KEYS.includes("JOB_CARD_PRICING"));
assert.ok(PERMISSION_KEYS.includes("STAFF_REWARDS"));
assert.ok(PERMISSION_KEYS.includes("LEAVE"));

console.log("OK: backend RBAC + permission map checks passed.");

/**
 * Staff access + role defaults parity and behavior checks.
 * Run: npm run test:staff-access
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInitialPermissions,
  getDefaultModuleKeysForRole,
  resolvePermissionsOnCreate,
} from "../src/lib/staff-role-defaults.js";
import {
  deriveStaffAccessLevel,
  permissionsForStaffAccessLevel,
} from "../src/lib/staff-access.js";
import { canManageUserPermissions } from "../src/lib/staff-permissions-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const feRoot = join(__dirname, "../../mydetailos-workshop/src/lib");

function readFe(path: string): string {
  return readFileSync(join(feRoot, path), "utf8");
}

// --- FE source parity (role default module lists) ---
const feRoleDefaults = readFe("staff-role-defaults.ts");
const beRoleDefaults = readFileSync(join(__dirname, "../src/lib/staff-role-defaults.ts"), "utf8");

const receptionistMatch = feRoleDefaults.match(
  /const RECEPTIONIST_MODULES = \[([\s\S]*?)\] as const/
);
assert.ok(receptionistMatch, "FE missing RECEPTIONIST_MODULES");
const receptionistMods = [...receptionistMatch![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]!);

for (const role of ["MECHANIC"] as const) {
  const feMatch = feRoleDefaults.match(
    new RegExp(`${role}:\\s*\\[([\\s\\S]*?)\\]`, "m")
  );
  assert.ok(feMatch, `FE missing ROLE_DEFAULT for ${role}`);
  const feMods = [...feMatch![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]!);
  const beMods = [...getDefaultModuleKeysForRole(role)];
  assert.deepEqual(beMods, feMods, `${role} default modules mismatch FE ↔ BE`);
}

assert.deepEqual(
  [...getDefaultModuleKeysForRole("RECEPTIONIST")],
  receptionistMods,
  "RECEPTIONIST default modules mismatch FE ↔ BE"
);

const supervisorExtraMatch = feRoleDefaults.match(
  /const SUPERVISOR_EXTRA_MODULES = \[([\s\S]*?)\] as const/
);
assert.ok(supervisorExtraMatch, "FE missing SUPERVISOR_EXTRA_MODULES");
const supervisorExtraMods = [...supervisorExtraMatch![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map(
  (m) => m[1]!
);
const feSupervisorMods = [...new Set([...receptionistMods, ...supervisorExtraMods])];
assert.deepEqual(
  [...getDefaultModuleKeysForRole("SUPERVISOR")],
  feSupervisorMods,
  "SUPERVISOR default modules mismatch FE ↔ BE"
);

const opsMatch = feRoleDefaults.match(
  /const OPERATIONS_MANAGER_MODULES = \[([\s\S]*?)\] as const/
);
assert.ok(opsMatch, "FE missing OPERATIONS_MANAGER_MODULES");
const opsMods = [...opsMatch![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]!);
for (const role of ["MANAGER", "BRANCH_MANAGER"] as const) {
  assert.deepEqual([...getDefaultModuleKeysForRole(role)], opsMods, `${role} mismatch FE ↔ BE`);
}

assert.deepEqual(getDefaultModuleKeysForRole("ADMIN"), []);
assert.deepEqual(getDefaultModuleKeysForRole("SUPER_ADMIN"), []);

// --- access level mapping ---
const withoutEdit = permissionsForStaffAccessLevel(
  ["CUSTOMERS_CREATE", "CUSTOMERS_VIEW", "JOB_CARDS"],
  "withoutEditAccess"
);
assert.ok(withoutEdit.includes("CUSTOMERS_CREATE"));
assert.ok(withoutEdit.includes("CUSTOMERS_VIEW"));
assert.ok(!withoutEdit.includes("CUSTOMERS_EDIT"));
assert.ok(!withoutEdit.includes("JOB_CARDS"));

const withEdit = permissionsForStaffAccessLevel(
  ["CUSTOMERS_CREATE", "CUSTOMERS_VIEW"],
  "withEditAccess"
);
assert.ok(withEdit.includes("CUSTOMERS_EDIT"));

assert.equal(deriveStaffAccessLevel(withEdit), "withEditAccess");
assert.equal(deriveStaffAccessLevel(withoutEdit), "withoutEditAccess");

// --- create resolution ---
const explicit = resolvePermissionsOnCreate("RECEPTIONIST", ["CUSTOMERS_VIEW"]);
assert.deepEqual(explicit, ["CUSTOMERS_VIEW"]);

const defaulted = resolvePermissionsOnCreate("RECEPTIONIST", []);
assert.ok(defaulted.length > 0);
assert.ok(defaulted.includes("CUSTOMERS_EDIT")); // default withEditAccess

const noEdit = resolvePermissionsOnCreate("RECEPTIONIST", undefined, "withoutEditAccess");
assert.ok(!noEdit.some((p) => p.endsWith("_EDIT")));

const mechanicPerms = buildInitialPermissions("MECHANIC", "withoutEditAccess");
assert.ok(mechanicPerms.includes("JOB_CARDS_VIEW"));
assert.ok(!mechanicPerms.includes("JOB_CARDS_EDIT"));

// --- PUT permissions policy (matches FE userCanEdit STAFF) ---
assert.equal(
  canManageUserPermissions({
    id: "1",
    email: "a@test.com",
    role: "SUPER_ADMIN",
    branchId: "b",
    name: "A",
  }),
  true
);
assert.equal(
  canManageUserPermissions({
    id: "1",
    email: "a@test.com",
    role: "ADMIN",
    branchId: "b",
    name: "A",
  }),
  true
);
assert.equal(
  canManageUserPermissions({
    id: "1",
    email: "a@test.com",
    role: "MANAGER",
    branchId: "b",
    name: "A",
    permissions: ["STAFF_EDIT"],
  }),
  true
);
assert.equal(
  canManageUserPermissions({
    id: "1",
    email: "a@test.com",
    role: "MANAGER",
    branchId: "b",
    name: "A",
    permissions: ["STAFF_VIEW"],
  }),
  false
);

// staff-access.ts function bodies aligned with FE
assert.ok(readFe("staff-access.ts").includes("permissionsForStaffAccessLevel"));
assert.ok(beRoleDefaults.includes("permissionsForStaffAccessLevel"));

console.log("OK: staff access + role defaults checks passed.");

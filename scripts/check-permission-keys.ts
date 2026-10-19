/**
 * Ensures FE and BE permission key lists stay identical.
 * Run from backend: npm run test:permission-keys
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_KEYS as backendKeys } from "../src/constants/permission-keys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const feCandidates = [
  join(__dirname, "../../frontend/src/lib/permission-keys.ts"),
  join(__dirname, "../../mydetailos-workshop/src/lib/permission-keys.ts"),
];
import { existsSync } from "node:fs";
const fePath = feCandidates.find((p) => existsSync(p)) || feCandidates[0]!;
const feSrc = readFileSync(fePath, "utf8");

const match = feSrc.match(/export const PERMISSION_KEYS = \[([\s\S]*?)\] as const/);
if (!match) {
  console.error("Could not parse frontend PERMISSION_KEYS");
  process.exit(1);
}

const feKeys = [...match[1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]!);

const be = [...backendKeys];
const missingInBe = feKeys.filter((k) => !be.includes(k as (typeof be)[number]));
const missingInFe = be.filter((k) => !feKeys.includes(k));
const orderMismatch =
  feKeys.length === be.length && feKeys.some((k, i) => k !== be[i]);

if (missingInBe.length || missingInFe.length || orderMismatch || feKeys.length !== be.length) {
  console.error("Permission keys FE/BE mismatch.");
  if (missingInBe.length) console.error("In FE but not BE:", missingInBe.join(", "));
  if (missingInFe.length) console.error("In BE but not FE:", missingInFe.join(", "));
  if (orderMismatch) console.error("Same keys but different order — keep lists identical.");
  process.exit(1);
}

console.log(`OK: ${be.length} permission keys aligned FE ↔ BE.`);

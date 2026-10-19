import { prisma } from "../../lib/prisma.js";
import { getCollectionItem } from "../collections/app-json-store.js";
import { AppError } from "../../lib/app-error.js";
import { toApiVehicle } from "../vehicles/vehicle-api.service.js";

/** Public-safe business settings fields for tax invoice HTML. */
const PUBLIC_SETTINGS_KEYS = [
  "gstRegistrationStatus",
  "businessName",
  "businessTagline",
  "businessAddress",
  "businessPhone",
  "businessWhatsApp",
  "businessEmail",
  "businessWebsite",
  "gstin",
  "companyPan",
  "bankName",
  "bankBranch",
  "bankAccountNumber",
  "bankIfsc",
  "bankUpi",
  "logoUrl",
] as const;

/** Job-card fields needed by the public invoice print template. */
const PUBLIC_JOB_CARD_KEYS = [
  "id",
  "jobNumber",
  "customerName",
  "customerPhone",
  "customerEmail",
  "customerAddress",
  "vehicleId",
  "vehicleMakeModel",
  "vehicleRegNumber",
  "vehicleSegment",
  "odometerReading",
  "createdAt",
  "expectedDelivery",
  "actualDelivery",
  "status",
] as const;

/** Vehicle fields shown under make/model on the public invoice. */
const PUBLIC_VEHICLE_KEYS = [
  "id",
  "variant",
  "year",
  "fuelType",
  "color",
  "odometer",
  "make",
  "model",
] as const;

function pickKeys(source: Record<string, unknown> | null | undefined, keys: readonly string[]) {
  if (!source) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

function sanitizeInvoiceForPublic(invoice: Record<string, unknown>): Record<string, unknown> {
  const { storedPdf: _storedPdf, ...rest } = invoice;
  return rest;
}

/**
 * Load a minimized public invoice view (no auth).
 * Omits other customer invoices, all-branch dumps, and sensitive settings/PDF blobs.
 */
export async function getPublicInvoiceView(invoiceId: string) {
  // 1. Fetch invoice row with its organization relation
  const invoiceRow = await prisma.appJsonRow.findUnique({
    where: { collection_entityId: { collection: "invoices", entityId: invoiceId } },
    include: { organization: true },
  });
  if (!invoiceRow) {
    throw AppError.notFound("Invoice not found");
  }
  const invoiceRaw = (invoiceRow.payload && typeof invoiceRow.payload === "object"
    ? invoiceRow.payload
    : {}) as Record<string, unknown>;
  const orgId = invoiceRow.organizationId;
  const organization = invoiceRow.organization;
  const jobCardId = typeof invoiceRaw.jobCardId === "string" ? invoiceRaw.jobCardId : "";
  const jobCardRaw = jobCardId
    ? ((await getCollectionItem("jobCards", jobCardId, orgId)) as Record<string, unknown> | null)
    : null;
  const vehicleId =
    jobCardRaw && typeof jobCardRaw.vehicleId === "string" ? jobCardRaw.vehicleId : "";
  const vehicleRow = vehicleId
    ? await prisma.vehicle.findUnique({ where: { id: vehicleId } })
    : null;
  const vehicleApi = vehicleRow ? toApiVehicle(vehicleRow) : null;

  // 2. Fetch scoped appSettings for this specific organization
  const scopedSettings = (await getCollectionItem(
    "appSettings",
    "default",
    orgId
  )) as Record<string, unknown> | null;
  const rawSettings =
    (pickKeys(scopedSettings ?? undefined, PUBLIC_SETTINGS_KEYS) || {}) as Record<string, unknown>;

  // 3. Fallback to organization.name if businessName is unset or matches platform defaults
  const isDefaultName =
    !rawSettings.businessName ||
    typeof rawSettings.businessName !== "string" ||
    ["my detail os", "mydetailos"].includes(rawSettings.businessName.trim().toLowerCase());
  const resolvedBusinessName = isDefaultName
    ? organization?.name ||
      (typeof rawSettings.businessName === "string" ? rawSettings.businessName : "MY DETAIL OS")
    : rawSettings.businessName;
  const businessSettings = {
    ...rawSettings,
    businessName: resolvedBusinessName,
  };

  return {
    invoice: sanitizeInvoiceForPublic({
      ...invoiceRaw,
      organizationId: orgId,
      organizationName: organization?.name,
    }),
    jobCard: pickKeys(jobCardRaw ?? undefined, PUBLIC_JOB_CARD_KEYS),
    vehicle: pickKeys(
      vehicleApi ? (vehicleApi as unknown as Record<string, unknown>) : undefined,
      PUBLIC_VEHICLE_KEYS
    ),
    businessSettings,
    organization: organization
      ? {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        }
      : null,
  };
}

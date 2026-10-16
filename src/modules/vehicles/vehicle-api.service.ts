import type { Vehicle as VehicleRow } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export function toApiVehicle(v: VehicleRow) {
  return {
    id: v.id,
    customerId: v.customerId,
    customerName: v.customerName,
    registrationNumber: v.registrationNumber,
    make: v.make,
    model: v.model,
    segment: v.segment,
    variant: v.variant ?? undefined,
    fuelType: v.fuelType,
    color: v.color,
    year: v.year,
    notes: v.notes ?? undefined,
    odometer: v.odometer ?? undefined,
    insuranceProvider: v.insuranceProvider ?? undefined,
    insurancePolicyNumber: v.insurancePolicyNumber ?? undefined,
    insuranceDueDate: v.insuranceDueDate ?? undefined,
    vinNumber: v.vinNumber ?? undefined,
    previousOwners: (v.previousOwners as VehicleRow["previousOwners"]) ?? undefined,
  };
}

function registrationDuplicateKey(reg: string): string {
  return reg.trim().toUpperCase().replace(/[\s-]/g, "");
}

export async function listVehiclesApi(opts?: {
  organizationId: string;
  vehicleIds?: Set<string> | null;
  page?: number;
  pageSize?: number;
}) {
  if (!opts?.organizationId) return [];
  if (opts.vehicleIds && opts.vehicleIds.size === 0) {
    return [];
  }
  const where = {
    organizationId: opts.organizationId,
    ...(opts.vehicleIds && opts.vehicleIds.size > 0
      ? { id: { in: [...opts.vehicleIds] } }
      : {}),
  };

  if (opts.page && opts.pageSize) {
    const total = await prisma.vehicle.count({ where });
    const rows = await prisma.vehicle.findMany({
      where,
      orderBy: { id: "asc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    });
    return {
      items: rows.map(toApiVehicle),
      page: opts.page,
      pageSize: opts.pageSize,
      total,
      totalPages: Math.ceil(total / opts.pageSize)
    };
  }

  const rows = await prisma.vehicle.findMany({
    where,
    orderBy: { id: "asc" },
  });
  return rows.map(toApiVehicle);
}

export async function createVehicleApi(data: {
  organizationId: string;
  id: string;
  customerId: string;
  customerName: string;
  registrationNumber: string;
  make: string;
  model: string;
  segment: VehicleRow["segment"];
  variant?: string | null;
  fuelType: VehicleRow["fuelType"];
  color: string;
  year: number;
  notes?: string | null;
  odometer?: number | null;
  insuranceProvider?: string | null;
  insurancePolicyNumber?: string | null;
  insuranceDueDate?: string | null;
  vinNumber?: string | null;
  previousOwners?: unknown;
  createdByUserId?: string;
  updatedByUserId?: string;
}) {
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, organizationId: data.organizationId },
    select: { id: true },
  });
  if (!customer) throw new Error("Customer not found");

  const row = await prisma.vehicle.create({
    data: {
      id: data.id,
      organizationId: data.organizationId,
      customerId: data.customerId,
      customerName: data.customerName,
      registrationNumber: data.registrationNumber,
      make: data.make,
      model: data.model,
      segment: data.segment,
      variant: data.variant ?? null,
      fuelType: data.fuelType,
      color: data.color,
      year: data.year,
      notes: data.notes ?? null,
      odometer: data.odometer ?? null,
      insuranceProvider: data.insuranceProvider ?? null,
      insurancePolicyNumber: data.insurancePolicyNumber ?? null,
      insuranceDueDate: data.insuranceDueDate ?? null,
      vinNumber: data.vinNumber ?? null,
      previousOwners: data.previousOwners ? (data.previousOwners as object) : undefined,
      createdByUserId: data.createdByUserId || null,
      updatedByUserId: data.updatedByUserId || null,
    },
  });

  if (data.createdByUserId) {
    const { logBusinessActivity } = await import("../../services/activity-logger.service.js");
    await logBusinessActivity({ organizationId: data.organizationId, hasJobCardPricingPermission: false, userId: data.createdByUserId }, {
      action: "CREATE_VEHICLE",
      entityType: "VEHICLE",
      entityId: data.id,
    });
  }

  return toApiVehicle(row);
}

export async function updateVehicleApi(
  id: string,
  organizationId: string,
  patch: Partial<{
    customerId: string;
    customerName: string;
    registrationNumber: string;
    make: string;
    model: string;
    segment: VehicleRow["segment"];
    variant: string | null;
    fuelType: VehicleRow["fuelType"];
    color: string;
    year: number;
    notes: string | null;
    odometer: number | null;
    insuranceProvider: string | null;
    insurancePolicyNumber: string | null;
    insuranceDueDate: string | null;
    vinNumber: string | null;
    previousOwners: unknown;
    updatedByUserId: string;
  }>
): Promise<ReturnType<typeof toApiVehicle> | null> {
  const owned = await prisma.vehicle.findFirst({ where: { id, organizationId } });
  if (!owned) return null;
  const data: Record<string, unknown> = { ...patch };
  if (patch.previousOwners !== undefined) {
    data.previousOwners = patch.previousOwners ? (patch.previousOwners as object) : null;
  }
  const row = await prisma.vehicle.update({
    where: { id },
    data: data as Parameters<typeof prisma.vehicle.update>[0]["data"],
  });

  if (patch.updatedByUserId) {
    const { logBusinessActivity } = await import("../../services/activity-logger.service.js");
    await logBusinessActivity({ organizationId, hasJobCardPricingPermission: false, userId: patch.updatedByUserId }, {
      action: "UPDATE_VEHICLE",
      entityType: "VEHICLE",
      entityId: id,
    });
  }

  return toApiVehicle(row);
}

export async function deleteVehicleApi(id: string, organizationId: string, userId?: string): Promise<boolean> {
  try {
    const owned = await prisma.vehicle.findFirst({ where: { id, organizationId } });
    if (!owned) return false;
    await prisma.vehicle.delete({ where: { id } });

    if (userId) {
      const { logBusinessActivity } = await import("../../services/activity-logger.service.js");
      await logBusinessActivity({ organizationId, hasJobCardPricingPermission: false, userId }, {
        action: "DELETE_VEHICLE",
        entityType: "VEHICLE",
        entityId: id,
      });
    }

    return true;
  } catch {
    return false;
  }
}

type VehicleUpsertInput = {
  organizationId: string;
  id: string;
  customerId: string;
  customerName: string;
  registrationNumber: string;
  make: string;
  model: string;
  segment: VehicleRow["segment"];
  variant?: string | null;
  fuelType: VehicleRow["fuelType"];
  color: string;
  year: number;
  notes?: string | null;
  odometer?: number | null;
  insuranceProvider?: string | null;
  insurancePolicyNumber?: string | null;
  insuranceDueDate?: string | null;
  vinNumber?: string | null;
  previousOwners?: unknown;
};

/** Replace all vehicles for one organization (demo/local-first sync). */
export async function replaceAllVehiclesApi(
  organizationId: string,
  items: VehicleUpsertInput[]
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.vehicle.deleteMany({ where: { organizationId } });
    for (const data of items) {
      await tx.vehicle.create({
        data: {
          id: data.id,
          organizationId,
          customerId: data.customerId,
          customerName: data.customerName,
          registrationNumber: data.registrationNumber,
          make: data.make,
          model: data.model,
          segment: data.segment,
          variant: data.variant ?? null,
          fuelType: data.fuelType,
          color: data.color,
          year: data.year,
          notes: data.notes ?? null,
          odometer: data.odometer ?? null,
          insuranceProvider: data.insuranceProvider ?? null,
          insurancePolicyNumber: data.insurancePolicyNumber ?? null,
          insuranceDueDate: data.insuranceDueDate ?? null,
          vinNumber: data.vinNumber ?? null,
          previousOwners: data.previousOwners ? (data.previousOwners as object) : undefined,
        },
      });
    }
  });
}

export type BulkVehicleInput = {
  registrationNumber: string;
  customerId: string;
  customerName: string;
  make: string;
  model: string;
  fuelType: VehicleRow["fuelType"];
  segment: VehicleRow["segment"];
  year: number;
  color: string;
  variant?: string;
  notes?: string;
};

export type BulkVehicleSkipped = {
  index: number;
  registrationNumber: string;
  reason: "DUPLICATE" | "INVALID" | "DUPLICATE_IN_BATCH" | "CUSTOMER_NOT_FOUND";
  message: string;
};

/**
 * Creates many vehicles in one pass. Skips duplicate registrations (compact key)
 * and missing customers. Does not replace existing rows.
 */
export async function createVehiclesBulk(
  organizationId: string,
  inputs: BulkVehicleInput[]
): Promise<{
  created: ReturnType<typeof toApiVehicle>[];
  skipped: BulkVehicleSkipped[];
}> {
  const rawRegs = inputs.map(i => registrationDuplicateKey(String(i.registrationNumber ?? ""))).filter(Boolean);
  const inputCustomerIds = inputs.map(i => String(i.customerId ?? "").trim()).filter(Boolean);

  let existingVehicles: { registrationNumber: string }[] = [];
  if (rawRegs.length > 0) {
    const joined = rawRegs.map(r => `'${r.replace(/'/g, "''")}'`).join(", ");
    existingVehicles = await prisma.$queryRawUnsafe<{ registrationNumber: string }[]>(
      `SELECT "registrationNumber" FROM "Vehicle" WHERE "organizationId" = $1 AND UPPER(REPLACE(REPLACE("registrationNumber", ' ', ''), '-', '')) IN (${joined})`,
      organizationId
    );
  }

  const customers = inputCustomerIds.length > 0 ? await prisma.customer.findMany({
    where: { organizationId, id: { in: inputCustomerIds } },
    select: { id: true },
  }) : [];

  const usedRegs = new Set(
    existingVehicles.map((v) => registrationDuplicateKey(v.registrationNumber)).filter(Boolean)
  );
  const customerIds = new Set(customers.map((c) => c.id));

  const skipped: BulkVehicleSkipped[] = [];
  const toCreate: Array<{
    id: string;
    organizationId: string;
    customerId: string;
    customerName: string;
    registrationNumber: string;
    make: string;
    model: string;
    segment: VehicleRow["segment"];
    variant: string | null;
    fuelType: VehicleRow["fuelType"];
    color: string;
    year: number;
    notes: string | null;
  }> = [];

  const stamp = Date.now();

  inputs.forEach((input, index) => {
    const registrationNumber = String(input.registrationNumber ?? "").trim().toUpperCase();
    const make = String(input.make ?? "").trim();
    const model = String(input.model ?? "").trim();
    const customerId = String(input.customerId ?? "").trim();
    const customerName = String(input.customerName ?? "").trim();
    const regKey = registrationDuplicateKey(registrationNumber);

    if (!registrationNumber || !make || !model || !customerId || !customerName) {
      skipped.push({
        index,
        registrationNumber,
        reason: "INVALID",
        message: "Registration, customer, make, and model are required",
      });
      return;
    }

    if (!customerIds.has(customerId)) {
      skipped.push({
        index,
        registrationNumber,
        reason: "CUSTOMER_NOT_FOUND",
        message: "Customer not found",
      });
      return;
    }

    if (usedRegs.has(regKey)) {
      const alreadyInBatch = toCreate.some(
        (c) => registrationDuplicateKey(c.registrationNumber) === regKey
      );
      skipped.push({
        index,
        registrationNumber,
        reason: alreadyInBatch ? "DUPLICATE_IN_BATCH" : "DUPLICATE",
        message: alreadyInBatch
          ? "Duplicate registration in this import batch"
          : "Registration already in use",
      });
      return;
    }

    usedRegs.add(regKey);
    toCreate.push({
      id: `veh-${stamp}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      organizationId,
      customerId,
      customerName,
      registrationNumber,
      make,
      model,
      segment: input.segment,
      variant: input.variant?.trim() ? input.variant.trim() : null,
      fuelType: input.fuelType,
      color: input.color?.trim() ? input.color.trim() : "—",
      year: input.year,
      notes: input.notes?.trim() ? input.notes.trim() : null,
    });
  });

  if (toCreate.length === 0) {
    return { created: [], skipped };
  }

  await prisma.vehicle.createMany({ data: toCreate });
  const ids = toCreate.map((c) => c.id);
  const rows = await prisma.vehicle.findMany({
    where: { id: { in: ids } },
  });

  return { created: rows.map(toApiVehicle), skipped };
}

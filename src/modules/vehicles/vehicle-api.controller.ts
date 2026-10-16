import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  listVehiclesApi,
  createVehicleApi,
  updateVehicleApi,
  deleteVehicleApi,
  replaceAllVehiclesApi,
  createVehiclesBulk,
} from "./vehicle-api.service.js";
import { FuelType, VehicleSegment } from "@prisma/client";
import { resolveBranchScope } from "../../lib/data-scope.js";
import { prisma } from "../../lib/prisma.js";
import { parsePagination } from "../../lib/pagination.js";

export function isValidIndianVehicleRegistration(reg: string): boolean {
  if (!reg || typeof reg !== "string") return false;
  const trimmed = reg.trim();
  // Allow only letters, digits, and hyphens (no spaces in the middle, no other special characters)
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return false;

  const c = trimmed.toUpperCase().replace(/-/g, "");
  // Allow 9-character and 10-character patterns, but keep typical limits (e.g. 7 to 13 characters)
  if (c.length < 7 || c.length > 13) return false;

  const standard = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}[A-Z0-9]?$/;
  const bhSeries = /^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/;
  return standard.test(c) || bhSeries.test(c);
}

function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0]! : raw!;
}

async function requireOrg(req: Request) {
  if (!req.auth) return null;
  return resolveBranchScope(req.auth);
}

const segmentEnum = z.preprocess(
  (val) => (val === "MUV_MPV" ? "MUV" : val),
  z.enum([
    "HATCHBACK",
    "SEDAN",
    "SUV",
    "LUXURY",
    "MUV",
    "COMPACT_SUV",
    "BIKE",
  ])
);

const fuelEnum = z.enum(["PETROL", "DIESEL", "CNG", "ELECTRIC", "HYBRID"]);

const vehicleSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  customerName: z.string().min(1),
  registrationNumber: z.string().min(1),
  make: z.string().min(1),
  model: z.string().min(1),
  segment: segmentEnum,
  variant: z.string().nullable().optional(),
  fuelType: fuelEnum,
  color: z.string().optional().default("—"),
  year: z.coerce.number().int(),
  notes: z.string().nullable().optional(),
  odometer: z.coerce.number().int().nullable().optional(),
  insuranceProvider: z.string().nullable().optional(),
  insurancePolicyNumber: z.string().nullable().optional(),
  insuranceDueDate: z.string().nullable().optional(),
  vinNumber: z.string().nullable().optional(),
  previousOwners: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullable().optional(),
});

const patchVehicleSchema = vehicleSchema.partial().omit({ id: true });

const bulkItemSchema = z.object({
  registrationNumber: z.string().min(1),
  customerId: z.string().min(1),
  customerName: z.string().min(1),
  make: z.string().min(1),
  model: z.string().min(1),
  fuelType: fuelEnum.default("PETROL"),
  segment: segmentEnum.default("HATCHBACK"),
  year: z.number().int().optional(),
  color: z.string().optional(),
  variant: z.string().optional(),
  notes: z.string().optional(),
});

const bulkSchema = z.object({
  vehicles: z.array(bulkItemSchema).min(1).max(5000),
});

export async function getVehicles(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.json({ data: { vehicles: [] }, error: null });
      return;
    }
    const { page, pageSize } = parsePagination(req);
    
    const result = await listVehiclesApi({ organizationId: scope.organizationId, page, pageSize });
    if (Array.isArray(result)) {
       res.json({ data: { vehicles: result }, error: null });
    } else {
       res.json({ data: { ...result, vehicles: result.items }, error: null });
    }
  } catch (e) {
    next(e);
  }
}

export async function postVehicle(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = vehicleSchema.parse(req.body);
    const isVin = body.vinNumber && body.registrationNumber === body.vinNumber;
    if (!isVin && !isValidIndianVehicleRegistration(body.registrationNumber)) {
      res.status(400).json({ data: null, error: { message: "Invalid registration number format" } });
      return;
    }
    const vehicle = await createVehicleApi({
      ...body,
      organizationId: scope.organizationId,
      segment: body.segment as VehicleSegment,
      fuelType: body.fuelType as FuelType,
      createdByUserId: req.auth?.id,
      updatedByUserId: req.auth?.id,
    });
    res.status(201).json({ data: { vehicle }, error: null });
  } catch (e) {
    if (e instanceof Error && e.message === "Customer not found") {
      res.status(400).json({ data: null, error: { message: e.message } });
      return;
    }
    next(e);
  }
}

export async function postVehiclesBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = bulkSchema.parse(req.body);
    // Validate each vehicle in bulk import
    for (const v of body.vehicles) {
      if (!isValidIndianVehicleRegistration(v.registrationNumber)) {
        res.status(400).json({ data: null, error: { message: `Invalid registration number format: ${v.registrationNumber}` } });
        return;
      }
    }
    const yearDefault = new Date().getFullYear();
    const result = await createVehiclesBulk(
      scope.organizationId,
      body.vehicles.map((v) => ({
        registrationNumber: v.registrationNumber,
        customerId: v.customerId,
        customerName: v.customerName,
        make: v.make,
        model: v.model,
        fuelType: v.fuelType as FuelType,
        segment: v.segment as VehicleSegment,
        year: v.year ?? yearDefault,
        color: v.color?.trim() ? v.color : "—",
        variant: v.variant,
        notes: v.notes,
      }))
    );
    res.status(201).json({
      data: {
        created: result.created,
        skipped: result.skipped,
        createdCount: result.created.length,
        skippedCount: result.skipped.length,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
}

export async function putVehicle(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const id = paramId(req);
    const body = patchVehicleSchema.parse(req.body);
    if (body.registrationNumber !== undefined) {
      const regClean = body.registrationNumber.trim().toUpperCase().replace(/\s/g, "");
      body.registrationNumber = regClean;
      const existing = await prisma.vehicle.findFirst({ where: { id, organizationId: scope.organizationId } });
      if (existing) {
        const vinNumber = body.vinNumber !== undefined ? body.vinNumber : existing.vinNumber;
        const isVin = vinNumber && regClean === vinNumber;
        if (!isVin && !isValidIndianVehicleRegistration(regClean)) {
          res.status(400).json({ data: null, error: { message: "Invalid registration number format" } });
          return;
        }
      }
    }
    const vehicle = await updateVehicleApi(id, scope.organizationId, {
      ...body,
      segment: body.segment as VehicleSegment | undefined,
      fuelType: body.fuelType as FuelType | undefined,
      updatedByUserId: req.auth?.id,
    });
    if (!vehicle) {
      res.status(404).json({ data: null, error: { message: "Vehicle not found" } });
      return;
    }
    if (body.registrationNumber) {
      await prisma.appointment.updateMany({
        where: { vehicleId: id, organizationId: scope.organizationId },
        data: { vehicleRegNumber: body.registrationNumber },
      }).catch((err: unknown) => {
        console.warn("[vehicles/putVehicle] Failed to sync appointments vehicleRegNumber:", err);
      });
    }
    res.json({ data: { vehicle }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function removeVehicle(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const ok = await deleteVehicleApi(paramId(req), scope.organizationId, req.auth?.id);
    if (!ok) {
      res.status(404).json({ data: null, error: { message: "Vehicle not found" } });
      return;
    }
    res.json({ data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
}

const snapshotBodySchema = z.object({
  vehicles: z.array(vehicleSchema),
});

export async function postVehicleSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = await requireOrg(req);
    if (!scope) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = snapshotBodySchema.parse(req.body);

    // Guard: reject empty snapshot when vehicles already exist
    if (body.vehicles.length === 0) {
      const existing = await prisma.vehicle.count({ where: { organizationId: scope.organizationId } });
      if (existing > 0) {
        res.status(409).json({ data: null, error: { message: `Cannot replace vehicles with an empty snapshot — ${existing} existing vehicle(s) would be lost. Delete individually or send the full dataset.` } });
        return;
      }
    }

    for (const v of body.vehicles) {
      const isVin = v.vinNumber && v.registrationNumber === v.vinNumber;
      if (!isVin && !isValidIndianVehicleRegistration(v.registrationNumber)) {
        res.status(400).json({ data: null, error: { message: `Invalid registration number format for ${v.registrationNumber}` } });
        return;
      }
    }
    await replaceAllVehiclesApi(
      scope.organizationId,
      body.vehicles.map((v) => ({
        ...v,
        organizationId: scope.organizationId,
        segment: v.segment as VehicleSegment,
        fuelType: v.fuelType as FuelType,
      }))
    );
    res.json({ data: { ok: true }, error: null });
  } catch (e) {
    next(e);
  }
}

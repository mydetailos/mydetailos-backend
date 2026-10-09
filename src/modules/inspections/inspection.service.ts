import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { collectReferencedCustomerVehicleIds, type BranchScope } from "../../lib/data-scope.js";
import { isExportLocked } from "../../lib/subscription-lock.js";
import {
  deletePrivateInspectionAsset,
  persistPrivateInspectionAsset,
  readPrivateInspectionAsset,
} from "../../services/object-storage.service.js";
import { assertInspectionComplete, inspectionConditionSchema, normalizeInspectionConditions, snapshotInspectionPayload, validateInspectionPayload } from "./inspection-validation.js";
import { renderInspectionPdf } from "./inspection-pdf.service.js";

type InspectionRecord = Prisma.InspectionReportGetPayload<{ include: { versions: true } }>;

function toInspectionItem(row: InspectionRecord | (Omit<InspectionRecord, "versions"> & { versions?: unknown[] })) {
  const { data, versions: _versions, ...serverFields } = row as InspectionRecord;
  const versions = (_versions ?? []).map((version) => ({
    id: version.id,
    revision: version.revision,
    pdfUrl: `/api/inspections/${encodeURIComponent(serverFields.id)}/pdf?revision=${version.revision}`,
    data: { ...version.data as Record<string, unknown>, ...normalizeInspectionConditions(version.data as Record<string, unknown>) },
    finalizedBy: version.finalizedBy,
    finalizedAt: version.finalizedAt,
    createdAt: version.createdAt,
  }));
  const latestFinalizedVersion = (_versions ?? []).reduce<InspectionRecord["versions"][number] | null>(
    (latest, version) => !latest || version.revision > latest.revision ? version : latest,
    null,
  );
  const latestPdfUrl = latestFinalizedVersion
    ? `/api/inspections/${encodeURIComponent(serverFields.id)}/pdf?revision=${latestFinalizedVersion.revision}`
    : undefined;
  return {
    ...(data && typeof data === "object" ? data as Record<string, unknown> : {}),
    ...normalizeInspectionConditions(data as Record<string, unknown>),
    ...serverFields,
    revision: serverFields.revision,
    inspectorId: serverFields.createdBy,
    ...(latestPdfUrl ? { pdfUrl: latestPdfUrl, finalizedRevision: latestFinalizedVersion!.revision } : {}),
    ...(versions.length > 0 ? { versions } : {}),
  };
}

function branchFilter(scope: BranchScope, requestedBranchId?: string): string[] | null {
  if (requestedBranchId?.trim()) {
    const id = requestedBranchId.trim();
    if (scope.allowedBranchIds !== null && !scope.allowedBranchIds.includes(id)) return [];
    return [id];
  }
  return scope.allowedBranchIds;
}

async function assertBranch(scope: BranchScope, branchId?: string): Promise<string> {
  const resolved = branchId?.trim() || (scope.allowedBranchIds?.length === 1 ? scope.allowedBranchIds[0] : "");
  if (!resolved) throw AppError.validation("A branch must be selected.");
  if (scope.allowedBranchIds !== null && !scope.allowedBranchIds.includes(resolved)) {
    throw AppError.forbidden("You do not have access to this branch.");
  }
  const branch = await prisma.branch.findFirst({
    where: { id: resolved, organizationId: scope.organizationId },
    select: { id: true },
  });
  if (!branch) throw AppError.forbidden("The selected branch is not part of your organization.");
  return branch.id;
}

async function assertRelatedRecords(
  scope: BranchScope,
  branchId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const customerId = String(payload.customerId ?? "");
  const vehicleId = String(payload.vehicleId ?? "");
  const [customer, vehicle] = await Promise.all([
    prisma.customer.findFirst({ where: { id: customerId, organizationId: scope.organizationId }, select: { id: true } }),
    prisma.vehicle.findFirst({
      where: { id: vehicleId, organizationId: scope.organizationId, customerId },
      select: { id: true },
    }),
  ]);
  if (!customer) throw AppError.validation("The selected customer does not belong to this organization.");
  if (!vehicle) throw AppError.validation("The selected vehicle does not belong to this customer and organization.");
  if (scope.allowedBranchIds !== null) {
    const referenced = await collectReferencedCustomerVehicleIds(scope.organizationId, scope.allowedBranchIds);
    if ((referenced.customerIds && !referenced.customerIds.has(customerId)) ||
      (referenced.vehicleIds && !referenced.vehicleIds.has(vehicleId))) {
      throw AppError.forbidden("The selected customer or vehicle is outside your branch access.");
    }
  }

  const jobCardId = typeof payload.jobCardId === "string" ? payload.jobCardId.trim() : "";
  if (!jobCardId) return;
  const jobCard = await prisma.appJsonRow.findFirst({
    where: { collection: "jobCards", entityId: jobCardId, organizationId: scope.organizationId },
    select: { payload: true },
  });
  const job = jobCard?.payload && typeof jobCard.payload === "object"
    ? jobCard.payload as Record<string, unknown>
    : null;
  if (!job || job.branchId !== branchId) {
    throw AppError.validation("The linked job card must belong to the inspection branch.");
  }
  if ((job.customerId && job.customerId !== customerId) || (job.vehicleId && job.vehicleId !== vehicleId)) {
    throw AppError.validation("The linked job card must match the selected customer and vehicle.");
  }
}

function collectUploadIds(value: unknown, parentKey = "", ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) collectUploadIds(child, parentKey, ids);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (["photos", "attachments", "inspectionPhotos"].includes(parentKey) && typeof record.id === "string") {
      ids.add(record.id);
    }
    for (const [key, child] of Object.entries(record)) {
      if (["photoId", "uploadId"].includes(key) && typeof child === "string") ids.add(child);
      collectUploadIds(child, key, ids);
    }
  }
  return ids;
}

async function linkPendingUploads(
  tx: Prisma.TransactionClient,
  scope: BranchScope,
  branchId: string,
  reportId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const ids = [...collectUploadIds(payload)];
  if (ids.length === 0) return;
  if (ids.length > 24) throw AppError.validation("Inspection reports may contain at most 24 photos.");
  const checkpointIds = new Set<string>();
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const record = section as Record<string, unknown>;
    const checkpoints = Array.isArray(record.checkpoints) ? record.checkpoints : Array.isArray(record.items) ? record.items : [];
    for (const checkpoint of checkpoints) {
      if (checkpoint && typeof checkpoint === "object" && typeof (checkpoint as Record<string, unknown>).id === "string") {
        checkpointIds.add((checkpoint as Record<string, string>).id);
      }
    }
  }
  const validatePhotoAssociations = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(validatePhotoAssociations);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.checkpointId && !checkpointIds.has(String(record.checkpointId))) {
      throw AppError.validation("A photo references a checkpoint outside this report.");
    }
    Object.values(record).forEach(validatePhotoAssociations);
  };
  validatePhotoAssociations(payload);
  const uploads = await tx.inspectionUpload.findMany({ where: { id: { in: ids } } });
  if (uploads.length !== ids.length || uploads.some((upload) =>
    upload.organizationId !== scope.organizationId ||
    upload.branchId !== branchId ||
    upload.cleaning ||
    (upload.reportId !== null && upload.reportId !== reportId)
  )) {
    throw AppError.forbidden("One or more inspection photos are unavailable or belong to another report.");
  }
  const linkedCount = await tx.inspectionUpload.count({ where: { reportId } });
  const pendingCount = uploads.filter((upload) => upload.reportId === null).length;
  if (linkedCount + pendingCount > 24) throw AppError.validation("Inspection reports may contain at most 24 photos.");
  const linked = await tx.inspectionUpload.updateMany({
    where: { id: { in: ids }, reportId: null, cleaning: false },
    data: { reportId, expiresAt: null },
  });
  if (linked.count !== pendingCount) {
    throw AppError.conflict("One or more inspection photos expired while the report was saving.");
  }
}

async function expireDetachedDraftUploads(
  tx: Prisma.TransactionClient,
  reportId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const currentPhotoIds = collectUploadIds(payload);
  const versions = await tx.inspectionReportVersion.findMany({
    where: { reportId },
    select: { data: true },
  });
  const retainedPhotoIds = new Set<string>();
  for (const version of versions) {
    for (const photoId of collectUploadIds(version.data)) retainedPhotoIds.add(photoId);
  }
  const existing = await tx.inspectionUpload.findMany({
    where: { reportId },
    select: { id: true },
  });
  const detachedIds = existing
    .map((upload) => upload.id)
    .filter((photoId) => !currentPhotoIds.has(photoId) && !retainedPhotoIds.has(photoId));
  if (detachedIds.length === 0) return;
  await tx.inspectionUpload.updateMany({
    where: { id: { in: detachedIds }, reportId },
    data: { reportId: null, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
}

function makeReportNumber(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `INSP-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function sanitizeDraftPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...structuredClone(payload), ...normalizeInspectionConditions(payload) } as Record<string, unknown>;
  for (const field of [
    "id", "reportNumber", "revision", "status", "createdAt", "updatedAt", "createdBy",
    "updatedBy", "inspectorId", "finalizedBy", "finalizedAt", "branchId",
  ]) {
    delete clean[field];
  }
  return clean;
}

export async function createInspection(
  scope: BranchScope,
  actorId: string,
  rawPayload: Record<string, unknown>
) {
  validateInspectionPayload(rawPayload);
  const branchId = await assertBranch(scope, typeof rawPayload.branchId === "string" ? rawPayload.branchId : undefined);
  await assertRelatedRecords(scope, branchId, rawPayload);
  const data = sanitizeDraftPayload(rawPayload);

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.inspectionReport.create({
      data: {
        organizationId: scope.organizationId,
        branchId,
        reportNumber: makeReportNumber(),
        data: data as Prisma.InputJsonValue,
        createdBy: actorId,
        updatedBy: actorId,
      },
      include: { versions: true },
    });
    await linkPendingUploads(tx, scope, branchId, created.id, data);
    return created;
  });
  return toInspectionItem(row);
}

export async function updateInspection(
  scope: BranchScope,
  actorId: string,
  id: string,
  expectedRevision: number,
  rawPayload: Record<string, unknown>
) {
  validateInspectionPayload(rawPayload);
  const branchId = await assertBranch(scope, typeof rawPayload.branchId === "string" ? rawPayload.branchId : undefined);
  await assertRelatedRecords(scope, branchId, rawPayload);
  const nextData = sanitizeDraftPayload(rawPayload);

  const row = await prisma.$transaction(async (tx) => {
    const current = await tx.inspectionReport.findFirst({
      where: { id, organizationId: scope.organizationId, branchId, deletedAt: null },
    });
    if (!current) throw AppError.notFound("Inspection report not found.");
    if (current.revision !== expectedRevision) throw AppError.conflict("Inspection report revision is stale.");
    if (current.status !== "DRAFT") throw AppError.conflict("Finalized inspection reports are read-only.");
    const changed = await tx.inspectionReport.updateMany({
      where: { id, organizationId: scope.organizationId, branchId, revision: expectedRevision, status: "DRAFT", deletedAt: null },
      data: {
        data: nextData as Prisma.InputJsonValue,
        revision: { increment: 1 },
        updatedBy: actorId,
      },
    });
    if (changed.count !== 1) throw AppError.conflict("Inspection report revision is stale.");
    await linkPendingUploads(tx, scope, branchId, id, nextData);
    await expireDetachedDraftUploads(tx, id, nextData);
    return tx.inspectionReport.findUniqueOrThrow({ where: { id }, include: { versions: true } });
  });
  return toInspectionItem(row);
}

export async function getInspection(scope: BranchScope, id: string) {
  const row = await prisma.inspectionReport.findFirst({
    where: {
      id,
      organizationId: scope.organizationId,
      deletedAt: null,
      ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }),
    },
    include: { versions: true },
  });
  return row ? toInspectionItem(row) : null;
}

function inspectionCustomerId(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const value = (data as Record<string, unknown>).customerId;
  return typeof value === "string" ? value.trim() : "";
}

function toCustomerInspectionItem(row: InspectionRecord | (Omit<InspectionRecord, "versions"> & { versions?: unknown[] })) {
  const item = toInspectionItem(row) as Record<string, unknown>;
  const id = String(item.id ?? "");
  const rewritePdf = (url: unknown) =>
    typeof url === "string" ? url.replace(/^\/api\/inspections\//, "/api/customer/inspections/") : url;
  if (item.pdfUrl) item.pdfUrl = rewritePdf(item.pdfUrl);
  if (Array.isArray(item.versions)) {
    item.versions = item.versions.map((version) => {
      if (!version || typeof version !== "object") return version;
      const next = { ...(version as Record<string, unknown>) };
      if (next.pdfUrl) next.pdfUrl = rewritePdf(next.pdfUrl);
      return next;
    });
  }
  // Keep photo asset URLs pointing at customer-auth routes.
  if (Array.isArray(item.photos)) {
    item.photos = item.photos.map((photo) => {
      if (!photo || typeof photo !== "object") return photo;
      const next = { ...(photo as Record<string, unknown>) };
      if (typeof next.url === "string" && next.url.startsWith("/api/inspections/assets/")) {
        next.url = next.url.replace("/api/inspections/assets/", "/api/customer/inspections/assets/");
      }
      return next;
    });
  }
  void id;
  return item;
}

/** FINAL inspection reports owned by the authenticated customer (portal). */
export async function listCustomerInspections(
  organizationId: string,
  customerId: string,
  opts: { page: number; limit: number } = { page: 1, limit: 50 },
) {
  const rows = await prisma.inspectionReport.findMany({
    where: { organizationId, status: "FINAL", deletedAt: null },
    include: { versions: true },
    orderBy: { updatedAt: "desc" },
  });
  const owned = rows.filter((row) => inspectionCustomerId(row.data) === customerId);
  const total = owned.length;
  const page = Math.max(1, opts.page);
  const limit = Math.min(100, Math.max(1, opts.limit));
  return {
    items: owned.slice((page - 1) * limit, page * limit).map((row) => toCustomerInspectionItem(row)),
    total,
    totalPages: Math.ceil(total / limit) || 0,
  };
}

export async function getCustomerInspection(organizationId: string, customerId: string, id: string) {
  const row = await prisma.inspectionReport.findFirst({
    where: { id, organizationId, status: "FINAL", deletedAt: null },
    include: { versions: true },
  });
  if (!row || inspectionCustomerId(row.data) !== customerId) return null;
  return toCustomerInspectionItem(row);
}

export async function getCustomerInspectionDocument(
  organizationId: string,
  customerId: string,
  id: string,
  revision: number,
) {
  const version = await prisma.inspectionReportVersion.findFirst({
    where: {
      reportId: id,
      revision,
      report: { organizationId, status: "FINAL", deletedAt: null },
    },
    select: { documentKey: true, data: true, report: { select: { data: true } } },
  });
  if (!version?.documentKey) return null;
  const ownerId = inspectionCustomerId(version.data) || inspectionCustomerId(version.report.data);
  if (ownerId !== customerId) return null;
  const buffer = await readPrivateInspectionAsset(version.documentKey);
  return buffer ? { buffer, filename: `inspection-${id}-r${revision}.pdf` } : null;
}

export async function customerInspectionUploadAccess(
  organizationId: string,
  customerId: string,
  assetId: string,
) {
  const upload = await prisma.inspectionUpload.findFirst({
    where: {
      id: assetId,
      organizationId,
      cleaning: false,
      reportId: { not: null },
      report: { status: "FINAL", deletedAt: null },
    },
    include: { report: { select: { data: true } } },
  });
  if (!upload?.report || inspectionCustomerId(upload.report.data) !== customerId) return null;
  return upload;
}

export async function softDeleteInspection(scope: BranchScope, actorId: string, id: string): Promise<boolean> {
  const result = await prisma.inspectionReport.updateMany({
    where: {
      id,
      organizationId: scope.organizationId,
      deletedAt: null,
      ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }),
    },
    data: { deletedAt: new Date(), updatedBy: actorId },
  });
  return result.count === 1;
}

function calendarBoundary(value: string | undefined, end = false): Date | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw AppError.validation("Dates must use YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw AppError.validation("Invalid calendar date.");
  }
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export async function listInspections(
  scope: BranchScope,
  opts: { page: number; limit: number; q?: string; branchId?: string; status?: string; from?: string; to?: string }
) {
  const branches = branchFilter(scope, opts.branchId);
  if (branches?.length === 0) return { items: [], total: 0, totalPages: 0 };
  const where: Prisma.InspectionReportWhereInput = {
    organizationId: scope.organizationId,
    deletedAt: null,
    ...(branches ? { branchId: { in: branches } } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  };
  const rows = await prisma.inspectionReport.findMany({ where });
  if (opts.from) calendarBoundary(opts.from);
  if (opts.to) calendarBoundary(opts.to);
  if (opts.from && opts.to && opts.from > opts.to) throw AppError.validation("The start date must be on or before the end date.");
  const inDateRange = rows.filter((row) => {
    const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
    const inspectionDate = typeof data.inspectionDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(data.inspectionDate)
      ? data.inspectionDate.slice(0, 10)
      : row.createdAt.toISOString().slice(0, 10);
    return (!opts.from || inspectionDate >= opts.from) && (!opts.to || inspectionDate <= opts.to);
  }).sort((left, right) => {
    const leftData = left.data && typeof left.data === "object" ? left.data as Record<string, unknown> : {};
    const rightData = right.data && typeof right.data === "object" ? right.data as Record<string, unknown> : {};
    const leftDate = typeof leftData.inspectionDate === "string" ? leftData.inspectionDate : left.createdAt.toISOString();
    const rightDate = typeof rightData.inspectionDate === "string" ? rightData.inspectionDate : right.createdAt.toISOString();
    return rightDate.localeCompare(leftDate);
  });
  const query = opts.q?.trim().toLocaleLowerCase();
  const filtered = query ? inDateRange.filter((row) => {
    const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
    const candidates = [
      row.reportNumber,
      data.customerName,
      data.customerPhone,
      data.phone,
      data.registrationNumber,
      data.vehicleRegistration,
      data.vehicleRegNumber,
    ];
    return candidates.some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query));
  }) : inDateRange;
  const total = filtered.length;
  return {
    items: filtered.slice((opts.page - 1) * opts.limit, opts.page * opts.limit).map((row) => toInspectionItem({ ...row, versions: [] })),
    total,
    totalPages: Math.ceil(total / opts.limit),
  };
}

export async function finalizeInspection(
  scope: BranchScope,
  actorId: string,
  id: string,
  revision: number,
  conditionInput: Record<string, unknown> = {},
) {
  const condition = inspectionConditionSchema.parse(conditionInput);
  let documentKey: string | undefined;
  try {
    /**
     * Keep the DB transaction short: PDF render + private asset I/O must stay
     * outside. Neon/Render interactive transactions default to 5s and expire
     * when finalize includes photos/PDF work inside the transaction.
     */
    const prepared = await prisma.$transaction(
      async (tx) => {
        const current = await tx.inspectionReport.findFirst({
          where: {
            id,
            organizationId: scope.organizationId,
            deletedAt: null,
            ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }),
          },
        });
        if (!current) throw AppError.notFound("Inspection report not found.");
        if (current.revision !== revision) throw AppError.conflict("Inspection report revision is stale.");
        if (current.status !== "DRAFT") throw AppError.conflict("Only draft reports can be finalized.");
        const data: Record<string, unknown> = {
          ...(current.data as Record<string, unknown>),
          ...(condition.overallPreDriveCondition !== undefined
            ? { overallPreDriveCondition: condition.overallPreDriveCondition }
            : {}),
          ...(condition.vehicleConditions !== undefined
            ? { vehicleConditions: condition.vehicleConditions }
            : {}),
        };
        validateInspectionPayload(data);
        assertInspectionComplete(data);
        await assertRelatedRecords(scope, current.branchId, data);
        const [customer, vehicle, branch, settings] = await Promise.all([
          tx.customer.findFirst({
            where: { id: String(data.customerId), organizationId: scope.organizationId },
          }),
          tx.vehicle.findFirst({
            where: {
              id: String(data.vehicleId),
              customerId: String(data.customerId),
              organizationId: scope.organizationId,
            },
          }),
          tx.branch.findFirst({
            where: { id: current.branchId, organizationId: scope.organizationId },
          }),
          tx.appJsonRow.findUnique({
            where: { collection_entityId: { collection: "appSettings", entityId: "default" } },
            select: { payload: true },
          }),
        ]);
        if (!customer || !vehicle || !branch) {
          throw AppError.validation("Customer, vehicle, or branch is no longer available.");
        }
        const appSettings =
          settings?.payload && typeof settings.payload === "object"
            ? (settings.payload as Record<string, unknown>)
            : {};
        const organizationBranding = Object.fromEntries(
          [
            "businessName",
            "businessLogo",
            "businessTagline",
            "businessPhone",
            "businessWhatsApp",
            "businessEmail",
            "businessAddress",
            "businessWebsite",
            "brandPrimary",
          ].flatMap((key) =>
            typeof appSettings[key] === "string" ? [[key, appSettings[key]]] : []
          )
        );
        const snapshot = snapshotInspectionPayload({
          ...data,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          vehicleRegistration: vehicle.registrationNumber,
          registrationNumber: vehicle.registrationNumber,
          vehicleMake: vehicle.make,
          vehicleModel: vehicle.model,
          vehicleMakeModel: `${vehicle.make} ${vehicle.model}`.trim(),
          branchName: branch.name,
          branchAddress: branch.address,
          organizationBranding,
          finalizedBy: actorId,
        });
        const photoIds = [...collectUploadIds(data)];
        const uploads =
          photoIds.length === 0
            ? []
            : await tx.inspectionUpload.findMany({
                where: {
                  id: { in: photoIds },
                  reportId: id,
                  organizationId: scope.organizationId,
                  branchId: current.branchId,
                },
              });
        if (uploads.length !== photoIds.length || uploads.length > 24) {
          throw AppError.validation(
            "Inspection photos are incomplete or exceed the 24-photo limit."
          );
        }
        return { branchId: current.branchId, snapshot, uploads };
      },
      { timeout: 20_000, maxWait: 10_000 }
    );

    const photos = await Promise.all(
      prepared.uploads.map(async (upload) => {
        const buffer = await readPrivateInspectionAsset(upload.objectKey);
        if (!buffer) throw AppError.validation("An inspection photo is no longer available.");
        return { id: upload.id, buffer, mimeType: upload.mimeType };
      })
    );
    const pdf = await renderInspectionPdf(prepared.snapshot, photos);
    documentKey = `inspection-reports/${id}/revision-${revision}-${randomUUID()}.pdf`;
    await persistPrivateInspectionAsset({
      objectKey: documentKey,
      buffer: pdf,
      mimeType: "application/pdf",
    });

    const row = await prisma.$transaction(
      async (tx) => {
        const changed = await tx.inspectionReport.updateMany({
          where: {
            id,
            organizationId: scope.organizationId,
            revision,
            status: "DRAFT",
            deletedAt: null,
          },
          data: {
            status: "FINAL",
            data: prepared.snapshot as Prisma.InputJsonValue,
            finalizedAt: new Date(),
            updatedBy: actorId,
          },
        });
        if (changed.count !== 1) throw AppError.conflict("Inspection report revision is stale.");
        await tx.inspectionReportVersion.create({
          data: {
            reportId: id,
            revision,
            data: prepared.snapshot as Prisma.InputJsonValue,
            documentKey,
            finalizedBy: actorId,
          },
        });
        return tx.inspectionReport.findUniqueOrThrow({
          where: { id },
          include: { versions: true },
        });
      },
      { timeout: 15_000, maxWait: 10_000 }
    );
    return toInspectionItem(row);
  } catch (error) {
    if (documentKey) await deletePrivateInspectionAsset(documentKey).catch(() => undefined);
    throw error;
  }
}

export async function createInspectionRevision(scope: BranchScope, actorId: string, id: string, revision: number) {
  const row = await prisma.$transaction(async (tx) => {
    const current = await tx.inspectionReport.findFirst({
      where: { id, organizationId: scope.organizationId, deletedAt: null, ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }) },
      include: { versions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!current) throw AppError.notFound("Inspection report not found.");
    if (current.revision !== revision) throw AppError.conflict("Inspection report revision is stale.");
    if (current.status !== "FINAL" || current.versions.length === 0) {
      throw AppError.conflict("Only finalized reports can be revised.");
    }
    const changed = await tx.inspectionReport.updateMany({
      where: { id, organizationId: scope.organizationId, revision, status: "FINAL", deletedAt: null },
      data: {
        revision: { increment: 1 },
        status: "DRAFT",
        data: current.versions[0]!.data as Prisma.InputJsonValue,
        finalizedAt: null,
        updatedBy: actorId,
      },
    });
    if (changed.count !== 1) throw AppError.conflict("Inspection report revision is stale.");
    return tx.inspectionReport.findUniqueOrThrow({ where: { id }, include: { versions: true } });
  });
  return toInspectionItem(row);
}

export async function listInspectionTemplates(organizationId: string) {
  return prisma.inspectionTemplate.findMany({ where: { organizationId }, orderBy: { updatedAt: "desc" } });
}

export async function createInspectionTemplate(
  organizationId: string,
  actorId: string,
  input: { name: string; sections: unknown[]; terms: string | string[] }
) {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TEMPLATE_BYTES) {
    throw AppError.validation("Inspection template exceeds the 256 KB limit.");
  }
  return prisma.inspectionTemplate.create({
    data: {
      organizationId,
      name: input.name,
      sections: input.sections as Prisma.InputJsonValue,
      terms: input.terms as Prisma.InputJsonValue,
      createdBy: actorId,
    },
  });
}

const MAX_TEMPLATE_BYTES = 256 * 1024;

export async function listInspectionSendHistory(
  scope: BranchScope,
  opts: { page: number; limit: number; q?: string; branchId?: string; status?: string; from?: string; to?: string }
) {
  const branches = branchFilter(scope, opts.branchId);
  if (branches?.length === 0) return { items: [], total: 0, totalPages: 0 };
  const rows = await prisma.inspectionSendLog.findMany({
    where: {
      organizationId: scope.organizationId,
      report: {
        deletedAt: null,
        ...(branches ? { branchId: { in: branches } } : {}),
      },
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.from || opts.to ? { sentAt: { ...(calendarBoundary(opts.from) ? { gte: calendarBoundary(opts.from) } : {}), ...(calendarBoundary(opts.to, true) ? { lt: calendarBoundary(opts.to, true) } : {}) } } : {}),
    },
    include: { report: true },
    orderBy: { sentAt: "desc" },
  });
  const query = opts.q?.trim().toLocaleLowerCase();
  const filtered = query ? rows.filter((row) => {
    const data = row.report.data && typeof row.report.data === "object" ? row.report.data as Record<string, unknown> : {};
    return [row.report.reportNumber, row.recipient, data.customerName, data.customerPhone, data.phone, data.registrationNumber, data.vehicleRegistration]
      .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query));
  }) : rows;
  const total = filtered.length;
  const items = filtered.slice((opts.page - 1) * opts.limit, opts.page * opts.limit).map(({ report, ...log }) => {
    const data = report.data && typeof report.data === "object" ? report.data as Record<string, unknown> : {};
    return {
      id: log.id,
      inspectionId: report.id,
      reportId: log.reportId,
      pdfUrl: `/api/inspections/send-history/${log.id}/pdf`,
      reportNumber: report.reportNumber,
      revision: log.revision,
      requestId: log.requestId,
      channel: log.channel,
      recipient: log.recipient,
      status: log.status,
      providerMessageId: log.providerMessageId,
      providerError: log.providerError,
      sentBy: log.sentBy,
      sentAt: log.sentAt,
      updatedAt: log.updatedAt,
      customerName: data.customerName,
      customerPhone: data.customerPhone ?? data.phone,
      registrationNumber: data.registrationNumber ?? data.vehicleRegistration,
    };
  });
  return { items, total, totalPages: Math.ceil(total / opts.limit) };
}

export async function inspectionUploadAccess(scope: BranchScope, userId: string, id: string) {
  const upload = await prisma.inspectionUpload.findFirst({
    where: {
      id,
      organizationId: scope.organizationId,
      cleaning: false,
      OR: [
        { reportId: { not: null }, report: { deletedAt: null } },
        { reportId: null, createdBy: userId, expiresAt: { gt: new Date() } },
      ],
      ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }),
    },
  });
  if (!upload) return null;
  return upload;
}

export async function getInspectionDocument(scope: BranchScope, id: string, revision: number) {
  const version = await prisma.inspectionReportVersion.findFirst({
    where: {
      reportId: id,
      revision,
      report: {
        organizationId: scope.organizationId,
        deletedAt: null,
        ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }),
      },
    },
    select: { documentKey: true },
  });
  if (!version?.documentKey) return null;
  const subscription = await prisma.organizationSubscription.findUnique({
    where: { organizationId: scope.organizationId },
    select: { expiresAt: true, currentPeriodEnd: true },
  });
  if (isExportLocked(subscription?.expiresAt ?? subscription?.currentPeriodEnd)) {
    throw AppError.forbidden("Inspection PDF export is locked by the organization subscription.");
  }
  const buffer = await readPrivateInspectionAsset(version.documentKey);
  return buffer ? { buffer, filename: `inspection-${id}-r${revision}.pdf` } : null;
}

export async function getInspectionSendDocument(scope: BranchScope, sendLogId: string) {
  const sendLog = await prisma.inspectionSendLog.findFirst({
    where: {
      id: sendLogId,
      organizationId: scope.organizationId,
      documentKey: { not: "" },
      report: {
        deletedAt: null,
        ...(scope.allowedBranchIds === null ? {} : { branchId: { in: scope.allowedBranchIds } }),
      },
    },
    select: { reportId: true, revision: true, documentKey: true, report: { select: { branchId: true } } },
  });
  if (!sendLog) return null;
  const subscription = await prisma.organizationSubscription.findUnique({
    where: { organizationId: scope.organizationId },
    select: { expiresAt: true, currentPeriodEnd: true },
  });
  if (isExportLocked(subscription?.expiresAt ?? subscription?.currentPeriodEnd)) {
    throw AppError.forbidden("Inspection PDF export is locked by the organization subscription.");
  }
  const version = await prisma.inspectionReportVersion.findUnique({
    where: { reportId_revision: { reportId: sendLog.reportId, revision: sendLog.revision } },
    select: { data: true },
  });
  if (!version?.data || typeof version.data !== "object" || Array.isArray(version.data)) return null;
  const snapshot = version.data as Record<string, unknown>;
  const photoIds = [...collectUploadIds(snapshot)];
  const uploads = photoIds.length === 0 ? [] : await prisma.inspectionUpload.findMany({
    where: {
      id: { in: photoIds },
      reportId: sendLog.reportId,
      organizationId: scope.organizationId,
      branchId: sendLog.report.branchId,
    },
  });
  if (uploads.length !== photoIds.length) throw AppError.notFound("Historical inspection photos are unavailable.");
  const photos = await Promise.all(uploads.map(async (upload) => {
    const buffer = await readPrivateInspectionAsset(upload.objectKey);
    if (!buffer) throw AppError.notFound("Historical inspection photos are unavailable.");
    return { id: upload.id, buffer, mimeType: upload.mimeType };
  }));
  const buffer = await renderInspectionPdf(snapshot, photos);
  return buffer
    ? { buffer, filename: `inspection-${sendLog.reportId}-r${sendLog.revision}.pdf` }
    : null;
}

export async function cleanupExpiredInspectionUploads(limit = 200): Promise<number> {
  const expired = await prisma.inspectionUpload.findMany({
    where: { reportId: null, cleaning: false, expiresAt: { lte: new Date() } },
    select: { id: true, objectKey: true },
    take: Math.min(Math.max(limit, 1), 1000),
  });
  let removedCount = 0;
  for (const upload of expired) {
    const claimed = await prisma.inspectionUpload.updateMany({
      where: { id: upload.id, reportId: null, cleaning: false, expiresAt: { lte: new Date() } },
      data: { cleaning: true },
    });
    if (claimed.count !== 1) continue;
    try {
      await deletePrivateInspectionAsset(upload.objectKey);
      const removed = await prisma.inspectionUpload.deleteMany({
        where: { id: upload.id, cleaning: true, reportId: null },
      });
      removedCount += removed.count;
    } catch (error) {
      await prisma.inspectionUpload.updateMany({ where: { id: upload.id, cleaning: true }, data: { cleaning: false } });
      throw error;
    }
  }
  return removedCount;
}

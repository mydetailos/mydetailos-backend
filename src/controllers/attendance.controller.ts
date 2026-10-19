import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { AttendanceStatus } from "@prisma/client";
import { listAttendance, resetAttendance } from "../services/attendance.service.js";
import { prisma } from "../lib/prisma.js";

export async function getAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const branchId =
      typeof req.query.branchId === "string" && req.query.branchId.trim()
        ? req.query.branchId.trim()
        : undefined;
    const records = await listAttendance(branchId);
    res.json({ data: { records }, error: null });
  } catch (e) {
    next(e);
  }
}

export async function deleteAttendance(_req: Request, res: Response, next: NextFunction) {
  try {
    await resetAttendance();
    res.json({ data: { ok: true, records: [] }, error: null });
  } catch (e) {
    next(e);
  }
}

const attendanceStatusEnum = z.enum(["PRESENT", "ABSENT", "LATE", "HALF_DAY"]);

const upsertAttendanceSchema = z.object({
  staffId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkIn: z.string().nullable().optional(),
  checkOut: z.string().nullable().optional(),
  durationMinutes: z.number().int().nullable().optional(),
  status: attendanceStatusEnum,
});

/** Manual attendance create/upsert by admin */
export async function upsertAttendanceRecord(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.auth) {
      res.status(401).json({ data: null, error: { message: "Unauthorized" } });
      return;
    }
    const body = upsertAttendanceSchema.parse(req.body);
    const staff = await prisma.user.findUnique({
      where: { id: body.staffId },
      select: { id: true, name: true, role: true, branchId: true },
    });
    if (!staff) {
      res.status(404).json({ data: null, error: { message: "Staff member not found" } });
      return;
    }
    const idParam = req.params.id;
    const id = typeof idParam === "string" && idParam.trim() ? idParam.trim() : undefined;
    const existing = id
      ? await prisma.attendance.findUnique({ where: { id } })
      : await prisma.attendance.findFirst({
          where: { staffId: staff.id, date: body.date },
        });

    if (id && !existing) {
      res.status(404).json({ data: null, error: { message: "Attendance record not found" } });
      return;
    }

    const record = existing
      ? await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            staffId: staff.id,
            staffName: staff.name,
            staffRole: staff.role,
            branchId: staff.branchId,
            date: body.date,
            checkIn: body.checkIn ?? null,
            checkOut: body.checkOut ?? null,
            durationMinutes: body.durationMinutes ?? null,
            status: body.status as AttendanceStatus,
          },
        })
      : await prisma.attendance.create({
          data: {
            staffId: staff.id,
            staffName: staff.name,
            staffRole: staff.role,
            branchId: staff.branchId,
            date: body.date,
            checkIn: body.checkIn ?? null,
            checkOut: body.checkOut ?? null,
            durationMinutes: body.durationMinutes ?? null,
            status: body.status as AttendanceStatus,
            qrScanned: false,
          },
        });
    res.json({ data: { record }, error: null });
  } catch (e) {
    next(e);
  }
}

#!/usr/bin/env tsx
/**
 * Seed realistic test data into ONE organization (does not touch other tenants).
 *
 *   npx tsx scripts/seed-org-demo.ts amar-car-care
 *
 * Re-runnable: removes rows whose ids start with the org prefix, then recreates them.
 * Dates are relative to "now" so dashboard KPIs (today / last 30 days) are populated.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { singletonStorageEntityId } from "../src/constants/json-collections.js";

const slug = (process.argv[2] ?? "").trim().toLowerCase();
if (!slug) {
  console.error("Usage: npx tsx scripts/seed-org-demo.ts <org-slug>");
  process.exit(1);
}

const STAFF_PASSWORD = "Test@12345";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();

function at(daysAgo: number, hour: number, minute = 0): Date {
  const d = new Date(now.getTime() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function iso(daysAgo: number, hour = 10, minute = 0): string {
  return at(daysAgo, hour, minute).toISOString();
}
function ymd(daysAgo: number): string {
  const d = at(daysAgo, 12);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function main() {
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org) throw new Error(`Organization with slug "${slug}" not found`);
  const orgId = org.id;
  const P = slug
    .split("-")
    .map((s) => s[0])
    .join("")
    .slice(0, 4);
  const id = (kind: string, n: number | string) => `${P}-${kind}-${String(n).padStart(3, "0")}`;

  const owner = await prisma.user.findFirst({
    where: { organizationId: orgId, role: "SUPER_ADMIN" },
    orderBy: { id: "asc" },
  });
  if (!owner) throw new Error("No SUPER_ADMIN user in this organization");

  // ---------- Cleanup (only this org + this prefix) ----------
  const prefix = `${P}-`;
  await prisma.appJsonRow.deleteMany({
    where: { organizationId: orgId, entityId: { startsWith: prefix } },
  });
  await prisma.appointment.deleteMany({
    where: { organizationId: orgId, id: { startsWith: prefix } },
  });
  await prisma.vehicle.deleteMany({ where: { organizationId: orgId, id: { startsWith: prefix } } });
  await prisma.customer.deleteMany({ where: { organizationId: orgId, id: { startsWith: prefix } } });

  // ---------- Branch (org must own its branch) ----------
  const branchId = id("br", "main");
  await prisma.branch.upsert({
    where: { id: branchId },
    create: {
      id: branchId,
      organizationId: orgId,
      name: `${org.name} - Main`,
      code: "MAIN",
      address: "Plot 21, Sector 18, Noida",
      city: "Noida",
      state: "UP",
      pincode: "201301",
      phone: "+917004509790",
      email: owner.email,
      isActive: true,
      qrCodeId: `qr-${P}-main`,
      managerName: owner.name,
      managerPhone: owner.phone,
    },
    update: { organizationId: orgId, isActive: true },
  });
  await prisma.user.update({ where: { id: owner.id }, data: { branchId } });

  // ---------- Staff (plan maxStaff includes owner) ----------
  const staffHash = await bcrypt.hash(STAFF_PASSWORD, 10);
  const staffSeed = [
    { n: 1, name: "Rahul Verma", role: "MECHANIC" as const, phone: "+919811100001", pin: "2001" },
    { n: 2, name: "Pooja Singh", role: "RECEPTIONIST" as const, phone: "+919811100002", pin: "2002" },
  ];
  for (const s of staffSeed) {
    const staffId = id("usr", s.n);
    const email = `${s.name.split(" ")[0].toLowerCase()}.${slug}@example.test`;
    await prisma.user.upsert({
      where: { id: staffId },
      create: {
        id: staffId,
        name: s.name,
        email,
        phone: s.phone,
        role: s.role,
        branchId,
        organizationId: orgId,
        isActive: true,
        emailVerified: true,
        attendancePin: s.pin,
        passwordHash: staffHash,
        mustChangePassword: false,
        joiningDate: ymd(180),
        baseSalary: s.role === "MECHANIC" ? 22000 : 18000,
      },
      update: { branchId, organizationId: orgId, isActive: true, passwordHash: staffHash },
    });
  }
  const mechanic = { id: id("usr", 1), name: "Rahul Verma" };
  const reception = { id: id("usr", 2), name: "Pooja Singh" };

  // ---------- Customers + vehicles ----------
  const people = [
    ["Vikram Malhotra", "+919900000001", "Sector 50, Noida", "Hyundai", "Creta", "COMPACT_SUV", "DIESEL", "White", 2022, "UP16AB1234"],
    ["Sneha Kapoor", "+919900000002", "Indirapuram, Ghaziabad", "Maruti", "Swift", "HATCHBACK", "PETROL", "Red", 2021, "UP14CD5678"],
    ["Arjun Mehta", "+919900000003", "Sector 62, Noida", "Toyota", "Fortuner", "SUV", "DIESEL", "Black", 2023, "DL3CAF4321"],
    ["Neha Gupta", "+919900000004", "Vaishali, Ghaziabad", "Honda", "City", "SEDAN", "PETROL", "Silver", 2020, "UP14EF9087"],
    ["Rohit Sharma", "+919900000005", "Greater Noida West", "Mahindra", "XUV700", "SUV", "DIESEL", "Blue", 2024, "UP16GH2468"],
    ["Kavya Iyer", "+919900000006", "Sector 137, Noida", "Tata", "Nexon EV", "COMPACT_SUV", "ELECTRIC", "Teal", 2023, "UP16EV1357"],
    ["Aman Khanna", "+919900000007", "Mayur Vihar, Delhi", "BMW", "3 Series", "LUXURY", "PETROL", "Grey", 2022, "DL8CBM3333"],
    ["Priya Nair", "+919900000008", "Sector 76, Noida", "Kia", "Seltos", "COMPACT_SUV", "PETROL", "White", 2021, "UP16KS7777"],
  ] as const;

  const customers = people.map((p, i) => ({
    id: id("cust", i + 1),
    name: p[0],
    phone: p[1],
    address: p[2],
    vehicle: {
      id: id("veh", i + 1),
      make: p[3],
      model: p[4],
      segment: p[5],
      fuelType: p[6],
      color: p[7],
      year: p[8],
      reg: p[9],
    },
  }));

  for (const [i, c] of customers.entries()) {
    await prisma.customer.create({
      data: {
        id: c.id,
        organizationId: orgId,
        name: c.name,
        phone: c.phone,
        email: `${c.name.split(" ")[0].toLowerCase()}${i + 1}@example.test`,
        address: c.address,
        referralCode: `${P.toUpperCase()}REF${i + 1}`,
        totalVisits: 1 + (i % 4),
        rewardPoints: 50 * (i % 5),
        walletBalance: i % 3 === 0 ? 500 : 0,
        lastVisitDate: ymd(i * 4),
        createdAt: at(90 - i * 8, 11),
        createdByUserId: owner.id,
      },
    });
    await prisma.vehicle.create({
      data: {
        id: c.vehicle.id,
        organizationId: orgId,
        customerId: c.id,
        customerName: c.name,
        registrationNumber: c.vehicle.reg,
        make: c.vehicle.make,
        model: c.vehicle.model,
        segment: c.vehicle.segment,
        fuelType: c.vehicle.fuelType,
        color: c.vehicle.color,
        year: c.vehicle.year,
        odometer: 15000 + i * 7300,
        createdByUserId: owner.id,
      },
    });
  }

  // ---------- Service catalog ----------
  const categories = [
    { id: id("cat", 1), name: "Wash & Foam", slug: "wash", order: 1, bikeOnly: false },
    { id: id("cat", 2), name: "Interior", slug: "interior", order: 2, bikeOnly: false },
    { id: id("cat", 3), name: "Paint Protection", slug: "protection", order: 3, bikeOnly: false },
  ];
  const services = [
    { n: 1, name: "Foam Wash", price: 799, cat: 1, mins: 40 },
    { n: 2, name: "Interior Deep Cleaning", price: 2499, cat: 2, mins: 120 },
    { n: 3, name: "Ceramic Coating", price: 18999, cat: 3, mins: 480 },
    { n: 4, name: "Paint Correction", price: 6999, cat: 3, mins: 240 },
    { n: 5, name: "PPF Front Kit", price: 24999, cat: 3, mins: 360 },
    { n: 6, name: "AC Vent Sanitization", price: 999, cat: 2, mins: 45 },
  ].map((s) => ({
    id: id("srv", s.n),
    name: s.name,
    description: `${s.name} service`,
    defaultPrice: s.price,
    category: id("cat", s.cat),
    isAddon: false,
    scope: "GLOBAL",
    isActive: true,
    isHighEnd: s.price > 10000,
    incentivePercent: 8,
    durationMinutes: s.mins,
    maxDurationMinutes: Math.round(s.mins * 1.3),
    gstApplicable: true,
    gstPercent: 18,
  }));

  // ---------- Job cards ----------
  type JobPlan = {
    n: number;
    cust: number;
    srv: number[];
    status: string;
    createdDaysAgo: number;
    hour: number;
  };
  const jobPlans: JobPlan[] = [
    { n: 1, cust: 1, srv: [1, 2], status: "RECEIVED", createdDaysAgo: 0, hour: 9 },
    { n: 2, cust: 2, srv: [1], status: "INSPECTION", createdDaysAgo: 0, hour: 10 },
    { n: 3, cust: 3, srv: [3], status: "AWAITING_SERVICE", createdDaysAgo: 0, hour: 11 },
    { n: 4, cust: 4, srv: [4, 6], status: "QUALITY_CHECK", createdDaysAgo: 1, hour: 12 },
    { n: 5, cust: 5, srv: [5], status: "READY", createdDaysAgo: 2, hour: 10 },
    { n: 6, cust: 6, srv: [2, 6], status: "DELIVERED", createdDaysAgo: 1, hour: 9 },
    { n: 7, cust: 7, srv: [3, 1], status: "DELIVERED", createdDaysAgo: 6, hour: 11 },
    { n: 8, cust: 8, srv: [4], status: "DELIVERED", createdDaysAgo: 10, hour: 10 },
    { n: 9, cust: 1, srv: [1, 6], status: "DELIVERED", createdDaysAgo: 15, hour: 14 },
    { n: 10, cust: 3, srv: [2], status: "DELIVERED", createdDaysAgo: 22, hour: 15 },
    { n: 11, cust: 5, srv: [3], status: "DELIVERED", createdDaysAgo: 38, hour: 10 },
    { n: 12, cust: 2, srv: [4, 1], status: "DELIVERED", createdDaysAgo: 50, hour: 12 },
  ];

  const jobCards = jobPlans.map((j) => {
    const c = customers[j.cust - 1];
    const jcId = id("jc", j.n);
    const delivered = j.status === "DELIVERED";
    const items = j.srv.map((s, k) => {
      const svc = services[s - 1];
      const done = delivered || j.status === "READY" || j.status === "QUALITY_CHECK";
      return {
        id: `${jcId}-si-${k + 1}`,
        jobCardId: jcId,
        serviceCatalogId: svc.id,
        name: svc.name,
        price: svc.defaultPrice,
        isCompleted: done,
        ...(done ? { completedAt: iso(Math.max(j.createdDaysAgo - 1, 0), 17) } : {}),
        durationMinutes: svc.durationMinutes,
      };
    });
    const estimatedAmount = items.reduce((s, it) => s + it.price, 0);
    return {
      id: jcId,
      jobNumber: `JC-${now.getFullYear()}-${String(100 + j.n)}`,
      branchId,
      customerId: c.id,
      customerName: c.name,
      customerPhone: c.phone,
      vehicleId: c.vehicle.id,
      vehicleRegNumber: c.vehicle.reg,
      vehicleMakeModel: `${c.vehicle.make} ${c.vehicle.model}`,
      vehicleSegment: c.vehicle.segment,
      mechanicId: mechanic.id,
      mechanicName: mechanic.name,
      status: j.status,
      reportedIssues: "Customer requested detailing",
      odometerReading: 15000 + j.n * 1100,
      expectedDelivery: iso(j.createdDaysAgo - 1, 18),
      ...(delivered ? { actualDelivery: iso(Math.max(j.createdDaysAgo - 1, 0), 18) } : {}),
      services: items,
      estimatedAmount,
      incentivePercent: 8,
      incentiveAmount: Math.round(estimatedAmount * 0.08),
      termsAndConditions: "Standard workshop T&C apply.",
      notes: "",
      createdBy: owner.id,
      createdAt: iso(j.createdDaysAgo, j.hour),
      updatedAt: iso(Math.max(j.createdDaysAgo - 1, 0), 18),
    };
  });

  // ---------- Invoices (delivered + ready jobs) ----------
  const methods = ["UPI", "CASH", "CARD", "UPI", "CASH"];
  const invoiceSource = jobCards.filter((jc) => ["DELIVERED", "READY"].includes(jc.status));
  const invoices = invoiceSource.map((jc, i) => {
    const subtotal = jc.estimatedAmount;
    const taxAmount = Math.round(subtotal * 0.18);
    const grandTotal = subtotal + taxAmount;
    const invId = id("inv", i + 1);
    const paid = jc.status === "DELIVERED";
    const createdDaysAgo = jobPlans.find((p) => id("jc", p.n) === jc.id)!.createdDaysAgo;
    const createdAt = iso(Math.max(createdDaysAgo - 1, 0), 17);
    return {
      id: invId,
      invoiceNumber: `INV-${now.getFullYear()}-${String(300 + i + 1)}`,
      jobCardId: jc.id,
      jobNumber: jc.jobNumber,
      branchId,
      customerId: jc.customerId,
      customerName: jc.customerName,
      customerPhone: jc.customerPhone,
      vehicleRegNumber: jc.vehicleRegNumber,
      lineItems: jc.services.map((s, k) => ({
        id: `${invId}-li-${k + 1}`,
        description: s.name,
        type: "SERVICE",
        quantity: 1,
        unitPrice: s.price,
        total: s.price,
      })),
      subtotal,
      taxRate: 18,
      taxAmount,
      discountAmount: 0,
      rewardDiscount: 0,
      walletAmountUsed: 0,
      grandTotal,
      status: paid ? "PAID" : "ISSUED",
      payments: paid
        ? [
            {
              id: `${invId}-pay-1`,
              invoiceId: invId,
              amount: grandTotal,
              method: methods[i % methods.length],
              referenceNumber: `REF${1000 + i}`,
              paidAt: createdAt,
            },
          ]
        : [],
      mechanicName: mechanic.name,
      createdAt,
    };
  });

  // ---------- Expenses ----------
  const expenses = [
    { n: 1, title: "Shop rent", category: "RENT", amount: 35000, d: 9 },
    { n: 2, title: "Electricity bill", category: "UTILITIES", amount: 6200, d: 5 },
    { n: 3, title: "Ceramic coating stock", category: "SUPPLIES", amount: 14500, d: 3 },
    { n: 4, title: "Foam shampoo & microfiber", category: "SUPPLIES", amount: 2800, d: 0 },
    { n: 5, title: "Staff tea & snacks", category: "MISCELLANEOUS", amount: 450, d: 0 },
    { n: 6, title: "Shop rent", category: "RENT", amount: 35000, d: 40 },
  ].map((e) => ({
    id: id("exp", e.n),
    title: e.title,
    category: e.category,
    description: e.title,
    amount: e.amount,
    date: ymd(e.d),
    vendorName: "Local vendor",
    paymentStatus: "PAID",
    paymentMethod: e.category === "RENT" ? "BANK_TRANSFER" : "UPI",
    createdBy: owner.id,
    createdByName: owner.name,
    branchId,
    createdAt: iso(e.d, 13),
  }));

  // ---------- Appointments / bookings ----------
  const appointments = [
    { n: 1, cust: 4, srv: 3, d: 0, time: "15:00", kind: "BOOKING" },
    { n: 2, cust: 6, srv: 1, d: 0, time: "17:30", kind: "BOOKING" },
    { n: 3, cust: 7, srv: 5, d: -1, time: "11:00", kind: "BOOKING" },
    { n: 4, cust: 8, srv: 2, d: -2, time: "10:30", kind: "APPOINTMENT" },
    { n: 5, cust: 2, srv: 4, d: -4, time: "12:00", kind: "BOOKING" },
  ].map((a) => {
    const c = customers[a.cust - 1];
    const svc = services[a.srv - 1];
    const gst = Math.round(svc.defaultPrice * 0.18);
    return {
      id: id("apt", a.n),
      kind: a.kind,
      bookingId: a.kind === "BOOKING" ? `BK-${P.toUpperCase()}-${100 + a.n}` : `AP-${P.toUpperCase()}-${100 + a.n}`,
      ...(a.kind === "APPOINTMENT" ? { appointmentNumber: `AP-${P.toUpperCase()}-${100 + a.n}` } : {}),
      branchId,
      customerId: c.id,
      customerName: c.name,
      customerPhone: c.phone,
      vehicleId: c.vehicle.id,
      vehicleRegNumber: c.vehicle.reg,
      vehicleMakeModel: `${c.vehicle.make} ${c.vehicle.model}`,
      serviceType: svc.name,
      mechanicId: mechanic.id,
      mechanicName: mechanic.name,
      date: ymd(a.d),
      time: a.time,
      status: "SCHEDULED",
      notes: "",
      whatsappSent: false,
      createdAt: iso(Math.max(a.d, 0) + 2, 10),
      customerFirstName: c.name.split(" ")[0],
      priceSubtotalExGst: svc.defaultPrice,
      priceGstAmount: gst,
      priceGrandTotal: svc.defaultPrice + gst,
    };
  });

  // ---------- Inventory ----------
  const parts = [
    { n: 1, name: "Microfiber cloth pack", qty: 3, reorder: 10, price: 350, cat: "Detailing" },
    { n: 2, name: "Foam shampoo 5L", qty: 12, reorder: 4, price: 1200, cat: "Wash" },
    { n: 3, name: "Ceramic coating kit", qty: 2, reorder: 3, price: 6500, cat: "Protection" },
    { n: 4, name: "Tyre dresser 1L", qty: 9, reorder: 3, price: 450, cat: "Detailing" },
    { n: 5, name: "Interior cleaner 1L", qty: 0, reorder: 4, price: 550, cat: "Interior" },
  ].map((p) => ({
    id: id("part", p.n),
    name: p.name,
    sku: `${P.toUpperCase()}-SKU-${100 + p.n}`,
    category: p.cat,
    quantity: p.qty,
    primaryUnit: "PCS",
    unitPrice: p.price,
    reorderLevel: p.reorder,
    supplier: "Detailing Supplies Co.",
    lastRestocked: ymd(12),
    branchId,
  }));

  // ---------- Reminders / quotations / follow-ups ----------
  const serviceReminders = customers.slice(0, 5).map((c, i) => ({
    id: id("rem", i + 1),
    branchId,
    vehicleId: c.vehicle.id,
    vehicleRegNumber: c.vehicle.reg,
    vehicleMakeModel: `${c.vehicle.make} ${c.vehicle.model}`,
    customerId: c.id,
    customerName: c.name,
    customerPhone: c.phone,
    type: "GENERAL_SERVICE",
    frequency: "QUARTERLY",
    dueDate: ymd(i * 3 - 6),
    lastServiceDate: ymd(80 - i * 3),
    status: i < 2 ? "DUE" : "UPCOMING",
    isHighEndService: false,
    notes: "",
  }));

  const quotations = [1, 2, 3].map((n) => {
    const c = customers[n + 2];
    const svc = services[n + 1];
    const tax = Math.round(svc.defaultPrice * 0.18);
    return {
      id: id("qt", n),
      quotationNumber: `QT-${now.getFullYear()}-${200 + n}`,
      branchId,
      customerId: c.id,
      customerName: c.name,
      customerPhone: c.phone,
      vehicleId: c.vehicle.id,
      vehicleRegNumber: c.vehicle.reg,
      vehicleMakeModel: `${c.vehicle.make} ${c.vehicle.model}`,
      vehicleSegment: c.vehicle.segment,
      services: [{ serviceCatalogId: svc.id, name: svc.name, price: svc.defaultPrice }],
      subtotal: svc.defaultPrice,
      taxRate: 18,
      taxAmount: tax,
      grandTotal: svc.defaultPrice + tax,
      status: n === 1 ? "APPROVED" : "SENT",
      sentViaWhatsApp: false,
      customerApproved: n === 1,
      validUntil: ymd(-15),
      createdBy: owner.id,
      createdAt: iso(n * 2, 11),
      updatedAt: iso(n, 11),
    };
  });

  const followUps = customers.slice(5).map((c, i) => ({
    id: id("fu", i + 1),
    branchId,
    customerId: c.id,
    customerName: c.name,
    customerPhone: c.phone,
    lastVisitDate: ymd(30 + i * 5),
    daysSinceLastVisit: 30 + i * 5,
    assignedTo: reception.id,
    assignedToName: reception.name,
    status: "PENDING",
    nextCallbackDate: ymd(-(i + 1)),
    createdAt: iso(5, 10),
    updatedAt: iso(2, 10),
  }));

  // ---------- Write array collections ----------
  const arrays: Record<string, { id: string; createdAt?: string }[]> = {
    serviceCategories: categories,
    serviceCatalog: services,
    jobCards,
    invoices,
    expenses,
    appointments,
    parts,
    serviceReminders,
    quotations,
    followUps,
  };
  for (const [collection, items] of Object.entries(arrays)) {
    for (const item of items) {
      await prisma.appJsonRow.create({
        data: {
          collection,
          entityId: item.id,
          organizationId: orgId,
          payload: item as unknown as Prisma.InputJsonValue,
          ...(item.createdAt ? { createdAt: new Date(item.createdAt) } : {}),
        },
      });
    }
  }

  for (const a of appointments) {
    await prisma.appointment.create({
      data: {
        id: a.id,
        organizationId: orgId,
        bookingId: a.bookingId,
        appointmentNumber: a.appointmentNumber ?? null,
        kind: a.kind,
        branchId,
        customerId: a.customerId,
        customerName: a.customerName,
        customerPhone: a.customerPhone,
        vehicleId: a.vehicleId,
        vehicleRegNumber: a.vehicleRegNumber,
        vehicleMakeModel: a.vehicleMakeModel,
        serviceType: a.serviceType,
        mechanicId: a.mechanicId,
        mechanicName: a.mechanicName,
        date: a.date,
        time: a.time,
        status: a.status,
        notes: a.notes,
        whatsappSent: a.whatsappSent,
        priceGrandTotal: a.priceGrandTotal,
        payload: a as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ---------- Singletons: business name for this org ----------
  const settingsId = singletonStorageEntityId(orgId);
  const existingSettings = await prisma.appJsonRow.findUnique({
    where: { collection_entityId: { collection: "appSettings", entityId: settingsId } },
  });
  if (!existingSettings) {
    await prisma.appJsonRow.create({
      data: {
        collection: "appSettings",
        entityId: settingsId,
        organizationId: orgId,
        payload: { businessName: org.name, businessPhone: "+917004509790" },
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        organization: `${org.name} (${slug})`,
        branch: branchId,
        staff: staffSeed.length,
        customers: customers.length,
        vehicles: customers.length,
        jobCards: jobCards.length,
        invoices: invoices.length,
        expenses: expenses.length,
        appointments: appointments.length,
        parts: parts.length,
        services: services.length,
        reminders: serviceReminders.length,
        quotations: quotations.length,
        followUps: followUps.length,
      },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

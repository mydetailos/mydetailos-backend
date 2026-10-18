import { PrismaClient, UserRole, AttendanceStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Starting rich demo data seeding for local testing...");

  const orgId = "org-default";
  const branchId = "br-main";

  // 1. Set Customer Portal Passwords & activate all customers
  console.log("\n🔑 1. Updating customer portal passwords...");
  const customerPasswordHash = bcrypt.hashSync("Customer@123", 10);
  const customers = await prisma.customer.findMany({ where: { organizationId: orgId } });
  
  for (const c of customers) {
    await prisma.customer.update({
      where: { id: c.id },
      data: {
        passwordHash: customerPasswordHash,
        mustChangePassword: false,
        emailVerified: true,
        isInactive: false,
      },
    });
    console.log(`   ✓ Customer ${c.name} (${c.phone}): Password set to "Customer@123"`);
  }

  // 2. Relational Inspection Reports
  console.log("\n📋 2. Seeding Vehicle Inspection Reports...");
  const inspReport1Data = {
    customerId: "cust-001",
    customerName: "Test Customer 1",
    customerPhone: "+919876543201",
    customerEmail: "customer1@example.test",
    vehicleId: "veh-001",
    vehicleRegistration: "KA01AB1001",
    vehicleMakeModel: "Maruti Swift",
    vehicleYear: 2023,
    fuelType: "PETROL",
    jobCardId: "jc-002",
    inspectedAt: "2026-10-16T15:00:00.000Z",
    inspectorName: "Ravi Mechanic",
    inspectorRole: "MECHANIC",
    odometer: 34500,
    overallPreDriveCondition: "GOOD",
    notes: "Vehicle in very good initial state. Minor paint scuff on front bumper and small shopping cart dent on left front fender.",
    terms: "All preexisting external dents and scratches marked on intake diagram prior to detailing.",
    sections: [
      {
        id: "sec-ext",
        name: "Exterior Body & Paint",
        checkpoints: [
          { id: "cp-1", name: "Front Bumper & Grille", rating: "AVERAGE", reading: "", remarks: "Minor surface scuff near fog lamp" },
          { id: "cp-2", name: "Bonnet / Hood Paint", rating: "GOOD", reading: "115 µm", remarks: "Optimal paint depth, ready for polish" },
          { id: "cp-3", name: "Windshield Glass", rating: "GOOD", reading: "", remarks: "No cracks, wipers good" },
          { id: "cp-4", name: "Left Fender & Panels", rating: "AVERAGE", reading: "", remarks: "PDR required for dent" },
          { id: "cp-5", name: "Roof & Sunroof", rating: "GOOD", reading: "", remarks: "Clean glass, rubber bead intact" },
          { id: "cp-6", name: "Alloy Wheels & Tyres", rating: "GOOD", reading: "5.2 mm", remarks: "No curb rash" }
        ]
      },
      {
        id: "sec-int",
        name: "Interior & Cabin",
        checkpoints: [
          { id: "cp-7", name: "Seats & Upholstery", rating: "GOOD", reading: "", remarks: "Fabric seats, light stains will be shampooed" },
          { id: "cp-8", name: "Dashboard & Touchscreen", rating: "GOOD", reading: "", remarks: "All electronics working" },
          { id: "cp-9", name: "AC Vents & Airflow", rating: "GOOD", reading: "5.5°C", remarks: "Chilling properly, ozone treatment recommended" }
        ]
      },
      {
        id: "sec-mech",
        name: "Under Hood & Electricals",
        checkpoints: [
          { id: "cp-10", name: "12V Battery Voltage", rating: "GOOD", reading: "12.6 V", remarks: "Battery healthy" },
          { id: "cp-11", name: "Engine Bay Dirt Level", rating: "AVERAGE", reading: "", remarks: "Requires steam wash & dressing" }
        ]
      }
    ],
    photos: [
      {
        id: "photo-1",
        url: "https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&w=800&q=80",
        caption: "Front quarter intake photo"
      },
      {
        id: "photo-2",
        url: "https://images.unsplash.com/photo-1507136566006-cfc505b114fc?auto=format&fit=crop&w=800&q=80",
        caption: "Left fender dent highlight"
      }
    ],
    vehicleConditions: [
      {
        id: "pin-1",
        number: 1,
        type: "SCRATCH",
        x: 24,
        y: 18,
        area: "Front Bumper",
        notes: "Surface scratch — compound polish will remove"
      },
      {
        id: "pin-2",
        number: 2,
        type: "DENT",
        x: 38,
        y: 42,
        area: "Left Fender",
        notes: "Small trolley dent without paint chip"
      }
    ]
  };

  const insp1 = await prisma.inspectionReport.upsert({
    where: {
      organizationId_reportNumber: {
        organizationId: orgId,
        reportNumber: "IR-2026-001",
      },
    },
    create: {
      id: "insp-001",
      organizationId: orgId,
      branchId,
      reportNumber: "IR-2026-001",
      revision: 1,
      status: "FINAL",
      data: inspReport1Data,
      finalizedAt: new Date("2026-10-16T15:30:00.000Z"),
      createdBy: "usr-003",
      updatedBy: "usr-003",
      createdAt: new Date("2026-10-16T15:00:00.000Z"),
      updatedAt: new Date("2026-10-16T15:30:00.000Z"),
    },
    update: {
      status: "FINAL",
      data: inspReport1Data,
      finalizedAt: new Date("2026-10-16T15:30:00.000Z"),
      updatedBy: "usr-003",
    },
  });

  await prisma.inspectionReportVersion.upsert({
    where: {
      reportId_revision: {
        reportId: insp1.id,
        revision: 1,
      },
    },
    create: {
      id: "irv-001",
      reportId: insp1.id,
      revision: 1,
      data: inspReport1Data,
      finalizedBy: "usr-003",
      finalizedAt: new Date("2026-10-16T15:30:00.000Z"),
      createdAt: new Date("2026-10-16T15:30:00.000Z"),
    },
    update: {
      data: inspReport1Data,
    },
  });
  console.log(`   ✓ Created FINAL inspection report: ${insp1.reportNumber} (ID: ${insp1.id})`);

  const inspReport2Data = {
    customerId: "cust-002",
    customerName: "Test Customer 2",
    customerPhone: "+919876543202",
    customerEmail: "customer2@example.test",
    vehicleId: "veh-002",
    vehicleRegistration: "KA01AB1002",
    vehicleMakeModel: "Hyundai i20",
    vehicleYear: 2022,
    fuelType: "DIESEL",
    jobCardId: "jc-001",
    inspectedAt: "2026-10-17T09:00:00.000Z",
    inspectorName: "Sunil Mechanic",
    inspectorRole: "MECHANIC",
    odometer: 48200,
    overallPreDriveCondition: "FAIR",
    notes: "Inspection currently in progress. Paint chip detected on hood edge.",
    terms: "Pre-service physical assessment.",
    sections: [
      {
        id: "sec-ext",
        name: "Exterior Body & Paint",
        checkpoints: [
          { id: "cp-1", name: "Front Bumper", rating: "GOOD", reading: "", remarks: "Clean" },
          { id: "cp-2", name: "Hood / Bonnet", rating: "BAD", reading: "", remarks: "Paint chip with minor rust start" }
        ]
      }
    ],
    photos: [],
    vehicleConditions: [
      {
        id: "pin-3",
        number: 1,
        type: "PAINT_CHIP",
        x: 52,
        y: 22,
        area: "Hood",
        notes: "Stone chip on leading edge"
      }
    ]
  };

  const insp2 = await prisma.inspectionReport.upsert({
    where: {
      organizationId_reportNumber: {
        organizationId: orgId,
        reportNumber: "IR-2026-002",
      },
    },
    create: {
      id: "insp-002",
      organizationId: orgId,
      branchId,
      reportNumber: "IR-2026-002",
      revision: 1,
      status: "DRAFT",
      data: inspReport2Data,
      createdBy: "usr-004",
      updatedBy: "usr-004",
      createdAt: new Date("2026-10-17T09:00:00.000Z"),
      updatedAt: new Date("2026-10-17T09:00:00.000Z"),
    },
    update: {
      status: "DRAFT",
      data: inspReport2Data,
    },
  });
  console.log(`   ✓ Created DRAFT inspection report: ${insp2.reportNumber} (ID: ${insp2.id})`);

  // 3. Pickup & Drop Requests in AppJsonRow
  console.log("\n🚚 3. Seeding Pickup & Drop Requests...");
  const pickupDropRows = [
    {
      id: "PND-2026-0001",
      jobCardId: "jc-001",
      jobNumber: "JC-2026-101",
      branchId,
      customerName: "Test Customer 1",
      customerPhone: "+919876543201",
      vehicleMakeModel: "Maruti Swift",
      vehicleRegNumber: "KA01AB1001",
      odometerReading: 34500,
      address: "Tower 4, Gulshan Vivante, Sector 137, Noida",
      scheduledTime: "2026-10-17T11:00:00.000Z",
      type: "PICKUP",
      status: "PENDING",
      notes: "Customer requested pickup from residence. Keys at security desk.",
      createdAt: "2026-10-17T08:00:00.000Z",
      updatedAt: "2026-10-17T08:00:00.000Z",
    },
    {
      id: "PND-2026-0002",
      jobCardId: "jc-002",
      jobNumber: "JC-2026-102",
      branchId,
      customerName: "Test Customer 2",
      customerPhone: "+919876543202",
      vehicleMakeModel: "Hyundai i20",
      vehicleRegNumber: "KA01AB1002",
      odometerReading: 48200,
      address: "B-14, Kailash Colony, Greater Kailash 1, South Delhi",
      scheduledTime: "2026-10-17T14:30:00.000Z",
      type: "PICKUP",
      status: "DRIVER_ASSIGNED",
      driverId: "usr-003",
      driverName: "Ravi Mechanic",
      notes: "Driver Ravi dispatched with dealer trade plates.",
      createdAt: "2026-10-17T08:30:00.000Z",
      updatedAt: "2026-10-17T09:15:00.000Z",
    },
    {
      id: "PND-2026-0003",
      jobCardId: "jc-003",
      jobNumber: "JC-2026-103",
      branchId,
      customerName: "Test Customer 3",
      customerPhone: "+919876543203",
      vehicleMakeModel: "Honda City",
      vehicleRegNumber: "KA01AB1003",
      odometerReading: 61000,
      address: "Plot 88, Udyog Vihar Phase 4, Gurgaon",
      scheduledTime: "2026-10-17T09:30:00.000Z",
      type: "PICKUP",
      status: "IN_SERVICE",
      driverId: "usr-004",
      driverName: "Sunil Mechanic",
      notes: "Vehicle safely picked up and arrived at workshop bay 2.",
      createdAt: "2026-10-17T07:00:00.000Z",
      updatedAt: "2026-10-17T09:45:00.000Z",
    },
    {
      id: "PND-2026-0004",
      jobCardId: "jc-005",
      jobNumber: "JC-2026-105",
      branchId,
      customerName: "Test Customer 5",
      customerPhone: "+919876543205",
      vehicleMakeModel: "Toyota Innova",
      vehicleRegNumber: "KA01AB1005",
      odometerReading: 82000,
      address: "C-29, Defence Colony, New Delhi",
      scheduledTime: "2026-10-16T17:00:00.000Z",
      type: "DROP",
      status: "DELIVERED",
      driverId: "usr-003",
      driverName: "Ravi Mechanic",
      notes: "Service completed, vehicle delivered back to customer.",
      createdAt: "2026-10-16T14:00:00.000Z",
      updatedAt: "2026-10-16T17:30:00.000Z",
    },
  ];

  for (const row of pickupDropRows) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "pickupDropRequests",
          entityId: row.id,
        },
      },
      create: {
        collection: "pickupDropRequests",
        entityId: row.id,
        organizationId: orgId,
        payload: row,
      },
      update: {
        payload: row,
      },
    });
    console.log(`   ✓ Seeded Pickup/Drop: ${row.id} (${row.type} - ${row.status})`);
  }

  // 4. Counter Sale Invoices in AppJsonRow
  console.log("\n🧾 4. Seeding Counter Sale Invoices...");
  const counterSaleInvoices = [
    {
      id: "inv-cs-001",
      invoiceNumber: "INV-CS-001",
      jobCardId: "",
      jobNumber: "Counter Sale",
      customerId: "cust-001",
      customerName: "Test Customer 1",
      customerPhone: "+919876543201",
      vehicleRegNumber: "—",
      lineItems: [
        {
          id: "li-cs-001-0",
          description: "Microfiber pack (Box of 12)",
          type: "PARTS",
          quantity: 2,
          unitPrice: 175,
          total: 350,
          hsnSac: "6307",
        },
        {
          id: "li-cs-001-1",
          description: "Polish compound (Fast Cut Plus)",
          type: "PARTS",
          quantity: 1,
          unitPrice: 250,
          total: 250,
          hsnSac: "3405",
        },
      ],
      subtotal: 600,
      taxRate: 0.18,
      taxAmount: 108,
      discountAmount: 0,
      rewardDiscount: 0,
      walletAmountUsed: 0,
      grandTotal: 708,
      status: "PAID",
      payments: [
        {
          id: "pay-inv-cs-001",
          invoiceId: "inv-cs-001",
          amount: 708,
          method: "UPI",
          paidAt: "2026-10-16T14:30:00.000Z",
          receivedInAccountName: "Main Current Account",
        },
      ],
      notes: "Direct counter sale — detailing DIY kit.",
      createdAt: "2026-10-16T14:30:00.000Z",
      source: "COUNTER_SALE",
      branchId,
      inventoryDeductedAt: "2026-10-16T14:30:00.000Z",
    },
    {
      id: "inv-cs-002",
      invoiceNumber: "INV-CS-002",
      jobCardId: "",
      jobNumber: "Counter Sale",
      customerId: "cust-002",
      customerName: "Test Customer 2",
      customerPhone: "+919876543202",
      vehicleRegNumber: "—",
      lineItems: [
        {
          id: "li-cs-002-0",
          description: "Cabin Filter OEM Replacement",
          type: "PARTS",
          quantity: 1,
          unitPrice: 225,
          total: 225,
          hsnSac: "8421",
        },
        {
          id: "li-cs-002-1",
          description: "Engine oil 5W30 (Synthetic)",
          type: "PARTS",
          quantity: 2,
          unitPrice: 200,
          total: 400,
          hsnSac: "2710",
        },
      ],
      subtotal: 625,
      taxRate: 0.18,
      taxAmount: 112.5,
      discountAmount: 0,
      rewardDiscount: 0,
      walletAmountUsed: 0,
      grandTotal: 737.5,
      status: "PARTIALLY_PAID",
      payments: [
        {
          id: "pay-inv-cs-002",
          invoiceId: "inv-cs-002",
          amount: 500,
          method: "CASH",
          paidAt: "2026-10-17T10:00:00.000Z",
          receivedInAccountName: "Cash Counter Register",
        },
      ],
      notes: "Walk-in purchase. Balance ₹237.50 to collect.",
      createdAt: "2026-10-17T10:00:00.000Z",
      source: "COUNTER_SALE",
      branchId,
      inventoryDeductedAt: "2026-10-17T10:00:00.000Z",
    },
  ];

  for (const inv of counterSaleInvoices) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "invoices",
          entityId: inv.id,
        },
      },
      create: {
        collection: "invoices",
        entityId: inv.id,
        organizationId: orgId,
        payload: inv,
      },
      update: {
        payload: inv,
      },
    });
    console.log(`   ✓ Seeded Counter Sale Invoice: ${inv.invoiceNumber} (${inv.status})`);
  }

  // 5. Rich Detailing Inventory Items with Low-Stock Alerts
  console.log("\n📦 5. Seeding Detailing Inventory Parts...");
  const additionalParts = [
    {
      id: "part-006",
      sku: "DET-CC-09",
      name: "9H Ceramic Coating (50ml Flacon)",
      category: "Detailing",
      quantity: 2, // Low stock! Reorder level is 5
      supplier: "CarPro International",
      unitPrice: 3200,
      primaryUnit: "Bottle",
      reorderLevel: 5,
      lastRestocked: "2026-10-01",
      secondaryUnit: "PCS",
      conversionFactor: 1,
      stockQuantitySecondary: 2,
    },
    {
      id: "part-007",
      sku: "DET-PPF-01",
      name: "TPU Paint Protection Film (15m Roll)",
      category: "PPF",
      quantity: 1, // Critical stock! Reorder level is 3
      supplier: "Garware Hi-Tech Films",
      unitPrice: 38000,
      primaryUnit: "Roll",
      reorderLevel: 3,
      lastRestocked: "2026-09-20",
      secondaryUnit: "PCS",
      conversionFactor: 1,
      stockQuantitySecondary: 1,
    },
    {
      id: "part-008",
      sku: "DET-SS-02",
      name: "Graphene Spray Sealant (500ml)",
      category: "Detailing",
      quantity: 15,
      supplier: "Adams Polishes",
      unitPrice: 1250,
      primaryUnit: "Bottle",
      reorderLevel: 4,
      lastRestocked: "2026-10-10",
      secondaryUnit: "PCS",
      conversionFactor: 1,
      stockQuantitySecondary: 15,
    },
    {
      id: "part-009",
      sku: "DET-CB-03",
      name: "Medium Grade Clay Bar (100g Bar)",
      category: "Detailing",
      quantity: 8,
      supplier: "Meguiars India",
      unitPrice: 450,
      primaryUnit: "Box",
      reorderLevel: 3,
      lastRestocked: "2026-10-05",
      secondaryUnit: "PCS",
      conversionFactor: 1,
      stockQuantitySecondary: 8,
    },
  ];

  for (const part of additionalParts) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "parts",
          entityId: part.id,
        },
      },
      create: {
        collection: "parts",
        entityId: part.id,
        organizationId: orgId,
        payload: part,
      },
      update: {
        payload: part,
      },
    });
    console.log(`   ✓ Seeded Inventory Part: ${part.name} (Stock: ${part.quantity}, Reorder: ${part.reorderLevel})`);
  }

  // 6. Mirror & Update Appointments into Relational Table
  console.log("\n📅 6. Syncing Appointments to Relational Table...");
  const appointmentRows = await prisma.appJsonRow.findMany({
    where: { collection: "appointments" },
  });

  for (const row of appointmentRows) {
    const apt = row.payload as any;
    await prisma.appointment.upsert({
      where: { id: apt.id },
      create: {
        id: apt.id,
        organizationId: orgId,
        bookingId: apt.bookingId ?? null,
        branchId,
        customerId: apt.customerId ?? null,
        customerName: apt.customerName ?? null,
        customerPhone: apt.customerPhone ?? null,
        vehicleId: apt.vehicleId ?? null,
        vehicleRegNumber: apt.vehicleRegNumber ?? null,
        vehicleMakeModel: apt.vehicleMakeModel ?? null,
        serviceType: apt.serviceType ?? null,
        mechanicId: apt.mechanicId ?? null,
        mechanicName: apt.mechanicName ?? null,
        date: apt.date ?? null,
        time: apt.time ?? null,
        status: apt.status ?? null,
        notes: apt.notes ?? null,
        whatsappSent: apt.whatsappSent ?? false,
        priceGrandTotal: apt.priceGrandTotal ? Number(apt.priceGrandTotal) : null,
        advancePaid: apt.advancePaid ? Number(apt.advancePaid) : null,
        customerAddress: apt.customerAddress ?? null,
        vehiclePickupRequired: apt.vehiclePickupRequired ?? false,
        vehiclePickupStatus: apt.vehiclePickupStatus ?? null,
        payload: apt,
      },
      update: {
        status: apt.status ?? null,
        date: apt.date ?? null,
        payload: apt,
      },
    });
  }

  // Add 2 current appointments for this week (October 2026)
  const currentAppts = [
    {
      id: "apt-current-001",
      date: "2026-10-17",
      time: "11:30",
      notes: "Full Ceramic Maintenance & Exterior Decontamination",
      status: "CONFIRMED",
      bookingId: "bk-2026-101",
      createdAt: "2026-10-16T08:00:00.000Z",
      vehicleId: "veh-001",
      customerId: "cust-001",
      mechanicId: "usr-003",
      serviceType: "Ceramic Coating Maintenance",
      customerName: "Test Customer 1",
      mechanicName: "Ravi Mechanic",
      whatsappSent: true,
      customerPhone: "+919876543201",
      priceGstAmount: 900,
      priceGrandTotal: 5900,
      vehicleMakeModel: "Maruti Swift",
      vehicleRegNumber: "KA01AB1001",
      customerFirstName: "Test",
      priceSubtotalExGst: 5000,
    },
    {
      id: "apt-current-002",
      date: "2026-10-18",
      time: "14:00",
      notes: "Interior Deep Spa & Leather Protection",
      status: "SCHEDULED",
      bookingId: "bk-2026-102",
      createdAt: "2026-10-16T11:00:00.000Z",
      vehicleId: "veh-003",
      customerId: "cust-003",
      mechanicId: "usr-004",
      serviceType: "Interior Deep Spa",
      customerName: "Test Customer 3",
      mechanicName: "Sunil Mechanic",
      whatsappSent: true,
      customerPhone: "+919876543203",
      priceGstAmount: 720,
      priceGrandTotal: 4720,
      vehicleMakeModel: "Honda City",
      vehicleRegNumber: "KA01AB1003",
      customerFirstName: "Test",
      priceSubtotalExGst: 4000,
    },
  ];

  for (const apt of currentAppts) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "appointments",
          entityId: apt.id,
        },
      },
      create: {
        collection: "appointments",
        entityId: apt.id,
        organizationId: orgId,
        payload: apt,
      },
      update: { payload: apt },
    });

    await prisma.appointment.upsert({
      where: { id: apt.id },
      create: {
        id: apt.id,
        organizationId: orgId,
        bookingId: apt.bookingId,
        branchId,
        customerId: apt.customerId,
        customerName: apt.customerName,
        customerPhone: apt.customerPhone,
        vehicleId: apt.vehicleId,
        vehicleRegNumber: apt.vehicleRegNumber,
        vehicleMakeModel: apt.vehicleMakeModel,
        serviceType: apt.serviceType,
        mechanicId: apt.mechanicId,
        mechanicName: apt.mechanicName,
        date: apt.date,
        time: apt.time,
        status: apt.status,
        notes: apt.notes,
        whatsappSent: apt.whatsappSent,
        priceGrandTotal: apt.priceGrandTotal,
        payload: apt,
      },
      update: {
        status: apt.status,
        date: apt.date,
        payload: apt,
      },
    });
    console.log(`   ✓ Seeded Current Week Appointment: ${apt.id} on ${apt.date} (${apt.status})`);
  }

  // 7. Staff Attendance Punches for the Week
  console.log("\n⏱️ 7. Seeding Staff Attendance Records...");
  const attendanceRecords = [
    {
      staffId: "usr-003",
      staffName: "Ravi Mechanic",
      staffRole: UserRole.MECHANIC,
      date: "2026-10-17",
      checkIn: "09:02",
      checkOut: null,
      durationMinutes: null,
      status: AttendanceStatus.PRESENT,
      qrScanned: true,
    },
    {
      staffId: "usr-004",
      staffName: "Sunil Mechanic",
      staffRole: UserRole.MECHANIC,
      date: "2026-10-17",
      checkIn: "09:35",
      checkOut: null,
      durationMinutes: null,
      status: AttendanceStatus.LATE,
      qrScanned: true,
    },
    {
      staffId: "usr-005",
      staffName: "Neha Reception",
      staffRole: UserRole.RECEPTIONIST,
      date: "2026-10-17",
      checkIn: "08:55",
      checkOut: null,
      durationMinutes: null,
      status: AttendanceStatus.PRESENT,
      qrScanned: true,
    },
    {
      staffId: "usr-002",
      staffName: "Priya Sharma",
      staffRole: UserRole.BRANCH_MANAGER,
      date: "2026-10-17",
      checkIn: "08:45",
      checkOut: null,
      durationMinutes: null,
      status: AttendanceStatus.PRESENT,
      qrScanned: true,
    },
    // Yesterday's complete shifts
    {
      staffId: "usr-003",
      staffName: "Ravi Mechanic",
      staffRole: UserRole.MECHANIC,
      date: "2026-10-16",
      checkIn: "09:00",
      checkOut: "18:15",
      durationMinutes: 555,
      status: AttendanceStatus.PRESENT,
      qrScanned: true,
    },
    {
      staffId: "usr-004",
      staffName: "Sunil Mechanic",
      staffRole: UserRole.MECHANIC,
      date: "2026-10-16",
      checkIn: "09:05",
      checkOut: "18:00",
      durationMinutes: 535,
      status: AttendanceStatus.PRESENT,
      qrScanned: true,
    },
    {
      staffId: "usr-005",
      staffName: "Neha Reception",
      staffRole: UserRole.RECEPTIONIST,
      date: "2026-10-16",
      checkIn: "08:58",
      checkOut: "18:05",
      durationMinutes: 547,
      status: AttendanceStatus.PRESENT,
      qrScanned: true,
    },
  ];

  await prisma.attendance.deleteMany({
    where: { branchId, date: { in: ["2026-10-16", "2026-10-17"] } },
  });

  for (const att of attendanceRecords) {
    await prisma.attendance.create({
      data: {
        staffId: att.staffId,
        staffName: att.staffName,
        staffRole: att.staffRole,
        branchId,
        date: att.date,
        checkIn: att.checkIn,
        checkOut: att.checkOut,
        durationMinutes: att.durationMinutes,
        status: att.status,
        qrScanned: att.qrScanned,
      },
    });
  }
  console.log(`   ✓ Seeded ${attendanceRecords.length} staff attendance shifts for 16-17 Oct 2026`);

  // 8. Leave Management: Config & Requests
  console.log("\n🏖️ 8. Seeding Leave Config & Requests...");
  const leaveConfigPayload = {
    leaveTypes: [
      { id: "lt-casual", name: "Casual Leave", paid: true, tracksBalance: true, defaultDaysPerYear: 12, isActive: true },
      { id: "lt-sick", name: "Sick Leave", paid: true, tracksBalance: true, defaultDaysPerYear: 6, isActive: true },
      { id: "lt-unpaid", name: "Unpaid Leave", paid: false, tracksBalance: false, defaultDaysPerYear: 0, isActive: true },
    ],
    balances: [
      { staffId: "usr-003", leaveTypeId: "lt-casual", year: 2026, entitled: 12, used: 2, pending: 1 },
      { staffId: "usr-003", leaveTypeId: "lt-sick", year: 2026, entitled: 6, used: 0, pending: 0 },
      { staffId: "usr-004", leaveTypeId: "lt-casual", year: 2026, entitled: 12, used: 4, pending: 0 },
      { staffId: "usr-005", leaveTypeId: "lt-casual", year: 2026, entitled: 12, used: 1, pending: 0 },
    ],
  };

  await prisma.appJsonRow.upsert({
    where: {
      collection_entityId: {
        collection: "leaveConfig",
        entityId: "default",
      },
    },
    create: {
      collection: "leaveConfig",
      entityId: "default",
      organizationId: orgId,
      payload: leaveConfigPayload,
    },
    update: { payload: leaveConfigPayload },
  });

  const leaveRequests = [
    {
      id: "lv-001",
      staffId: "usr-003",
      staffName: "Ravi Mechanic",
      leaveTypeId: "lt-casual",
      leaveTypeName: "Casual Leave",
      branchId,
      organizationId: orgId,
      fromDate: "2026-10-24",
      toDate: "2026-10-25",
      days: 2,
      reason: "Family function in hometown",
      status: "PENDING",
      appliedAt: "2026-10-16T10:00:00.000Z",
    },
    {
      id: "lv-002",
      staffId: "usr-004",
      staffName: "Sunil Mechanic",
      leaveTypeId: "lt-casual",
      leaveTypeName: "Casual Leave",
      branchId,
      organizationId: orgId,
      fromDate: "2026-10-10",
      toDate: "2026-10-11",
      days: 2,
      reason: "Medical checkup",
      status: "APPROVED",
      appliedAt: "2026-10-05T09:00:00.000Z",
      decidedById: "usr-002",
      decidedByName: "Priya Sharma",
      decidedAt: "2026-10-06T11:00:00.000Z",
      comments: "Approved. Work covered by Ravi.",
    },
  ];

  for (const lv of leaveRequests) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "leaveRequests",
          entityId: lv.id,
        },
      },
      create: {
        collection: "leaveRequests",
        entityId: lv.id,
        organizationId: orgId,
        payload: lv,
      },
      update: { payload: lv },
    });
    console.log(`   ✓ Seeded Leave Request: ${lv.id} (${lv.staffName} - ${lv.status})`);
  }

  // 9. Marketing Offers
  console.log("\n🎁 9. Seeding Promotional Offers...");
  const offers = [
    {
      id: "off-001",
      name: "Diwali Ceramic Fest 20% OFF",
      code: "FESTIVE20",
      validTill: "2026-11-15",
      discountType: "PERCENT",
      discountValue: 20,
      minBillAmount: 5000,
      maxDiscount: 3000,
      applicableOn: "SERVICES",
      details: "Get 20% off on complete multi-stage paint correction and ceramic packages.",
      customMessage: "Hi {{name}}! Sparkle this festive season with 20% OFF on Ceramic Coating at My Detail OS. Use code FESTIVE20.",
      selectedCustomerIds: [],
      status: "SENT",
      sentCount: 25,
      createdAt: "2026-10-10T08:00:00.000Z",
      updatedAt: "2026-10-10T08:00:00.000Z",
    },
    {
      id: "off-002",
      name: "Interior Deep Spa Special ₹500 OFF",
      code: "CLEAN500",
      validTill: "2026-11-30",
      discountType: "FLAT",
      discountValue: 500,
      minBillAmount: 2500,
      maxDiscount: 500,
      applicableOn: "SERVICES",
      details: "Flat ₹500 discount on complete interior steam cleaning and ozone sanitization.",
      customMessage: "Hi {{name}}! Refresh your cabin interior with ₹500 OFF on our Deep Spa package. Reply BOOK to claim.",
      selectedCustomerIds: [],
      status: "DRAFT",
      sentCount: 0,
      createdAt: "2026-10-15T10:00:00.000Z",
      updatedAt: "2026-10-15T10:00:00.000Z",
    },
  ];

  for (const off of offers) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "offers",
          entityId: off.id,
        },
      },
      create: {
        collection: "offers",
        entityId: off.id,
        organizationId: orgId,
        payload: off,
      },
      update: { payload: off },
    });
    console.log(`   ✓ Seeded Offer: ${off.name} [${off.code}] (${off.status})`);
  }

  // 10. Support Tickets
  console.log("\n🎫 10. Seeding Support Tickets...");
  const supportTickets = [
    {
      id: "tkt-001",
      ticketNumber: "TKT-1001",
      category: "FEATURE",
      priority: "MEDIUM",
      status: "OPEN",
      subject: "Request for multi-bay camera streaming integration",
      description: "Customer wants live video feed of car detailing bay accessible via portal.",
      customerId: "cust-001",
      customerName: "Test Customer 1",
      customerPhone: "+919876543201",
      branchId,
      assignedTo: "usr-002",
      assignedToName: "Priya Sharma",
      attachments: [],
      messages: [
        {
          id: "msg-001",
          author: "WORKSHOP",
          authorName: "Priya Sharma",
          body: "Customer requested if they can view real-time bay cameras while their ceramic coating is being cured.",
          createdAt: "2026-10-16T12:00:00.000Z",
        },
        {
          id: "msg-002",
          author: "SUPPORT",
          authorName: "MY DETAIL OS Support",
          body: "Hello Priya! We are evaluating RTSP/HLS live video stream embedding for customer portals in Q4 roadmap.",
          createdAt: "2026-10-16T12:30:00.000Z",
        },
      ],
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:30:00.000Z",
    },
    {
      id: "tkt-002",
      ticketNumber: "TKT-1002",
      category: "BUG",
      priority: "LOW",
      status: "RESOLVED",
      subject: "Invoice PDF download formatting query",
      description: "Inquired about HSN code breakdown on final tax invoice summary.",
      customerId: "cust-002",
      customerName: "Test Customer 2",
      customerPhone: "+919876543202",
      branchId,
      assignedTo: "usr-005",
      assignedToName: "Neha Reception",
      attachments: [],
      messages: [
        {
          id: "msg-003",
          author: "WORKSHOP",
          authorName: "Neha Reception",
          body: "Where do we configure the SAC code 9987 for detailing labor invoices?",
          createdAt: "2026-10-12T09:00:00.000Z",
        },
        {
          id: "msg-004",
          author: "SUPPORT",
          authorName: "MY DETAIL OS Support",
          body: "You can set SAC/HSN codes under Settings -> GST & Invoicing or per service in Services Catalog.",
          createdAt: "2026-10-12T09:45:00.000Z",
        },
      ],
      resolution: "Explained that HSN/SAC 9987 is applied to auto maintenance services.",
      createdAt: "2026-10-12T09:00:00.000Z",
      updatedAt: "2026-10-12T14:30:00.000Z",
    },
  ];

  for (const tkt of supportTickets) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "supportTickets",
          entityId: tkt.id,
        },
      },
      create: {
        collection: "supportTickets",
        entityId: tkt.id,
        organizationId: orgId,
        payload: tkt,
      },
      update: { payload: tkt },
    });
    console.log(`   ✓ Seeded Support Ticket: ${tkt.ticketNumber} (${tkt.status})`);
  }

  // 11. Reminders due in October 2026
  console.log("\n🔔 11. Seeding Current Due Reminders...");
  const currentReminders = [
    {
      id: "rem-curr-001",
      type: "CERAMIC_RELOAD",
      notes: "6-Month Ceramic Hydrophobic Top-Up due",
      status: "DUE",
      dueDate: "2026-10-18",
      frequency: "BIANNUAL",
      vehicleId: "veh-001",
      customerId: "cust-001",
      customerName: "Test Customer 1",
      customerPhone: "+919876543201",
      lastJobCardId: "jc-002",
      lastServiceDate: "2026-04-18",
      isHighEndService: true,
      vehicleMakeModel: "Maruti Swift",
      vehicleRegNumber: "KA01AB1001",
    },
    {
      id: "rem-curr-002",
      type: "PPF_INSPECTION",
      notes: "Annual PPF Edge Seal & Hydrophobic Check",
      status: "OVERDUE",
      dueDate: "2026-10-10",
      frequency: "YEARLY",
      vehicleId: "veh-005",
      customerId: "cust-005",
      customerName: "Test Customer 5",
      customerPhone: "+919876543205",
      lastJobCardId: "jc-005",
      lastServiceDate: "2025-10-10",
      isHighEndService: true,
      vehicleMakeModel: "Toyota Innova",
      vehicleRegNumber: "KA01AB1005",
    },
  ];

  for (const rem of currentReminders) {
    await prisma.appJsonRow.upsert({
      where: {
        collection_entityId: {
          collection: "serviceReminders",
          entityId: rem.id,
        },
      },
      create: {
        collection: "serviceReminders",
        entityId: rem.id,
        organizationId: orgId,
        payload: rem,
      },
      update: { payload: rem },
    });
    console.log(`   ✓ Seeded Active Reminder: ${rem.id} (${rem.type} - ${rem.status})`);
  }

  console.log("\n🎉 ALL RICH DEMO DATA SEEDED SUCCESSFULLY! Local DB is 100% test-ready.");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

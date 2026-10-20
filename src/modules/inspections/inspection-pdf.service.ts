import PDFDocument from "pdfkit";
import sharp from "sharp";

export type InspectionPdfPhoto = {
  id: string;
  buffer: Buffer;
  mimeType: string;
  caption?: string;
};

function text(value: unknown, fallback = ""): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function safeBrandColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#167C80";
}

function checkpointLabel(value: unknown): string {
  if (!value || typeof value !== "object") return text(value, "Checkpoint");
  const checkpoint = value as Record<string, unknown>;
  return text(checkpoint.name ?? checkpoint.label ?? checkpoint.title ?? checkpoint.id, "Checkpoint");
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const vehicleConditionColors: Record<string, { pin: string; ink: string; fill: string; border: string }> = {
  SCRATCH: { pin: "#f59e0b", ink: "#a64b00", fill: "#fff7e8", border: "#fbbf24" },
  DENT: { pin: "#f43f5e", ink: "#be123c", fill: "#fff1f2", border: "#fb7185" },
  CRACK: { pin: "#a855f7", ink: "#7e22ce", fill: "#faf5ff", border: "#c084fc" },
  PAINT_CHIP: { pin: "#3b82f6", ink: "#1d4ed8", fill: "#eff6ff", border: "#60a5fa" },
  OTHER: { pin: "#64748b", ink: "#475569", fill: "#f8fafc", border: "#94a3b8" },
};

const vehicleConditionLabels: Record<string, string> = {
  SCRATCH: "Scratch",
  DENT: "Dent",
  CRACK: "Crack",
  PAINT_CHIP: "Paint Chip",
  OTHER: "Other",
};

const vehicleConditionBodyPath =
  "M244 69 Q260 52 300 50 Q340 52 356 69 L375 98 Q386 118 390 150 L397 240 Q398 298 376 328 L356 348 Q340 360 300 361 Q260 360 244 348 L224 328 Q202 298 203 240 L210 150 Q214 118 225 98 Z";

const vehicleConditionRegions: Array<{ location: string; points: [number, number][] }> = [
  { location: "FRONT_BUMPER", points: [[248, 52], [300, 50], [352, 52], [368, 78], [356, 96], [244, 96], [232, 78]] },
  { location: "HOOD", points: [[246, 98], [300, 82], [354, 98], [352, 138], [248, 138]] },
  { location: "LEFT_FENDER", points: [[214, 100], [246, 98], [248, 148], [238, 168], [214, 160], [208, 128]] },
  { location: "RIGHT_FENDER", points: [[386, 100], [354, 98], [352, 148], [362, 168], [386, 160], [392, 128]] },
  { location: "WINDSHIELD", points: [[246, 142], [300, 132], [354, 142], [360, 176], [240, 176]] },
  { location: "DRIVER_GATE", points: [[208, 168], [240, 168], [244, 236], [220, 242], [206, 228]] },
  { location: "PASSENGER_GATE", points: [[392, 168], [360, 168], [356, 236], [380, 242], [394, 228]] },
  { location: "SUNROOF", points: [[256, 184], [344, 184], [342, 246], [258, 246]] },
  { location: "LEFT_REAR_PASSENGER_GATE", points: [[206, 236], [244, 236], [242, 292], [222, 300], [205, 278]] },
  { location: "RIGHT_REAR_PASSENGER_GATE", points: [[394, 236], [356, 236], [358, 292], [378, 300], [395, 278]] },
  { location: "WINDOWS", points: [[244, 252], [356, 252], [360, 294], [240, 294]] },
  { location: "LEFT_QUARTER_PANEL", points: [[205, 286], [240, 292], [238, 330], [224, 342], [210, 318]] },
  { location: "RIGHT_QUARTER_PANEL", points: [[395, 286], [360, 292], [362, 330], [376, 342], [390, 318]] },
  { location: "TRUNK", points: [[246, 298], [354, 298], [348, 336], [252, 336]] },
  { location: "REAR_BUMPER", points: [[248, 338], [352, 338], [372, 328], [356, 352], [300, 361], [244, 352], [228, 328]] },
];

function buildVehicleConditionBlueprintMarkup(): string {
  const panels = vehicleConditionRegions.map((region) => {
    const glass = ["WINDSHIELD", "SUNROOF", "WINDOWS"].includes(region.location);
    const fill = glass ? "#0c1a2c" : region.location.includes("BUMPER") ? "#162438" : "#132033";
    const stroke = glass ? "#3d8fb8" : "#2f6f8f";
    const pointsAttr = region.points.map((pt) => pt.join(",")).join(" ");
    return `<polygon points="${pointsAttr}" fill="${fill}" stroke="${stroke}" stroke-width="${glass ? 1.6 : 1.15}" stroke-linejoin="round"/>`;
  }).join("");

  return `
    <defs>
      <pattern id="vehicle-condition-pdf-grid" width="28" height="28" patternUnits="userSpaceOnUse">
        <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#27344a" stroke-width="1"/>
      </pattern>
      <clipPath id="vehicle-condition-pdf-body-clip"><path d="${vehicleConditionBodyPath}"/></clipPath>
    </defs>
    <rect width="600" height="405" fill="#101a2e"/>
    <rect width="600" height="405" fill="url(#vehicle-condition-pdf-grid)"/>
    <g fill="#8da0b8" font-family="Arial, sans-serif" font-size="12" text-anchor="middle">
      <text x="300" y="30">▲ Front (Hood)</text>
      <text x="300" y="384">▼ Rear (Trunk)</text>
      <text x="86" y="214">◀ Left</text>
      <text x="514" y="214">Right ▶</text>
    </g>
    <g clip-path="url(#vehicle-condition-pdf-body-clip)" stroke-linejoin="round">${panels}</g>
    <path d="${vehicleConditionBodyPath}" fill="none" stroke="#22b9ee" stroke-width="2.8" stroke-linejoin="round"/>
    <g fill="#1c334c" stroke="#22b9ee" stroke-width="1.4" stroke-linejoin="round">
      <path d="M214 148 L198 160 L202 174 L218 166 Z"/>
      <path d="M386 148 L402 160 L398 174 L382 166 Z"/>
    </g>
    <g fill="none" stroke="#f5d76e" stroke-width="2.4" stroke-linecap="round">
      <path d="M252 64 L272 56 M328 56 L348 64"/>
    </g>
    <g fill="none" stroke="#f04452" stroke-width="2.4" stroke-linecap="round">
      <path d="M252 344 L270 352 M330 352 L348 344"/>
    </g>
  `;
}

function buildVehicleConditionSvg(report: Record<string, unknown>): { markup: string; width: number; height: number } {
  const conditions = Array.isArray(report.vehicleConditions)
    ? (report.vehicleConditions as Array<Record<string, unknown>>)
    : [];
  const width = 1200;
  const overallTop = 82;
  const overallHeight = 72;
  const legendTop = overallTop + overallHeight + 14;
  const legendHeight = 56;
  const mainTop = legendTop + legendHeight + 16;
  const sideY = mainTop;
  const listHeaderHeight = 52;
  const listPadX = 18;
  const listContentLeft = 800 + listPadX;
  const numberCx = listContentLeft + 14;
  const contentX = numberCx + 28;
  let rowTop = sideY + listHeaderHeight;

  const chipWidths: Record<string, number> = { "Paint Chip": 96, Scratch: 74, Dent: 62, Crack: 62, Other: 62 };
  const rows = conditions.map((condition, index) => {
    const typeKey = String(condition.type ?? "OTHER").toUpperCase();
    const colors = vehicleConditionColors[typeKey] ?? vehicleConditionColors.OTHER;
    const label = vehicleConditionLabels[typeKey] ?? "Other";
    const area = escapeSvg(text(condition.area, "Vehicle Body"));
    const notes = text(condition.notes);
    const chipWidth = chipWidths[label] ?? 65;
    const rowHeight = notes ? 86 : 70;
    const y = rowTop;
    const chipY = y + 12;
    const areaY = chipY + 40;
    const notesY = areaY + 18;
    const centerY = notes ? y + rowHeight / 2 - 4 : y + 35;
    rowTop += rowHeight;
    return `<g>
      ${index ? `<path d="M ${800 + 12} ${y} H ${1180 - 12}" stroke="#e5e7eb" stroke-width="1.5"/>` : ""}
      <circle cx="${numberCx}" cy="${centerY}" r="13" fill="${colors.pin}"/>
      <text x="${numberCx}" y="${centerY + 5}" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#ffffff">${condition.number ?? index + 1}</text>
      <rect x="${contentX}" y="${chipY}" width="${chipWidth}" height="24" rx="12" fill="${colors.fill}" stroke="${colors.border}" stroke-width="1.5"/>
      <text x="${contentX + chipWidth / 2}" y="${chipY + 16}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="600" fill="${colors.ink}">${label}</text>
      <text x="${contentX}" y="${areaY}" font-family="Arial,sans-serif" font-size="15" font-weight="600" fill="#111827">${area}</text>
      ${notes ? `<text x="${contentX}" y="${notesY}" font-family="Arial,sans-serif" font-size="12" fill="#64748b">${escapeSvg(notes)}</text>` : ""}
    </g>`;
  });

  const mainHeight = Math.max(430, rowTop - sideY + 16);
  const height = mainTop + mainHeight + 20;
  const overallRaw = text(report.overallPreDriveCondition).toUpperCase();
  const overall = overallRaw === "GOOD" ? "Good" : overallRaw === "FAIR" ? "Fair" : overallRaw === "POOR" ? "Poor" : "Not recorded";
  const overallColor = overall === "Good" ? "#059669" : overall === "Fair" ? "#d97706" : overall === "Poor" ? "#dc2626" : "#64748b";
  const chipY = legendTop + 10;
  const typeLegend = Object.keys(vehicleConditionLabels).map((type, index) => {
    const label = vehicleConditionLabels[type];
    const x = 208 + index * 160;
    const colors = vehicleConditionColors[type];
    return `<rect x="${x}" y="${chipY}" width="145" height="36" rx="9" fill="${colors.fill}" stroke="${colors.border}" stroke-width="2"/><circle cx="${x + 17}" cy="${chipY + 18}" r="7" fill="${colors.pin}"/><text x="${x + 32}" y="${chipY + 23}" font-family="Arial,sans-serif" font-size="15" font-weight="600" fill="${colors.ink}">${label}</text>`;
  }).join("");

  const panelX = 20;
  const panelW = 760;
  const blueprintScale = Math.min(panelW / 600, mainHeight / 405);
  const blueprintW = 600 * blueprintScale;
  const blueprintH = 405 * blueprintScale;
  const blueprintX = panelX + (panelW - blueprintW) / 2;
  const blueprintY = mainTop + (mainHeight - blueprintH) / 2;
  const pinRadius = Math.max(14, 16 * blueprintScale);
  const pinSvg = conditions.map((condition, index) => {
    const xVal = typeof condition.x === "number" ? condition.x : 50;
    const yVal = typeof condition.y === "number" ? condition.y : 50;
    const cx = blueprintX + blueprintW * (xVal / 100);
    const cy = blueprintY + blueprintH * (yVal / 100);
    const typeKey = String(condition.type ?? "OTHER").toUpperCase();
    const colors = vehicleConditionColors[typeKey] ?? vehicleConditionColors.OTHER;
    return `<g>
      <circle cx="${cx}" cy="${cy}" r="${pinRadius + 2}" fill="#ffffff"/>
      <circle cx="${cx}" cy="${cy}" r="${pinRadius}" fill="${colors.pin}"/>
      <text x="${cx}" y="${cy + pinRadius * 0.38}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${Math.max(11, 13 * blueprintScale)}" font-weight="700" fill="#ffffff">${condition.number ?? index + 1}</text>
    </g>`;
  }).join("");

  const emptyList = !conditions.length
    ? `<text x="980" y="${sideY + 118}" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="#64748b">No exterior damages noted</text>`
    : "";

  return {
    width,
    height,
    markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <clipPath id="noted-panel"><rect x="800" y="${sideY}" width="380" height="${mainHeight}" rx="12"/></clipPath>
      </defs>
      <rect width="${width}" height="${height}" fill="#ffffff"/>
      <rect x="0" y="0" width="${width}" height="3" fill="#e8d7c0"/>
      <text x="24" y="38" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#172033">Vehicle Condition (${conditions.length})</text>
      <text x="24" y="65" font-family="Arial,sans-serif" font-size="16" fill="#64748b">Visible exterior damage inspection recorded before service</text>
      <rect x="20" y="${overallTop}" width="1160" height="${overallHeight}" rx="12" fill="#fbf9f6" stroke="#eadcc9" stroke-width="2"/>
      <text x="42" y="${overallTop + 30}" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="#172033">Overall Pre-Drive Condition</text>
      <text x="42" y="${overallTop + 54}" font-family="Arial,sans-serif" font-size="16" fill="#64748b">General visual condition of the vehicle exterior</text>
      <rect x="1045" y="${overallTop + 17}" width="108" height="38" rx="10" fill="${overallColor}"/>
      <text x="1099" y="${overallTop + 42}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="#ffffff">${overall}</text>
      <rect x="20" y="${legendTop}" width="1160" height="${legendHeight}" rx="12" fill="#f8f6f2" stroke="#eadcc9" stroke-width="2"/>
      <text x="42" y="${legendTop + 34}" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="#172033">Damage types</text>
      ${typeLegend}
      <rect x="${panelX}" y="${mainTop}" width="${panelW}" height="${mainHeight}" rx="18" fill="#101a2e" stroke="#26354d" stroke-width="2"/>
      <g transform="translate(${blueprintX} ${blueprintY}) scale(${blueprintScale})">
        ${buildVehicleConditionBlueprintMarkup()}
      </g>
      ${pinSvg}
      <g clip-path="url(#noted-panel)">
        <rect x="800" y="${sideY}" width="380" height="${mainHeight}" fill="#ffffff"/>
        <rect x="800" y="${sideY}" width="380" height="${listHeaderHeight}" fill="#f8fafc"/>
        <path d="M800 ${sideY + listHeaderHeight} H1180" stroke="#e5e7eb" stroke-width="1.5"/>
        <circle cx="${numberCx}" cy="${sideY + listHeaderHeight / 2}" r="10" fill="#f59e0b"/>
        <text x="${numberCx}" y="${sideY + listHeaderHeight / 2 + 5}" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#ffffff">!</text>
        <text x="${contentX}" y="${sideY + listHeaderHeight / 2 + 6}" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="#172033">Noted conditions (${conditions.length})</text>
        ${rows.join("")}${emptyList}
      </g>
      <rect x="800" y="${sideY}" width="380" height="${mainHeight}" rx="12" fill="none" stroke="#e5e7eb" stroke-width="2"/>
    </svg>`,
  };
}

export async function renderInspectionPdf(
  report: Record<string, unknown>,
  photos: InspectionPdfPhoto[]
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 36,
    bufferPages: true,
    info: { Title: `Vehicle inspection ${text(report.reportNumber, "Report")}` },
  });

  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const branding = report.organizationBranding && typeof report.organizationBranding === "object"
    ? (report.organizationBranding as Record<string, unknown>)
    : {};

  const primary = safeBrandColor(branding.brandPrimary);
  const businessName = text(branding.businessName, "Vehicle Inspection").toUpperCase();
  const businessTagline = text(branding.businessTagline, "Professional Vehicle Diagnostic & Condition Report");
  const businessAddress = text(branding.businessAddress);
  const businessPhone = text(branding.businessPhone, text(branding.businessWhatsApp));
  const reportNumber = text(report.reportNumber, "DRAFT");
  const revision = Number(report.revision) > 0 ? String(report.revision) : "1";
  const inspectionDate = text(report.inspectionDate ?? report.inspectedAt ?? report.date ?? report.createdAt, "N/A");
  const branchName = text(report.branchName, "Main Branch");

  const customerName = text(report.customerName, "Valued Customer");
  const customerPhone = text(report.customerPhone);
  const customerEmail = text(report.customerEmail);
  const vehicleReg = text(report.vehicleRegistration ?? report.registrationNumber, "N/A").toUpperCase();
  const vehicleMakeModel = text(
    report.vehicleMakeModel ?? [report.vehicleMake, report.vehicleModel].filter(Boolean).join(" "),
    "Vehicle"
  );
  const vehicleYear = text(report.vehicleYear);
  const fuelType = text(report.fuelType, "N/A");
  const odometerRaw = report.odometerReading ?? report.odometer;
  const odometerText = typeof odometerRaw === "number" ? `${odometerRaw.toLocaleString()} km` : text(odometerRaw, "N/A");
  const insuranceDueDate = text(report.insuranceDueDate, "N/A");
  const inspectorName = text(report.inspectorName ?? report.inspector, "Technician");
  const overallRating = text(report.computedOverallRating ?? report.overallRating, "GOOD").toUpperCase();
  const overrideReason = text(report.overrideReason);

  const pageWidth = doc.page.width;
  const margin = 36;
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = doc.page.height - 48;
  let y = 48;

  const ensureSpace = (heightNeeded: number): void => {
    if (y + heightNeeded > bottomLimit) {
      doc.addPage({ size: "A4", margin: 36 });
      y = 38;
    }
  };

  const ratingThemes: Record<string, { ink: string; fill: string; border: string }> = {
    GOOD: { ink: "#13854f", fill: "#e2f6eb", border: "#86efac" },
    AVERAGE: { ink: "#a4680f", fill: "#fff4d8", border: "#fde047" },
    BAD: { ink: "#b93030", fill: "#ffe8e5", border: "#fca5a5" },
    NA: { ink: "#5b6977", fill: "#ebeff2", border: "#cbd5e1" },
    NOT_CHECKED: { ink: "#5b6977", fill: "#ebeff2", border: "#cbd5e1" },
  };

  const drawPill = (label: string, ratingKey: string, pillX: number, pillY: number, pillW: number, pillH = 13): void => {
    const key = ratingKey.toUpperCase().replace(/\s+/g, "_");
    const theme = ratingThemes[key] ?? ratingThemes.NA;
    doc.roundedRect(pillX, pillY, pillW, pillH, 2.5).fill(theme.fill);
    doc.roundedRect(pillX, pillY, pillW, pillH, 2.5).lineWidth(0.5).stroke(theme.border);
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor(theme.ink).text(
      label.toUpperCase(),
      pillX,
      pillY + (pillH - 7) / 2,
      { width: pillW, align: "center", lineBreak: false }
    );
  };

  const drawSectionHeading = (title: string): void => {
    ensureSpace(24);
    doc.roundedRect(margin, y, contentWidth, 14, 2).fill("#f8fafc");
    doc.roundedRect(margin, y, 2.5, 14, 1).fill("#be4126");
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#1f2f3e").text(title.toUpperCase(), margin + 8, y + 3.5, { lineBreak: false });
    y += 18;
  };

  // 1. PAGE 1 HEADER
  doc.rect(0, 0, pageWidth, 4).fill(primary);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(primary).text(businessName, margin, 14, { lineBreak: false });
  doc.font("Helvetica").fontSize(7.5).fillColor("#64748b").text(businessTagline, margin, 28, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#1f2f3e").text("VEHICLE INSPECTION REPORT", margin, 14, { width: contentWidth, align: "right" });
  doc.font("Helvetica").fontSize(7).fillColor("#64748b").text(`REPORT ID: ${reportNumber}   |   INSPECTED: ${inspectionDate}`, margin, 28, { width: contentWidth, align: "right" });
  doc.moveTo(margin, 40).lineTo(margin + contentWidth, 40).lineWidth(0.5).stroke("#e2e8f0");

  // 2. CUSTOMER & VEHICLE CARDS
  drawSectionHeading("CUSTOMER AND VEHICLE");
  const colW = contentWidth / 4;

  // Tier 1: Warm Light Card
  const card1H = 34;
  doc.roundedRect(margin, y, contentWidth, card1H, 3).fill("#fdfbf7");
  doc.roundedRect(margin, y, contentWidth, card1H, 3).lineWidth(0.5).stroke("#eadcc9");

  // Col 0: Customer
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#64748b").text("CUSTOMER", margin + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#1f2f3e").text(customerName, margin + 6, y + 13, { width: colW - 10, lineBreak: false });
  if (customerPhone || customerEmail) {
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text([customerPhone, customerEmail].filter(Boolean).join(" | "), margin + 6, y + 23, { width: colW - 10, lineBreak: false });
  }

  // Col 1: Registration
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#64748b").text("REGISTRATION", margin + colW + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#1f2f3e").text(vehicleReg, margin + colW + 6, y + 13, { width: colW - 10, lineBreak: false });
  if (branchName) {
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(`Branch: ${branchName}`, margin + colW + 6, y + 23, { width: colW - 10, lineBreak: false });
  }

  // Col 2: Make / Model
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#64748b").text("MAKE / MODEL", margin + colW * 2 + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#1f2f3e").text(vehicleMakeModel, margin + colW * 2 + 6, y + 13, { width: colW - 10, lineBreak: false });
  if (vehicleYear) {
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(`Year: ${vehicleYear}`, margin + colW * 2 + 6, y + 23, { width: colW - 10, lineBreak: false });
  }

  // Col 3: Fuel Type
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#64748b").text("FUEL TYPE", margin + colW * 3 + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#1f2f3e").text(fuelType, margin + colW * 3 + 6, y + 13, { width: colW - 10, lineBreak: false });

  y += card1H + 4;

  // Tier 2: Dark Navy Card
  const card2H = 26;
  doc.roundedRect(margin, y, contentWidth, card2H, 3).fill("#1e293b");

  // Col 0: Odometer
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#94a3b8").text("ODOMETER", margin + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff").text(odometerText, margin + 6, y + 13, { lineBreak: false });

  // Col 1: Insurance Due
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#94a3b8").text("INSURANCE DUE", margin + colW + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff").text(insuranceDueDate, margin + colW + 6, y + 13, { lineBreak: false });

  // Col 2: Inspector
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#94a3b8").text("INSPECTED BY", margin + colW * 2 + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff").text(inspectorName, margin + colW * 2 + 6, y + 13, { lineBreak: false });

  // Col 3: Revision
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#94a3b8").text("REVISION", margin + colW * 3 + 6, y + 5, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff").text(`Rev ${revision}`, margin + colW * 3 + 6, y + 13, { lineBreak: false });

  y += card2H + 8;

  // 3. OVERALL RATING CARD
  const ratingCardH = 24;
  doc.roundedRect(margin, y, contentWidth, ratingCardH, 3).fill("#f8fafc");
  doc.roundedRect(margin, y, contentWidth, ratingCardH, 3).lineWidth(0.5).stroke("#e2e8f0");
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#1f2f3e").text("OVERALL VEHICLE RATING", margin + 8, y + 5, { lineBreak: false });
  doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text("Calculated from component checklists and visual diagnostic inspection", margin + 8, y + 14, { lineBreak: false });
  drawPill(overallRating, overallRating, margin + contentWidth - 68, y + 5, 60, 14);
  y += ratingCardH + 5;

  if (overrideReason) {
    doc.font("Helvetica").fontSize(6.8).fillColor("#64748b").text(`Override reason: ${overrideReason}`, margin + 6, y, { width: contentWidth - 12 });
    y += 11;
  }

  // 4. MAJOR CHECKLIST SUMMARY
  const sections = Array.isArray(report.sections) ? (report.sections as Array<Record<string, unknown>>) : [];
  if (sections.length > 0) {
    drawSectionHeading("MAJOR CHECKLIST SUMMARY");
    const numCols = 2;
    const gridW = (contentWidth - 8) / 2;
    const rowCount = Math.ceil(sections.length / numCols);
    ensureSpace(rowCount * 20 + 8);

    sections.forEach((sec, idx) => {
      const col = idx % numCols;
      const row = Math.floor(idx / numCols);
      const itemX = margin + col * (gridW + 8);
      const itemY = y + row * 20;

      doc.roundedRect(itemX, itemY, gridW, 16, 2.5).fill("#ffffff");
      doc.roundedRect(itemX, itemY, gridW, 16, 2.5).lineWidth(0.5).stroke("#e2e8f0");

      const secName = text(sec.name ?? sec.title, "Section");
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#1f2f3e").text(secName, itemX + 8, itemY + 4.5, { width: gridW - 55, lineBreak: false });

      const secRating = text(sec.computedRating, "N/A");
      drawPill(secRating, secRating, itemX + gridW - 44, itemY + 2.5, 38, 11);
    });

    y += rowCount * 20 + 8;
  }

  // 5. VEHICLE EXTERIOR CONDITION BLUEPRINT
  const vehicleConditions = Array.isArray(report.vehicleConditions) ? (report.vehicleConditions as Array<Record<string, unknown>>) : [];
  const hasExteriorCondition = vehicleConditions.length > 0 || Boolean(report.overallPreDriveCondition);
  if (hasExteriorCondition) {
    try {
      const conditionSvg = buildVehicleConditionSvg(report);
      const pngBuf = await sharp(Buffer.from(conditionSvg.markup)).png({ density: 150 }).toBuffer();
      const imgH = (contentWidth * conditionSvg.height) / conditionSvg.width;
      ensureSpace(imgH + 24);
      drawSectionHeading(`VEHICLE EXTERIOR CONDITION (${vehicleConditions.length})`);
      doc.image(pngBuf, margin, y, { width: contentWidth, height: imgH });
      y += imgH + 10;
    } catch {
      // If SVG conversion fails, continue smoothly without blocking report generation
    }
  }

  // 6. DETAILED COMPONENT CHECKLISTS
  if (sections.length > 0) {
    drawSectionHeading("DETAILED COMPONENT CHECKLIST");

    for (const section of sections) {
      ensureSpace(50);
      const secName = text(section.name ?? section.title, "Inspection Section");
      const secRating = text(section.computedRating, "N/A");

      // Section header bar
      doc.roundedRect(margin, y, contentWidth, 15, 2).fill("#eff4fb");
      doc.roundedRect(margin, y, 2, 15, 1).fill("#be4126");
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#1f2f3e").text(secName.toUpperCase(), margin + 8, y + 4, { lineBreak: false });
      drawPill(secRating, secRating, margin + contentWidth - 46, y + 2, 40, 11);
      y += 18;

      // Table Header
      doc.rect(margin, y, contentWidth, 13).fill("#1e293b");
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#ffffff");
      doc.text("CHECKPOINT", margin + 8, y + 3.5, { width: 175, lineBreak: false });
      doc.text("CONDITION", margin + 185, y + 3.5, { width: 65, align: "center", lineBreak: false });
      doc.text("READING / VALUE", margin + 255, y + 3.5, { width: 85, lineBreak: false });
      doc.text("REMARKS / NOTES", margin + 345, y + 3.5, { width: 170, lineBreak: false });
      y += 13;

      const checkpoints = Array.isArray(section.checkpoints)
        ? (section.checkpoints as Array<Record<string, unknown>>)
        : Array.isArray(section.items)
          ? (section.items as Array<Record<string, unknown>>)
          : [];

      if (checkpoints.length === 0) {
        doc.rect(margin, y, contentWidth, 15).fill("#f8fafc");
        doc.font("Helvetica").fontSize(7).fillColor("#64748b").text("No checkpoints recorded in this section.", margin + 8, y + 4);
        y += 15;
      } else {
        checkpoints.forEach((cp, cpIdx) => {
          const cpName = checkpointLabel(cp);
          const cpRating = text(cp.rating ?? cp.conditionRating ?? cp.severity, "NOT_CHECKED");
          const cpReading = text(cp.reading ?? cp.value, "-");
          const cpRemarks = text(cp.remarks ?? cp.remark ?? cp.notes, "-");

          const rowH = 16;
          ensureSpace(rowH + 2);
          const bg = cpIdx % 2 === 0 ? "#ffffff" : "#f8fafc";
          doc.rect(margin, y, contentWidth, rowH).fill(bg);

          // Divider
          doc.moveTo(margin, y + rowH).lineTo(margin + contentWidth, y + rowH).lineWidth(0.3).stroke("#e2e8f0");

          // Name
          doc.font("Helvetica-Bold").fontSize(7.2).fillColor("#1f2f3e").text(cpName, margin + 8, y + 4.5, { width: 172, lineBreak: false });

          // Pill
          drawPill(cpRating, cpRating, margin + 190, y + 2.5, 55, 11);

          // Reading
          doc.font("Helvetica").fontSize(7).fillColor("#334155").text(cpReading, margin + 255, y + 4.5, { width: 85, lineBreak: false });

          // Remarks
          doc.font("Helvetica").fontSize(6.8).fillColor("#64748b").text(cpRemarks, margin + 345, y + 4.5, { width: 170, lineBreak: false });

          y += rowH;
        });
      }
      y += 7;
    }
  }

  // 7. REMARKS / NOTES & TERMS
  const notesText = text(report.notes ?? report.remarks ?? report.overallRemarks);
  if (notesText) {
    drawSectionHeading("INSPECTION NOTES");
    ensureSpace(32);
    doc.roundedRect(margin, y, contentWidth, 26, 2.5).fill("#f8fafc");
    doc.roundedRect(margin, y, contentWidth, 26, 2.5).lineWidth(0.5).stroke("#e2e8f0");
    doc.font("Helvetica").fontSize(7.2).fillColor("#334155").text(notesText, margin + 8, y + 6, { width: contentWidth - 16 });
    y += 34;
  }

  const termsText = Array.isArray(report.terms)
    ? report.terms.map((t) => text(t)).filter(Boolean).join("\n")
    : text(report.terms);
  if (termsText) {
    drawSectionHeading("TERMS AND CONDITIONS");
    ensureSpace(36);
    doc.roundedRect(margin, y, contentWidth, 30, 2.5).fill("#f8fafc");
    doc.roundedRect(margin, y, contentWidth, 30, 2.5).lineWidth(0.5).stroke("#e2e8f0");
    doc.font("Helvetica").fontSize(6.8).fillColor("#64748b").text(termsText, margin + 8, y + 6, { width: contentWidth - 16 });
    y += 38;
  }

  // 8. INSPECTION PHOTOS
  if (photos.length > 0) {
    doc.addPage({ size: "A4", margin: 36 });
    y = 38;
    drawSectionHeading(`INSPECTION PHOTOS (${photos.length})`);
    const photoColW = (contentWidth - 10) / 2;
    const photoBoxH = 155;

    for (let pIdx = 0; pIdx < photos.length; pIdx += 2) {
      ensureSpace(photoBoxH + 14);
      const pair = photos.slice(pIdx, pIdx + 2);

      for (let cIdx = 0; cIdx < pair.length; cIdx++) {
        const ph = pair[cIdx];
        const px = margin + cIdx * (photoColW + 10);

        doc.roundedRect(px, y, photoColW, photoBoxH, 3).fill("#ffffff");
        doc.roundedRect(px, y, photoColW, photoBoxH, 3).lineWidth(0.5).stroke("#e2e8f0");

        try {
          const imgBuf = await sharp(ph.buffer, { failOn: "error" }).rotate().jpeg({ quality: 85 }).toBuffer();
          doc.image(imgBuf, px + 4, y + 4, { fit: [photoColW - 8, 128], align: "center", valign: "center" });
        } catch {
          doc.font("Helvetica").fontSize(7).fillColor("#94a3b8").text("Photo preview unavailable", px + 8, y + 60, { width: photoColW - 16, align: "center" });
        }

        const caption = text(ph.caption, `Photo ${ph.id}`);
        doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(caption, px + 6, y + 138, { width: photoColW - 12, lineBreak: false });
      }
      y += photoBoxH + 8;
    }
  }

  // 9. MULTI-PAGE RUNNING FOOTERS & RUNNING HEADERS
  const range = doc.bufferedPageRange();
  for (let page = 0; page < range.count; page++) {
    doc.switchToPage(page);

    // Accent top bar on all pages
    doc.rect(0, 0, pageWidth, 3.5).fill(primary);

    // Running Header on page > 0
    if (page > 0) {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(primary).text(businessName, margin, 13, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#1f2f3e").text("VEHICLE INSPECTION REPORT", margin, 13, { width: contentWidth, align: "right" });
      doc.moveTo(margin, 24).lineTo(margin + contentWidth, 24).lineWidth(0.5).stroke("#e2e8f0");
    }

    // Running Footer
    doc.moveTo(margin, 804).lineTo(margin + contentWidth, 804).lineWidth(0.5).stroke("#e2e8f0");
    const contactInfo = [businessAddress, businessPhone].filter(Boolean).join("  |  ") || businessName;
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(contactInfo, margin, 810, { width: 220, lineBreak: false });
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(`${reportNumber}  |  Revision ${revision}`, margin, 810, { width: contentWidth, align: "center", lineBreak: false });
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(`Page ${page + 1} of ${range.count}`, margin, 810, { width: contentWidth, align: "right", lineBreak: false });
  }

  doc.end();
  return output;
}
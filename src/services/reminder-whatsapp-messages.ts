import type { ReminderRecord } from "./reminder-auto-whatsapp.js";

const TYPE_LABEL: Record<string, string> = {
  GENERAL_SERVICE: "General Service",
  OIL_CHANGE: "Oil Change",
  BRAKE_INSPECTION: "Brake Inspection",
  TIRE_ROTATION: "Tire Rotation",
  AC_SERVICE: "AC Service",
  BATTERY_CHECK: "Battery Check",
  INSURANCE: "Insurance Renewal",
  PUC: "PUC Certificate",
  PPF_MAINTENANCE: "PPF Maintenance",
  CERAMIC_MAINTENANCE: "Ceramic Maintenance",
};

function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

function formatDue(dueDate: string): string {
  const d = new Date(dueDate.slice(0, 10) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return dueDate;
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Mirrors frontend buildServiceReminderWhatsAppMessage. Prefer organization businessName. */
export function buildServiceReminderWhatsAppMessage(
  reminder: ReminderRecord,
  businessName = "My Detail OS"
): string {
  const firstName = reminder.customerName.trim().split(/\s+/)[0] ?? reminder.customerName;
  const typeLabel = TYPE_LABEL[String(reminder.type ?? "")] ?? String(reminder.type ?? "Service");
  const vehicle = `${reminder.vehicleMakeModel ?? ""} (${reminder.vehicleRegNumber ?? ""})`.trim();
  const brand = businessName.trim() || "My Detail OS";

  return [
    `Hi *${firstName}*,`,
    ``,
    `Friendly reminder from *${brand}* regarding your vehicle.`,
    `Reminder: *${typeLabel}*`,
    `Customer: ${reminder.customerName}`,
    `Vehicle: ${vehicle}`,
    `Due: *${formatDue(reminder.dueDate)}*`,
    reminder.notes?.trim() ? `Note: ${reminder.notes.trim()}` : "",
    ``,
    `Book a slot when convenient — reply here or call us.`,
    ``,
    `— Team ${brand}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Mirrors frontend buildPaymentPendingReminderWhatsAppMessage (singleInvoice). */
export function buildPaymentPendingReminderWhatsAppMessage(opts: {
  pendingAmount: number;
  statementUrl: string;
  businessName: string;
  invoiceUrl?: string;
  invoiceNumber?: string;
}): string {
  const invLabel = opts.invoiceNumber ? ` on invoice ${opts.invoiceNumber}` : "";
  const lines = [
    `Hi sir/ma'am,`,
    ``,
    `Your payment of ${formatInr(opts.pendingAmount)} is pending${invLabel}.`,
    ``,
  ];
  if (opts.invoiceUrl) {
    lines.push(`View invoice:`, opts.invoiceUrl, ``);
  }
  lines.push(
    `View full ledger statement:`,
    opts.statementUrl,
    `Please clear the payment as soon as possible.`,
    ``,
    `Thank you,`,
    opts.businessName
  );
  return lines.join("\n");
}

/** Variables for Twilio template `service_reminder_exact`. */
export function serviceReminderTemplateVariables(
  reminder: ReminderRecord,
  businessName = "My Detail OS"
): Record<string, string> {
  const customerName = reminder.customerName.trim() || "there";
  const firstName = customerName.split(/\s+/)[0] || customerName;
  const typeLabel = TYPE_LABEL[String(reminder.type ?? "")] ?? String(reminder.type ?? "Service");
  const vehicle =
    (reminder.vehicleRegNumber || reminder.vehicleMakeModel || "your vehicle").trim() || "your vehicle";
  const brand = businessName.trim() || "My Detail OS";
  return {
    "1": firstName,
    "2": brand,
    "3": typeLabel,
    "4": customerName,
    "5": vehicle,
    "6": formatDue(reminder.dueDate),
    "7": reminder.notes?.trim() || "Please book a slot when convenient",
  };
}

/** Variables for Twilio template `payment_pending_exact_v2`. */
export function paymentPendingTemplateVariables(opts: {
  pendingAmount: number;
  statementUrl: string;
  businessName?: string;
  invoiceUrl?: string;
  invoiceNumber?: string;
}): Record<string, string> {
  return {
    "1": formatInr(opts.pendingAmount),
    "2": (opts.invoiceNumber || "invoice").trim(),
    "3": (opts.invoiceUrl || opts.statementUrl).trim(),
    "4": opts.statementUrl.trim(),
    "5": (opts.businessName || "My Detail OS").trim(),
  };
}

export function publicInvoiceShareUrl(baseUrl: string, invoiceId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/public-invoice/${encodeURIComponent(invoiceId)}`;
}

export function publicCustomerLedgerShareUrl(baseUrl: string, customerId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/public-ledger/${encodeURIComponent(customerId)}`;
}

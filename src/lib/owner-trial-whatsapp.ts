/** Workshop owner trial-started WhatsApp (plain text; WhatsApp auto-links the URL). */

export function firstNameFrom(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] || fullName.trim();
  return first || "there";
}

export function buildOwnerTrialStartedWhatsAppMessage(opts: {
  ownerName: string;
  trialDays: number;
  loginUrl: string;
  email?: string;
  temporaryPassword?: string;
}): string {
  const first = firstNameFrom(opts.ownerName);
  const days = Math.max(1, Math.floor(opts.trialDays));
  const login = opts.loginUrl.replace(/\/$/, "");
  const lines = [
    `Hi ${first},`,
    ``,
    `Your ${days} day trial for My Detail OS has started 🚗.`,
    ``,
    `Click the button below to login and manage your garage operations.`,
    ``,
    `Powered by My Detail OS.`,
  ];
  if (opts.email || opts.temporaryPassword) {
    lines.push(``);
    if (opts.email) lines.push(`Email: ${opts.email}`);
    if (opts.temporaryPassword) lines.push(`Temporary password: ${opts.temporaryPassword}`);
  }
  return lines.join("\n");
}

export function buildOwnerTrialStartedSmsMessage(opts: {
  ownerName: string;
  trialDays: number;
  loginUrl: string;
  email?: string;
  temporaryPassword?: string;
}): string {
  const first = firstNameFrom(opts.ownerName);
  const days = Math.max(1, Math.floor(opts.trialDays));
  const login = opts.loginUrl.replace(/\/$/, "");
  const creds =
    opts.email && opts.temporaryPassword
      ? ` Email: ${opts.email} Temp password: ${opts.temporaryPassword}`
      : "";
  return `Hi ${first}, your ${days} day MY DETAIL OS trial has started. Login: ${login}${creds}`;
}

function formatAddedCapacity(extraBranches?: number, extraUsers?: number): string | null {
  const branches = Math.max(0, Math.floor(extraBranches ?? 0));
  const users = Math.max(0, Math.floor(extraUsers ?? 0));
  const parts: string[] = [];
  if (branches > 0) parts.push(`${branches} extra branch${branches === 1 ? "" : "es"}`);
  if (users > 0) parts.push(`${users} extra user${users === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" and ") : null;
}

export function buildOwnerPlanActivatedWhatsAppMessage(opts: {
  ownerName: string;
  organizationName: string;
  planName: string;
  termLabel: string;
  amount: number;
  loginUrl: string;
  expiresAt?: string | null;
  kind: "upgrade" | "renewal" | "addon";
  extraBranches?: number;
  extraUsers?: number;
  billNumber?: string | null;
  invoiceUrl?: string | null;
}): string {
  const first = firstNameFrom(opts.ownerName);
  const login = opts.loginUrl.replace(/\/$/, "");
  const added = formatAddedCapacity(opts.extraBranches, opts.extraUsers);
  const headline =
    opts.kind === "upgrade"
      ? `Your MY DETAIL OS plan is now active 🚗.`
      : opts.kind === "addon"
        ? `Your extra branches and users on MY DETAIL OS are now active 🚗.`
        : `Your MY DETAIL OS subscription has been renewed 🚗.`;
  const lines = [
    `Hi ${first},`,
    ``,
    headline,
    ``,
    `Organization: ${opts.organizationName}`,
    `Plan: ${opts.planName}`,
  ];
  if (opts.kind === "addon") {
    if (added) lines.push(`Added: ${added}`);
  } else {
    lines.push(`Term: ${opts.termLabel}`);
  }
  lines.push(`Amount paid: ₹${opts.amount.toFixed(2)}`);
  if (opts.billNumber) lines.push(`Bill: ${opts.billNumber}`);
  if (opts.expiresAt) lines.push(`Valid until: ${opts.expiresAt}`);
  if (opts.invoiceUrl) {
    lines.push(``, `📎 *View & Download Tax Invoice:*`, opts.invoiceUrl);
  }
  lines.push(``, `Login here: ${login}`, ``, `Thank you,`, `Team MY DETAIL OS`);
  return lines.join("\n");
}

/** Variables for Twilio template `owner_plan_activated_exact`. */
export function ownerPlanActivatedTemplateVariables(opts: {
  ownerName: string;
  organizationName: string;
  planName: string;
  termLabel: string;
  amount: number;
  loginUrl: string;
  expiresAt?: string | null;
  billNumber?: string | null;
  invoiceUrl?: string | null;
}): Record<string, string> {
  const targetLink = opts.invoiceUrl?.trim() || opts.loginUrl.replace(/\/$/, "");
  return {
    "1": firstNameFrom(opts.ownerName),
    "2": opts.organizationName,
    "3": opts.planName,
    "4": opts.termLabel,
    "5": `₹${opts.amount.toFixed(2)}`,
    "6": opts.billNumber?.trim() || "N/A",
    "7": opts.expiresAt?.trim() || "see app",
    "8": targetLink,
  };
}

/** Variables for Twilio template `owner_trial_started_login`. Button URL is fixed to the login page. */
export function ownerTrialStartedTemplateVariables(opts: {
  ownerName: string;
  trialDays: number;
}): Record<string, string> {
  const days = Math.max(1, Math.floor(opts.trialDays));
  return {
    "1": firstNameFrom(opts.ownerName),
    "2": String(days),
  };
}

/** Variables for Twilio template `owner_payment_link`. */
export function ownerPaymentLinkTemplateVariables(opts: {
  ownerName?: string | null;
  organizationName: string;
  amount: number;
  paymentLinkUrl: string;
}): Record<string, string> {
  return {
    "1": opts.ownerName?.trim() ? firstNameFrom(opts.ownerName) : "there",
    "2": opts.organizationName,
    "3": `₹${opts.amount.toFixed(2)}`,
    "4": opts.paymentLinkUrl,
  };
}

export function buildOwnerPlanActivatedSmsMessage(opts: {
  ownerName: string;
  planName: string;
  amount: number;
  loginUrl: string;
  kind: "upgrade" | "renewal" | "addon";
  extraBranches?: number;
  extraUsers?: number;
}): string {
  const first = firstNameFrom(opts.ownerName);
  const login = opts.loginUrl.replace(/\/$/, "");
  if (opts.kind === "addon") {
    const added = formatAddedCapacity(opts.extraBranches, opts.extraUsers);
    const detail = added ? ` (${added})` : "";
    return `Hi ${first}, extra capacity on MY DETAIL OS is now active${detail}. Amount: ₹${opts.amount.toFixed(2)}. Login: ${login}`;
  }
  const verb = opts.kind === "upgrade" ? "is now active" : "has been renewed";
  return `Hi ${first}, your MY DETAIL OS ${opts.planName} plan ${verb}. Amount: ₹${opts.amount.toFixed(2)}. Login: ${login}`;
}

export function buildOwnerPaymentLinkWhatsAppMessage(opts: {
  ownerName?: string | null;
  organizationName: string;
  amount: number;
  paymentLinkUrl: string;
}): string {
  const first = opts.ownerName?.trim() ? firstNameFrom(opts.ownerName) : "there";
  return [
    `Hi ${first},`,
    ``,
    `Please complete your MY DETAIL OS payment for ${opts.organizationName}.`,
    ``,
    `Amount: ₹${opts.amount.toFixed(2)}`,
    ``,
    `Pay here: ${opts.paymentLinkUrl}`,
    ``,
    `Thank you,`,
    `Team MY DETAIL OS`,
  ].join("\n");
}

/** Variables for Twilio template `trial_expired_v1` (HX0d17b4d75645d165b231a0d86b32e876). */
export function ownerTrialExpiredTemplateVariables(opts: {
  ownerName: string;
  organizationName: string;
  expirationDate: string;
  upgradeUrl: string;
}): Record<string, string> {
  return {
    "1": firstNameFrom(opts.ownerName),
    "2": opts.organizationName,
    "3": opts.expirationDate,
    "4": opts.upgradeUrl.replace(/\/$/, ""),
  };
}

/** Variables for Twilio template `subscription_expired_v1` (HX54f7800d178682b39fdbfe1e3f329497). */
export function ownerSubscriptionExpiredTemplateVariables(opts: {
  ownerName: string;
  organizationName: string;
  planName: string;
  expirationDate: string;
  renewalUrl: string;
}): Record<string, string> {
  return {
    "1": firstNameFrom(opts.ownerName),
    "2": opts.organizationName,
    "3": opts.planName,
    "4": opts.expirationDate,
    "5": opts.renewalUrl.replace(/\/$/, ""),
  };
}

export function buildOwnerTrialExpiredWhatsAppMessage(opts: {
  ownerName: string;
  organizationName: string;
  expirationDate: string;
  upgradeUrl: string;
}): string {
  const first = firstNameFrom(opts.ownerName);
  return [
    `Hi ${first}! ⚠️`,
    `Your free trial for ${opts.organizationName} on My Detail OS has expired.`,
    ``,
    `📅 Expiration Date: ${opts.expirationDate}`,
    `🔗 Upgrade to an active plan to keep your operations running:`,
    opts.upgradeUrl,
    ``,
    `Thank you,`,
    `Team My Detail OS.`,
  ].join("\n");
}

export function buildOwnerSubscriptionExpiredWhatsAppMessage(opts: {
  ownerName: string;
  organizationName: string;
  planName: string;
  expirationDate: string;
  renewalUrl: string;
}): string {
  const first = firstNameFrom(opts.ownerName);
  return [
    `Hi ${first}! ⚠️`,
    `Your ${opts.planName} subscription for ${opts.organizationName} on My Detail OS has expired.`,
    ``,
    `📅 Expiration Date: ${opts.expirationDate}`,
    `🔗 Renew your subscription to restore full access:`,
    opts.renewalUrl,
    ``,
    `Thank you,`,
    `Team My Detail OS.`,
  ].join("\n");
}

/** Variables for Twilio template `trial_expiring_reminder_v1` (HX45af808870cab6c07b1fbee3f5b4f80a). */
export function ownerTrialExpiringReminderTemplateVariables(opts: {
  ownerName: string;
  organizationName: string;
  timeRemaining: string;
  expirationDate: string;
  upgradeUrl: string;
}): Record<string, string> {
  return {
    "1": firstNameFrom(opts.ownerName),
    "2": opts.organizationName,
    "3": opts.timeRemaining,
    "4": opts.expirationDate,
    "5": opts.upgradeUrl.replace(/\/$/, ""),
  };
}

/** Variables for Twilio template `sub_expiring_reminder_v1` (HX25e04dd54564f85f7a27b1269952d8db). */
export function ownerSubscriptionExpiringReminderTemplateVariables(opts: {
  ownerName: string;
  organizationName: string;
  planName: string;
  timeRemaining: string;
  expirationDate: string;
  renewalUrl: string;
}): Record<string, string> {
  return {
    "1": firstNameFrom(opts.ownerName),
    "2": opts.organizationName,
    "3": opts.planName,
    "4": opts.timeRemaining,
    "5": opts.expirationDate,
    "6": opts.renewalUrl.replace(/\/$/, ""),
  };
}

export function buildOwnerTrialExpiringReminderWhatsAppMessage(opts: {
  ownerName: string;
  organizationName: string;
  timeRemaining: string;
  expirationDate: string;
  upgradeUrl: string;
}): string {
  const first = firstNameFrom(opts.ownerName);
  return [
    `Hi ${first}! ⏳`,
    `Friendly reminder: your free trial for ${opts.organizationName} on My Detail OS is expiring in ${opts.timeRemaining}.`,
    ``,
    `📅 Expiration Date: ${opts.expirationDate}`,
    `🔗 Upgrade your plan to maintain uninterrupted garage operations:`,
    opts.upgradeUrl,
    ``,
    `Thank you,`,
    `Team My Detail OS.`,
  ].join("\n");
}

export function buildOwnerSubscriptionExpiringReminderWhatsAppMessage(opts: {
  ownerName: string;
  organizationName: string;
  planName: string;
  timeRemaining: string;
  expirationDate: string;
  renewalUrl: string;
}): string {
  const first = firstNameFrom(opts.ownerName);
  return [
    `Hi ${first}! ⏳`,
    `Friendly reminder: your ${opts.planName} subscription for ${opts.organizationName} on My Detail OS is expiring in ${opts.timeRemaining}.`,
    ``,
    `📅 Expiration Date: ${opts.expirationDate}`,
    `🔗 Renew your subscription to maintain uninterrupted service:`,
    opts.renewalUrl,
    ``,
    `Thank you,`,
    `Team My Detail OS.`,
  ].join("\n");
}

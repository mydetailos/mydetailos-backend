export function buildCustomerCredentialsWhatsAppMessage(opts: {
  customerName?: string;
  firstName?: string;
  phone: string;
  password: string;
  businessName: string;
  customerPortalUrl: string;
}): string {
  const name = (opts.customerName || opts.firstName || "Customer").trim();
  return [
    `Welcome to ${opts.businessName}, ${name}!`,
    ``,
    `Your customer portal login details:`,
    `Phone: ${opts.phone}`,
    `Password: ${opts.password}`,
    ``,
    `Login here: ${opts.customerPortalUrl}`,
    ``,
    `Please keep this password safe — you can change it anytime after logging in.`,
  ].join("\n");
}

/** Variables for approved Twilio Content template `customer_portal_login_v2`. */
export function customerCredentialsTemplateVariables(opts: {
  customerName: string;
  businessName: string;
}): Record<string, string> {
  const customer = opts.customerName.trim() || "there";
  const business = opts.businessName.trim() || "My Detail OS";
  return {
    "1": customer,
    "2": business,
  };
}

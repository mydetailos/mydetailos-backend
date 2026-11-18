import { isResendConfigured, sendViaResend, type ResendSendResult } from "./resend-send.js";
import { env } from "../config/env.js";

export const SUPPORT_EMAIL = "support@mydetailos.com";

export interface ContactEnquiryEmailParams {
  name: string;
  email?: string | null;
  phone?: string | null;
  businessName?: string | null;
  subject?: string | null;
  message: string;
  submissionDate?: Date;
  source?: string | null;
}

export function isContactEmailConfigured(): boolean {
  return isResendConfigured();
}

export type EmailSenderFn = (params: Parameters<typeof sendViaResend>[0]) => Promise<ResendSendResult>;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "EN";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export async function sendContactEnquiryEmail(
  params: ContactEnquiryEmailParams,
  sender: EmailSenderFn = sendViaResend
): Promise<ResendSendResult> {
  const recipient = SUPPORT_EMAIL;
  const submissionDate = params.submissionDate ?? new Date();
  const formattedDate = submissionDate.toUTCString();
  const displaySubject =
    params.subject?.trim() ||
    (params.businessName?.trim()
      ? `Website Enquiry - ${params.businessName.trim()}`
      : "Website Contact Enquiry");

  const emailSubject = `[Contact Enquiry] ${displaySubject} - ${params.name.trim()}`;

  const customerEmail = params.email?.trim() || null;
  const customerPhone = params.phone?.trim() || null;
  const businessName = params.businessName?.trim() || null;
  const initials = getInitials(params.name);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Customer Enquiry</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.05); overflow: hidden;">
          
          <!-- Top Accent Gradient -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, #0d9488 0%, #0f766e 100%);"></td>
          </tr>

          <!-- Header Section -->
          <tr>
            <td style="padding: 28px 32px 16px 32px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <span style="display: inline-block; background-color: #f0fdfa; color: #0f766e; border: 1px solid #ccfbf1; border-radius: 9999px; padding: 4px 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">
                      New Customer Enquiry
                    </span>
                    <h1 style="margin: 12px 0 6px 0; font-size: 21px; font-weight: 700; color: #0f172a; line-height: 1.3;">
                      ${escapeHtml(displaySubject)}
                    </h1>
                    <p style="margin: 0; font-size: 12px; color: #64748b;">
                      <strong>Submission Date and Time:</strong> ${escapeHtml(formattedDate)}${params.source ? ` &nbsp;•&nbsp; <strong>Source:</strong> ${escapeHtml(params.source)}` : ""}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Customer Profile Card -->
          <tr>
            <td style="padding: 0 32px 20px 32px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px;">
                <tr>
                  <td width="46" valign="middle" style="padding-right: 14px;">
                    <div style="width: 44px; height: 44px; border-radius: 50%; background-color: #0f766e; color: #ffffff; font-size: 15px; font-weight: 700; text-align: center; line-height: 44px; text-transform: uppercase; letter-spacing: 0.03em;">
                      ${escapeHtml(initials)}
                    </div>
                  </td>
                  <td valign="middle">
                    <div style="font-size: 16px; font-weight: 700; color: #0f172a;">
                      ${escapeHtml(params.name)}
                      ${businessName ? `<span style="display: inline-block; margin-left: 8px; background-color: #e2e8f0; color: #334155; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; vertical-align: middle;">${escapeHtml(businessName)}</span>` : ""}
                    </div>
                    <div style="font-size: 13px; color: #475569; margin-top: 4px; line-height: 1.5;">
                      ${customerEmail ? `<a href="mailto:${escapeHtml(customerEmail)}" style="color: #0f766e; text-decoration: none; font-weight: 600;">✉️ ${escapeHtml(customerEmail)}</a>` : "<span style='color:#94a3b8;'>✉️ Email not provided</span>"}
                      ${customerPhone ? ` &nbsp;•&nbsp; <a href="tel:${escapeHtml(customerPhone)}" style="color: #475569; text-decoration: none; font-weight: 500;">📞 ${escapeHtml(customerPhone)}</a>` : ` &nbsp;•&nbsp; <span style='color:#94a3b8;'>📞 Not provided</span>`}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Message Section -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              <div style="font-size: 11px; font-weight: 700; color: #475569; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px;">
                Message
              </div>
              <div style="background-color: #ffffff; border: 1px solid #cbd5e1; border-left: 4px solid #0f766e; border-radius: 8px; padding: 18px 20px; font-size: 15px; line-height: 1.6; color: #1e293b; white-space: pre-wrap; word-break: break-word;">${escapeHtml(params.message)}</div>
            </td>
          </tr>

          <!-- Quick Action: Reply Button -->
          ${customerEmail ? `
          <tr>
            <td style="padding: 0 32px 24px 32px;" align="center">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="border-radius: 8px; background-color: #0f766e;">
                    <a href="mailto:${escapeHtml(customerEmail)}?subject=${encodeURIComponent("Re: " + displaySubject)}" style="display: inline-block; padding: 12px 26px; font-size: 13px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #0f766e; letter-spacing: 0.02em;">
                      Reply to ${escapeHtml(params.name)} &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 8px 0 0 0; font-size: 12px; color: #64748b;">
                Or hit <strong>Reply</strong> in your email client — replies route directly to ${escapeHtml(customerEmail)}.
              </p>
            </td>
          </tr>
          ` : ""}

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 14px 32px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #94a3b8; line-height: 1.4;">
                <strong>MY DETAIL OS</strong> • Automated Support Enquiry Notification<br />
                Recipient: <span style="color: #64748b;">support@mydetailos.com</span>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textLines = [
    `New Customer Enquiry - MyDetailOS Website`,
    ``,
    `Customer Name: ${params.name}`,
    `Email Address: ${customerEmail || "Not provided"}`,
    `Phone Number: ${customerPhone || "Not provided"}`,
    ...(businessName ? [`Business Name: ${businessName}`] : []),
    `Subject: ${displaySubject}`,
    `Submission Date and Time: ${formattedDate}`,
    ...(params.source ? [`Source: ${params.source}`] : []),
    ``,
    `Message:`,
    `--------------------------------------------------`,
    params.message,
    `--------------------------------------------------`,
    ``,
    `You can reply directly to this email to respond to the customer.`,
  ];

  return sender({
    to: [recipient],
    subject: emailSubject,
    html,
    text: textLines.join("\n"),
    ...(customerEmail ? { replyTo: customerEmail } : {}),
  });
}

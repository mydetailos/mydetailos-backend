import {
  bearerSecurity,
  commonErrorResponses,
  jsonBody,
  okResponse,
  permNote,
  platformSecurity,
  ref,
  type OpenApiPaths,
} from "../helpers.js";

const termMonthsSchema = {
  type: "integer",
  enum: [1, 3, 12, 24, 36, 60],
  description: "Subscription term in months.",
};

export const messagingPaths: OpenApiPaths = {
  "/api/messaging/sms/status": {
    post: {
      tags: ["Messaging"],
      summary: "Twilio SMS delivery callback",
      description: "Provider form webhook. Requires SDK signature validation, configured HTTPS callback URL and matching AccountSid; logs SID/status/error code only.",
      security: [],
      parameters: [{ name: "X-Twilio-Signature", in: "header", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object", required: ["AccountSid", "MessageSid", "MessageStatus"], additionalProperties: { type: "string" },
              properties: {
                AccountSid: { type: "string" },
                MessageSid: { type: "string", pattern: "^SM[0-9a-fA-F]{32}$" },
                MessageStatus: { type: "string", enum: ["accepted", "scheduled", "queued", "sending", "sent", "delivered", "undelivered", "failed", "canceled"] },
                ErrorCode: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Verified callback acknowledged" },
        "403": { description: "Invalid signature or account" },
        "503": { description: "Callback verification not configured" },
        "400": { description: "Invalid callback fields" },
      },
    },
  },
  "/api/messaging/sms/test": {
    post: {
      tags: ["Messaging"],
      summary: "Send test SMS",
      description: permNote("SETTINGS", "Uses TWILIO_SMS_TEST_BODY or default test text. Returns provider sid/status, not a delivery guarantee."),
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["phone"],
        properties: {
          phone: { type: "string", minLength: 8, maxLength: 32 },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        "503": { $ref: "#/components/responses/ServiceUnavailable" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/messaging/whatsapp/test": {
    post: {
      tags: ["Messaging"],
      summary: "Send test WhatsApp",
      description: permNote("SETTINGS", "Uses a fixed server test body."),
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["phone"],
        properties: {
          phone: { type: "string", minLength: 8, maxLength: 32 },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        "503": { $ref: "#/components/responses/ServiceUnavailable" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/messaging/whatsapp": {
    post: {
      tags: ["Messaging"],
      summary: "Send transactional WhatsApp",
      description:
        "Requires JWT (any authenticated staff). Provide exactly one of `message` or `contentSid`.",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["phone"],
        properties: {
          phone: { type: "string", minLength: 8, maxLength: 32 },
          message: { type: "string", maxLength: 16384 },
          contentSid: { type: "string" },
          contentVariables: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        "503": { $ref: "#/components/responses/ServiceUnavailable" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/messaging/email": {
    post: {
      tags: ["Messaging", "Billing"],
      summary: "Send transactional email (e.g. invoice)",
      description: "Requires JWT. Uses Resend. Attachments are base64 (do not paste secrets).",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["to", "subject", "html"],
        properties: {
          to: { type: "string", format: "email" },
          subject: { type: "string", maxLength: 200 },
          html: { type: "string" },
          text: { type: "string" },
          attachments: {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              required: ["filename", "content"],
              properties: {
                filename: { type: "string" },
                content: { type: "string", description: "Base64 file content" },
              },
            },
          },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        "413": { $ref: "#/components/responses/PayloadTooLarge" },
        "503": { $ref: "#/components/responses/ServiceUnavailable" },
        ...commonErrorResponses(),
      },
    },
  },
};

export const attendancePaths: OpenApiPaths = {
  "/api/attendance": {
    get: {
      tags: ["Attendance"],
      summary: "List attendance records",
      description: permNote("ATTENDANCE"),
      security: bearerSecurity,
      parameters: [
        {
          name: "branchId",
          in: "query",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            records: {
              type: "array",
              items: ref("AttendanceRecord"),
            },
          },
        }),
        ...commonErrorResponses(),
      },
    },
    delete: {
      tags: ["Attendance"],
      summary: "Reset all attendance records",
      description: permNote("ATTENDANCE", "Destructive admin reset."),
      security: bearerSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            ok: { type: "boolean" },
            records: { type: "array", items: {} },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
};

export const bootstrapPaths: OpenApiPaths = {
  "/api/bootstrap": {
    get: {
      tags: ["Bootstrap"],
      summary: "Shell bootstrap (thin)",
      description:
        "Requires JWT. Returns org-scoped branches, public branding (from appSettings), and subscription entitlement. " +
        "Does **not** return customers, vehicles, users, payroll, cash/bank, or other domain collections — load those via permission-scoped entity/collection APIs.",
      security: bearerSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            branches: { type: "array", items: { type: "object", additionalProperties: true } },
            branding: {
              type: "object",
              description: "Public branding fields only (no bank/GST/PAN secrets)",
              additionalProperties: { type: "string" },
            },
            entitlement: { type: "object", additionalProperties: true, nullable: true },
          },
          required: ["branches", "branding"],
        }),
        ...commonErrorResponses(),
      },
    },
  },
};

export const organizationPaths: OpenApiPaths = {
  "/api/organization/subscription": {
    get: {
      tags: ["Organization"],
      summary: "Studio subscription entitlement",
      description: "Requires JWT. Returns plan limits/status for the caller's organization (no internal notes).",
      security: bearerSecurity,
      responses: {
        "200": okResponse(ref("Organization")),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/organization/subscription/pricing": {
    post: {
      tags: ["Organization"],
      summary: "Get subscription pricing quote",
      description: "Returns a pricing quote for the given plan term and add-ons. Does not create a renewal. Requires JWT.",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["termMonths"],
        properties: {
          termMonths: termMonthsSchema,
          extraBranches: { type: "integer", minimum: 0, default: 0, description: "Additional branch slots beyond the plan default." },
          extraUsers: { type: "integer", minimum: 0, default: 0, description: "Additional staff user slots beyond the plan default." },
          referralCode: { type: "string", nullable: true, maxLength: 32, description: "Optional partner/referral code." },
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          description: "Pricing quote with line items and totals.",
          additionalProperties: true,
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/organization/subscription/renew": {
    post: {
      tags: ["Organization"],
      summary: "Submit subscription renewal request",
      description: "Creates a pending renewal (bill) for the caller's organization. Requires JWT. After submission, payment must be verified via the platform `/verify-payment` endpoint.",
      security: bearerSecurity,
      requestBody: jsonBody(
        {
          type: "object",
          properties: {
            termMonths: { ...termMonthsSchema, description: "Desired renewal term in months. Defaults to 12 if omitted." },
            extraBranches: { type: "integer", minimum: 0, description: "Additional branch slots." },
            extraUsers: { type: "integer", minimum: 0, description: "Additional user slots." },
            referralCode: { type: "string", nullable: true, maxLength: 32 },
            method: { type: "string", maxLength: 64, description: "Preferred payment method hint (e.g. 'UPI', 'Bank Transfer')." },
            notes: { type: "string", maxLength: 500, description: "Free-form notes to include with the renewal request." },
          },
        },
        false
      ),
      responses: {
        "200": okResponse({
          type: "object",
          description: "Created renewal record.",
          additionalProperties: true,
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/organization/subscription/bills": {
    get: {
      tags: ["Organization"],
      summary: "List subscription bills",
      description: "Returns all subscription bills (invoices) for the caller's organization. Requires JWT.",
      security: bearerSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          required: ["bills"],
          properties: {
            bills: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "List of subscription bill records.",
            },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/organization/subscription/bills/{billId}": {
    get: {
      tags: ["Organization"],
      summary: "Get a single subscription bill",
      description: "Returns one subscription bill by ID for the caller's organization. Returns 404 if not found or belongs to a different org. Requires JWT.",
      security: bearerSecurity,
      parameters: [
        { name: "billId", in: "path", required: true, schema: { type: "string" }, description: "Subscription bill ID." },
      ],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/organization/subscription/renewals": {
    get: {
      tags: ["Organization"],
      summary: "List subscription renewal history",
      description: "Returns the renewal history for the caller's organization. Requires JWT.",
      security: bearerSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          required: ["renewals"],
          properties: {
            renewals: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "List of renewal records ordered by date.",
            },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
};

export const platformPaths: OpenApiPaths = {
  "/api/platform/organizations": {
    get: {
      tags: ["SaaS Admin"],
      summary: "List all organizations (platform)",
      description:
        "Requires PLATFORM_OWNER JWT **or** `X-Platform-Admin-Key`. Studio SUPER_ADMIN is not sufficient.",
      security: platformSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            organizations: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/provision": {
    post: {
      tags: ["SaaS Admin"],
      summary: "Provision a new organization (trial)",
      description:
        "PLATFORM_OWNER only. Creates Organization + HQ branch + SUPER_ADMIN + TRIAL subscription. " +
        "Same provisioning path as public signup.",
      security: platformSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["businessName", "ownerName", "email", "phone", "password"],
        properties: {
          businessName: { type: "string" },
          ownerName: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          password: { type: "string", format: "password" },
          branchName: { type: "string" },
          planCode: { type: "string" },
          referralCode: { type: "string", nullable: true },
          trialDays: { type: "integer", minimum: 1, maximum: 90 },
          source: { type: "string" },
        },
      }),
      responses: {
        "201": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}": {
    get: {
      tags: ["SaaS Admin"],
      summary: "Get organization (platform)",
      description: "PLATFORM_OWNER JWT or X-Platform-Admin-Key.",
      security: platformSecurity,
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}/subscription": {
    patch: {
      tags: ["SaaS Admin"],
      summary: "Patch organization subscription",
      description: "PLATFORM_OWNER JWT or X-Platform-Admin-Key. Updates plan/limits/CTAs.",
      security: platformSecurity,
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: jsonBody({
        type: "object",
        properties: {
          planCode: {
            type: "string",
            enum: ["STARTER", "GROWTH", "BUSINESS", "ENTERPRISE", "CUSTOM"],
          },
          planName: { type: "string" },
          status: {
            type: "string",
            enum: ["ACTIVE", "PAST_DUE", "EXPIRED", "CANCELLED", "TRIAL"],
          },
          limits: {
            type: "object",
            properties: {
              maxBranches: { type: "integer", nullable: true },
              maxStaff: { type: "integer", nullable: true },
              maxCustomers: { type: "integer", nullable: true },
            },
          },
          maxBranchesOverride: { type: "integer", nullable: true },
          contactUsUrl: { type: "string", nullable: true },
          contactPhone: { type: "string", nullable: true },
          upgradeUrl: { type: "string", nullable: true },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}/subscription/verify-payment": {
    post: {
      tags: ["SaaS Admin"],
      summary: "Verify subscription payment (platform)",
      description:
        "Records the outcome of a payment attempt for a pending subscription bill. " +
        "Use `outcome: 'PAID'` to activate the subscription, or `'FAILED'` to mark it as failed. " +
        "Requires PLATFORM_OWNER JWT **or** `X-Platform-Admin-Key`.",
      security: platformSecurity,
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" }, description: "Organization ID." },
      ],
      requestBody: jsonBody({
        type: "object",
        required: ["paymentId", "outcome"],
        properties: {
          paymentId: { type: "string", minLength: 1, description: "The payment/bill ID to verify." },
          outcome: { type: "string", enum: ["PAID", "FAILED"], description: "Result of the payment." },
          txnReference: { type: "string", nullable: true, description: "External transaction reference (e.g. gateway txn ID)." },
          amount: { type: "number", minimum: 0, nullable: true, description: "Amount received." },
          notes: { type: "string", nullable: true, description: "Internal notes." },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true, description: "Updated entitlement record." }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}/subscription/mark-paid": {
    post: {
      tags: ["SaaS Admin"],
      summary: "Manually mark subscription as paid (platform)",
      description:
        "Admin shortcut to mark an organization's subscription as paid without a formal payment verification flow. " +
        "Creates a renewal record and activates the entitlement. " +
        "Requires PLATFORM_OWNER JWT **or** `X-Platform-Admin-Key`.",
      security: platformSecurity,
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" }, description: "Organization ID." },
      ],
      requestBody: jsonBody(
        {
          type: "object",
          properties: {
            txnReference: { type: "string", nullable: true, description: "External transaction reference." },
            amount: { type: "number", minimum: 0, nullable: true, description: "Amount paid." },
            termMonths: { ...termMonthsSchema, description: "Term to activate. Defaults to 12." },
            notes: { type: "string", nullable: true, description: "Internal admin notes." },
          },
        },
        false
      ),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true, description: "Updated entitlement record." }),
        ...commonErrorResponses(),
      },
    },
  },
};

/** Internal/cron job endpoints. */
export const jobsPaths: OpenApiPaths = {
  "/api/jobs/reminders/process": {
    post: {
      tags: ["Jobs"],
      summary: "Process service/payment reminder WhatsApp messages",
      description:
        "Daily cron endpoint. Scans all service reminders and pending invoices across all orgs " +
        "(or a single org when `organizationId` is provided) and sends WhatsApp notifications via Twilio. " +
        "\n\n**Auth:** `X-Internal-Job-Key: $INTERNAL_JOB_SECRET` header **or** a valid Bearer JWT " +
        "(org-scoped, for single-org use). This endpoint is not for studio users.",
      security: [{ InternalJobKey: [] }, { BearerAuth: [] }],
      requestBody: jsonBody(
        {
          type: "object",
          properties: {
            organizationId: {
              type: "string",
              description: "When provided with a job-secret, limits processing to a single organization. Ignored when using a JWT (already org-scoped).",
            },
          },
        },
        false
      ),
      responses: {
        "200": okResponse({
          type: "object",
          description: "Summary of processed reminders per organization.",
          additionalProperties: true,
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/jobs/inspections/uploads/cleanup": {
    post: {
      tags: ["Jobs"],
      summary: "Remove expired unlinked inspection uploads",
      description: "Secret-only cron endpoint. Requires X-Internal-Job-Key and INTERNAL_JOB_SECRET.",
      security: [{ InternalJobKey: [] }],
      responses: {
        "200": okResponse({ type: "object", properties: { removed: { type: "integer" } } }),
        ...commonErrorResponses(),
      },
    },
  },
};

const orgIdParam = { name: "orgId", in: "path", required: true, schema: { type: "string" }, description: "Organization ID." };
const crossOrgPageParams = [
  { name: "page", in: "query", schema: { type: "integer", default: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 200 } },
];
const crossOrgDateFilters = [
  { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
  { name: "until", in: "query", schema: { type: "string", format: "date-time" } },
];

export const platformExtPaths: OpenApiPaths = {
  "/api/platform/dashboard": {
    get: {
      tags: ["SaaS Admin"],
      summary: "Platform dashboard aggregates",
      description:
        "Org active/inactive counts, subscription status breakdown, MTD paid SaaS revenue, pending payments, active referrals.",
      security: platformSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            organizations: {
              type: "object",
              properties: {
                total: { type: "integer" },
                active: { type: "integer" },
                inactive: { type: "integer" },
              },
            },
            subscriptionStatusBreakdown: { type: "object", additionalProperties: { type: "integer" } },
            revenueMtd: { type: "object", additionalProperties: true },
            pendingPayments: { type: "integer" },
            activeReferrals: { type: "integer" },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/users": {
    get: {
      tags: ["SaaS Admin", "Users"],
      summary: "List users across organizations",
      description:
        "Platform auth. Safe staff directory fields only (no password hashes/tokens). Excludes PLATFORM_OWNER unless includePlatformOwner=true. total is the full filtered count.",
      security: platformSecurity,
      parameters: [
        ...crossOrgPageParams,
        { name: "orgId", in: "query", schema: { type: "string" } },
        { name: "role", in: "query", schema: { type: "string" } },
        { name: "isActive", in: "query", schema: { type: "boolean" } },
        { name: "search", in: "query", schema: { type: "string" }, description: "Match name, email, or phone" },
        { name: "includePlatformOwner", in: "query", schema: { type: "boolean", default: false } },
      ],
      responses: {
        "200": okResponse({
          type: "object",
          required: ["users", "total"],
          properties: {
            users: { type: "array", items: { type: "object", additionalProperties: true } },
            total: { type: "integer" },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/branches": {
    get: {
      tags: ["SaaS Admin", "Branches"],
      summary: "List branches across organizations",
      description: "Platform auth. Returns actual branch records (not just counts). total is the full filtered count.",
      security: platformSecurity,
      parameters: [
        ...crossOrgPageParams,
        { name: "orgId", in: "query", schema: { type: "string" } },
        { name: "isActive", in: "query", schema: { type: "boolean" } },
        { name: "search", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": okResponse({
          type: "object",
          required: ["branches", "total"],
          properties: {
            branches: { type: "array", items: { type: "object", additionalProperties: true } },
            total: { type: "integer" },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}/activity": {
    get: {
      tags: ["SaaS Admin"],
      summary: "Organization workshop activity logs",
      description:
        "PLATFORM_OWNER only. Reads the existing workshop activityLogs collection for one organization. " +
        "This is separate from platform audit (GET /api/platform/audit).",
      security: platformSecurity,
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "pageSize", in: "query", schema: { type: "integer" } },
        { name: "q", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/renewals": {
    get: {
      tags: ["SaaS Admin"],
      summary: "List renewal history across all organizations",
      security: platformSecurity,
      parameters: [
        ...crossOrgPageParams,
        ...crossOrgDateFilters,
        { name: "orgId", in: "query", schema: { type: "string" } },
        { name: "paymentStatus", in: "query", schema: { type: "string", enum: ["PAID","PENDING","PROCESSING","FAILED"] } },
      ],
      responses: {
        "200": okResponse({ type: "object", required: ["renewals", "total"], properties: { renewals: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer", description: "Full filtered count (not page length)" } } }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/bills": {
    get: {
      tags: ["SaaS Admin"],
      summary: "List subscription bills across all organizations",
      security: platformSecurity,
      parameters: [
        ...crossOrgPageParams,
        ...crossOrgDateFilters,
        { name: "orgId", in: "query", schema: { type: "string" } },
        { name: "search", in: "query", schema: { type: "string" } },
        { name: "paymentStatus", in: "query", schema: { type: "string", enum: ["PAID","PENDING","PROCESSING","FAILED"] } },
      ],
      responses: {
        "200": okResponse({ type: "object", required: ["bills", "total"], properties: { bills: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer", description: "Full filtered count (not page length)" } } }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/payments": {
    get: {
      tags: ["SaaS Admin"],
      summary: "List subscription payments across all organizations",
      security: platformSecurity,
      parameters: [
        ...crossOrgPageParams,
        ...crossOrgDateFilters,
        { name: "orgId", in: "query", schema: { type: "string" } },
        { name: "status", in: "query", schema: { type: "string", enum: ["PAID","PENDING","PROCESSING","FAILED"] } },
      ],
      responses: {
        "200": okResponse({ type: "object", required: ["payments", "total"], properties: { payments: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer", description: "Full filtered count (not page length)" } } }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/audit": {
    get: {
      tags: ["SaaS Admin"],
      summary: "List platform audit log entries",
      security: platformSecurity,
      parameters: [
        ...crossOrgPageParams,
        ...crossOrgDateFilters,
        { name: "orgId", in: "query", schema: { type: "string" } },
        { name: "action", in: "query", schema: { type: "string" }, description: "Partial match on action name." },
      ],
      responses: {
        "200": okResponse({ type: "object", required: ["logs", "total"], properties: { logs: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer", description: "Full filtered count (not page length)" } } }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/referrals": {
    get: {
      tags: ["SaaS Admin"],
      summary: "List platform subscription referral codes",
      security: platformSecurity,
      parameters: [
        { name: "showInactive", in: "query", schema: { type: "boolean" } },
      ],
      responses: {
        "200": okResponse({ type: "object", required: ["referralCodes"], properties: { referralCodes: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer" } } }),
        ...commonErrorResponses(),
      },
    },
    post: {
      tags: ["SaaS Admin"],
      summary: "Create a platform subscription referral code",
      security: platformSecurity,
      requestBody: jsonBody({ type: "object", required: ["code"], properties: { code: { type: "string", minLength: 4, maxLength: 24, pattern: "^[A-Z0-9-]+$" }, discountAmount: { type: "number", minimum: 0, default: 1000 }, notes: { type: "string" } } }),
      responses: {
        "201": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/referrals/{id}": {
    patch: {
      tags: ["SaaS Admin"],
      summary: "Update or deactivate a referral code",
      description: "Patch discountAmount, notes, and/or isActive (set false to deactivate).",
      security: platformSecurity,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody(
        {
          type: "object",
          properties: {
            discountAmount: { type: "number", minimum: 0 },
            notes: { type: "string", nullable: true, maxLength: 500 },
            isActive: { type: "boolean" },
          },
        },
        false
      ),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/plans": {
    get: {
      tags: ["SaaS Admin", "Plans"],
      summary: "List effective plan catalog",
      description:
        "Returns effective plans (`PLAN_CATALOG` + `PlatformSettings.planOverrides`) and a **read-only** `pricing` snapshot from environment variables. " +
        "**Editable via PUT:** `planName` and `limits` only. " +
        "**Not editable here:** term base prices (`SUBSCRIPTION_BASE_PRICE_*`), plan multipliers, extra branch/user prices, onboarding fee, referral discount, GST — those stay env-backed.",
      security: platformSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            plans: { type: "array", items: { type: "object", additionalProperties: true } },
            overrides: { type: "object", additionalProperties: true },
            pricing: {
              type: "object",
              description: "Read-only env pricing (term bases, multipliers, add-ons).",
              additionalProperties: true,
            },
          },
        }),
        ...commonErrorResponses(),
      },
    },
    put: {
      tags: ["SaaS Admin", "Plans"],
      summary: "Update plan display names and limits",
      description:
        "Partial overrides per `planCode` for **display name** and **limits** only. Does not remove enum plans. " +
        "Term base prices and add-ons are **not** accepted — they continue to come from backend environment variables. " +
        "Response includes the same read-only `pricing` snapshot as GET.",
      security: platformSecurity,
      requestBody: jsonBody({
        type: "object",
        properties: {
          planOverrides: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                planName: { type: "string" },
                limits: {
                  type: "object",
                  properties: {
                    maxBranches: { type: "integer", nullable: true },
                    maxStaff: { type: "integer", nullable: true },
                    maxCustomers: { type: "integer", nullable: true },
                  },
                },
              },
            },
          },
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            plans: { type: "array", items: { type: "object", additionalProperties: true } },
            overrides: { type: "object", additionalProperties: true },
            pricing: { type: "object", additionalProperties: true },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/settings": {
    get: {
      tags: ["SaaS Admin", "Settings"],
      summary: "Get platform settings",
      description: "Trial/billing defaults merged with env fallbacks. Never returns provider secrets.",
      security: platformSecurity,
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
    put: {
      tags: ["SaaS Admin", "Settings"],
      summary: "Update platform settings",
      description: "Upserts PlatformSettings singleton. Rejects Twilio/Resend secret fields.",
      security: platformSecurity,
      requestBody: jsonBody(
        {
          type: "object",
          properties: {
            trialDaysDefault: { type: "integer", minimum: 1, maximum: 90 },
            defaultTermMonths: { type: "integer", enum: [1, 3, 12, 24, 36, 60] },
            defaultGstPercent: { type: "number", minimum: 0, maximum: 100 },
            defaultContactUsUrl: { type: "string", nullable: true },
            defaultContactPhone: { type: "string", nullable: true },
            defaultUpgradeUrl: { type: "string", nullable: true },
          },
        },
        false
      ),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/messaging": {
    get: {
      tags: ["SaaS Admin", "Messaging"],
      summary: "Platform messaging provider status",
      description: "Read-only capability flags from env (no secrets returned).",
      security: platformSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            smsEnabled: { type: "boolean" },
            whatsappEnabled: { type: "boolean" },
            emailEnabled: { type: "boolean" },
            mailFromSet: { type: "boolean" },
            twilioFromSet: { type: "boolean" },
            smsSenderMode: { type: "string", nullable: true, enum: ["messaging_service", "sms_sender", "phone_number"] },
            smsStatusCallbackConfigured: { type: "boolean" },
            twilioWhatsappFromSet: { type: "boolean" },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/messaging/sms/{sid}": {
    get: {
      tags: ["SaaS Admin", "Messaging"],
      summary: "Look up outbound SMS delivery status",
      description: "Platform authentication required. Returns provider delivery metadata only, not recipient or content. Sent/queued/accepted do not confirm handset delivery.",
      security: platformSecurity,
      parameters: [{ name: "sid", in: "path", required: true, schema: { type: "string", pattern: "^SM[0-9a-fA-F]{32}$" } }],
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            sid: { type: "string" }, status: { type: "string" }, delivered: { type: "boolean" },
            errorCode: { type: "integer", nullable: true }, errorMessage: { type: "string", nullable: true },
          },
        }),
        ...commonErrorResponses(),
        "502": { description: "Provider status lookup failed" },
        "503": { description: "Twilio account not configured" },
      },
    },
  },
  "/api/platform/messaging/test": {
    post: {
      tags: ["SaaS Admin", "Messaging"],
      summary: "Send a platform provider test message",
      description: "Platform authentication required. SMS body must match approved wording for the domestic India route. Successful SMS/WhatsApp submissions return sid/status; acceptance is not proof of delivery.",
      security: platformSecurity,
      requestBody: jsonBody({
        type: "object", required: ["channel", "to"],
        properties: {
          channel: { type: "string", enum: ["sms", "whatsapp", "email"] },
          to: { type: "string" },
          body: { type: "string", description: "Optional text. SMS uses TWILIO_SMS_TEST_BODY or default when omitted; SMS/WhatsApp maximum 1600, email maximum 20000 characters." },
          subject: { type: "string", maxLength: 200, description: "Email only" },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
        "502": { description: "Provider send failed" },
        "503": { description: "Channel is not configured" },
      },
    },
  },
  "/api/platform/organizations/{orgId}/subscription/convert-trial": {
    post: {
      tags: ["SaaS Admin"],
      summary: "Convert trial subscription to paid term",
      description:
        "PLATFORM_OWNER only. Moves TRIAL → ACTIVE. Set markPaid=true for manual activation without a payment gateway. " +
        "Does not invent gateway charges.",
      security: platformSecurity,
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: jsonBody({
        type: "object",
        properties: {
          termMonths: { type: "integer", enum: [1, 3, 12, 24, 36, 60] },
          planCode: { type: "string" },
          markPaid: { type: "boolean" },
          notes: { type: "string" },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}/suspend": {
    post: {
      tags: ["SaaS Admin"],
      summary: "Suspend organization subscription",
      security: platformSecurity,
      parameters: [orgIdParam],
      requestBody: jsonBody({ type: "object", required: ["reason"], properties: { reason: { type: "string", minLength: 1, maxLength: 500 } } }),
      responses: {
        "200": okResponse({ type: "object", properties: { suspended: { type: "boolean" }, reason: { type: "string" } } }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/platform/organizations/{orgId}/restore": {
    post: {
      tags: ["SaaS Admin"],
      summary: "Restore suspended organization subscription",
      security: platformSecurity,
      parameters: [orgIdParam],
      requestBody: jsonBody({ type: "object", properties: { reason: { type: "string", maxLength: 500 } } }, false),
      responses: {
        "200": okResponse({ type: "object", properties: { restored: { type: "boolean" } } }),
        ...commonErrorResponses(),
      },
    },
  },
};

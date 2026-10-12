import {
  bearerSecurity,
  commonErrorResponses,
  jsonBody,
  okResponse,
  ref,
  type OpenApiPaths,
} from "../helpers.js";

export const authPaths: OpenApiPaths = {
  "/api/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Password login",
      description: "Public. Returns JWT + user + branch.",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", format: "password" },
        },
      }),
      responses: {
        "200": okResponse(ref("AuthSuccess")),
        ...commonErrorResponses({
          "401": { description: "Invalid email or password" },
        }),
      },
    },
  },
  "/api/auth/otp/send": {
    post: {
      tags: ["Auth"],
      summary: "Send login OTP (SMS)",
      description: "Public. Sends OTP to an active staff phone (10 digits). Per-phone 60-second resend cooldown and five requests per ten-minute window, per process. Production requires SMS configuration; provider acceptance is not delivery confirmation.",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["phone"],
        properties: { phone: { type: "string", pattern: "^\\d{10}$" } },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses({
          "404": { description: "No active user for phone" },
          "429": { description: "OTP request rate limit exceeded" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        }),
      },
    },
  },
  "/api/auth/otp/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify login OTP",
      description: "Public. Returns AuthSuccess after a valid single-use OTP. Five incorrect attempts invalidate the code. Demo bypass is disabled in production.",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["phone", "code"],
        properties: {
          phone: { type: "string", pattern: "^\\d{10}$" },
          code: { type: "string", minLength: 4, maxLength: 16 },
        },
      }),
      responses: {
        "200": okResponse(ref("AuthSuccess")),
        ...commonErrorResponses({
          "401": { description: "Invalid or expired OTP" },
        }),
      },
    },
  },
  "/api/auth/forgot-password": {
    post: {
      tags: ["Auth"],
      summary: "Request password reset email",
      description:
        "Public. Always returns a generic success message (does not reveal whether the email exists).",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        "503": { $ref: "#/components/responses/ServiceUnavailable" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/auth/reset-password/status": {
    get: {
      tags: ["Auth"],
      summary: "Check reset token validity",
      description: "Public. Query `token` — whether a reset can still complete once.",
      security: [],
      parameters: [
        {
          name: "token",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 24 },
        },
      ],
      responses: {
        "200": okResponse({
          type: "object",
          properties: { pending: { type: "boolean" } },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/auth/reset-password": {
    post: {
      tags: ["Auth"],
      summary: "Complete password reset",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["token", "password"],
        properties: {
          token: { type: "string", minLength: 24 },
          password: {
            type: "string",
            format: "password",
            description: "Strong password policy applies",
          },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/auth/change-password": {
    post: {
      tags: ["Auth"],
      summary: "Change password (authenticated)",
      description: "Requires JWT. Returns refreshed AuthSuccess.",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["currentPassword", "newPassword"],
        properties: {
          currentPassword: { type: "string", format: "password" },
          newPassword: { type: "string", format: "password" },
        },
      }),
      responses: {
        "200": okResponse(ref("AuthSuccess")),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Current user session payload",
      security: bearerSecurity,
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update own profile (name/avatar)",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          avatar: { type: "string", nullable: true, maxLength: 4096 },
        },
      }),
      responses: {
        "200": okResponse(ref("AuthSuccess")),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/auth/me/report-favourites": {
    get: {
      tags: ["Auth"],
      summary: "List favourite report hrefs for the current user",
      security: bearerSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            hrefs: { type: "array", items: { type: "string" } },
          },
        }),
        ...commonErrorResponses(),
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace favourite report hrefs for the current user",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["hrefs"],
        properties: {
          hrefs: { type: "array", items: { type: "string" }, maxItems: 200 },
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            hrefs: { type: "array", items: { type: "string" } },
          },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/auth/me/avatar": {
    post: {
      tags: ["Auth"],
      summary: "Upload own avatar image",
      description: "multipart field `avatar` (image file).",
      security: bearerSecurity,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["avatar"],
              properties: { avatar: { type: "string", format: "binary" } },
            },
          },
        },
      },
      responses: {
        "200": okResponse(ref("AuthSuccess")),
        ...commonErrorResponses(),
      },
    },
  },
};

export const healthPaths: OpenApiPaths = {
  "/": {
    get: {
      tags: ["Health"],
      summary: "API root metadata",
      security: [],
      responses: {
        "200": {
          description: "Service identity + endpoint hints",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  name: { type: "string" },
                  hint: { type: "string" },
                  frontend: { type: "string" },
                  endpoints: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/health": {
    get: {
      tags: ["Health"],
      summary: "Liveness",
      security: [],
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
  },
  "/api/health": {
    get: {
      tags: ["Health"],
      summary: "Liveness (API prefix alias)",
      description: "Same as `GET /health`.",
      security: [],
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
  },
  "/health/db": {
    get: {
      tags: ["Health"],
      summary: "Database connectivity",
      security: [],
      responses: {
        "200": {
          description: "DB up",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  database: { type: "string" },
                },
              },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalError" },
      },
    },
  },
  "/api/health/db": {
    get: {
      tags: ["Health"],
      summary: "Database connectivity (API prefix alias)",
      description: "Same as `GET /health/db`.",
      security: [],
      responses: {
        "200": {
          description: "DB up",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  database: { type: "string" },
                },
              },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalError" },
      },
    },
  },
};

export const publicPaths: OpenApiPaths = {
  "/api/public/invoices/{id}": {
    get: {
      tags: ["Public"],
      summary: "Public invoice view",
      description: "No auth. Customer-facing invoice payload by id.",
      security: [],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/branding": {
    get: {
      tags: ["Public"],
      summary: "Public branding assets",
      security: [],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/signup": {
    post: {
      tags: ["Public"],
      summary: "Self-serve trial signup (provision organization)",
      description:
        "No auth. Creates Organization + HQ branch + SUPER_ADMIN owner + TRIAL subscription. " +
        "Returns JWT for immediate workshop login. Rate-limited by IP. " +
        "Accepts website fields (businessName/ownerName) or legacy aliases (companyName/name).",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["email", "phone", "password"],
        properties: {
          businessName: { type: "string", minLength: 1, maxLength: 160 },
          ownerName: { type: "string", minLength: 1, maxLength: 120 },
          companyName: { type: "string", minLength: 1, maxLength: 160, description: "Alias of businessName" },
          name: { type: "string", minLength: 1, maxLength: 120, description: "Alias of ownerName" },
          email: { type: "string", format: "email" },
          phone: { type: "string", minLength: 7, maxLength: 20 },
          password: { type: "string", format: "password", description: "Strong password policy" },
          branchName: { type: "string", maxLength: 120 },
          planCode: { type: "string", example: "STARTER" },
          referralCode: { type: "string", nullable: true },
          message: { type: "string", maxLength: 2000 },
          source: { type: "string", maxLength: 80 },
        },
        example: {
          businessName: "DetailPro Studio",
          ownerName: "Amit Kumar",
          email: "amit@detailpro.in",
          phone: "9876543210",
          password: "ChangeMe!Owner1",
          branchName: "HQ",
          planCode: "STARTER",
          source: "website-pricing-page",
        },
      }),
      responses: {
        "201": okResponse({
          type: "object",
          properties: {
            accessToken: { type: "string" },
            organizationId: { type: "string" },
            user: { type: "object", additionalProperties: true },
            branch: { type: "object", additionalProperties: true },
            subscription: { type: "object", additionalProperties: true },
          },
          required: ["accessToken", "organizationId", "user"],
        }),
        "409": { description: "Email already exists" },
        "429": { description: "Too many requests" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/contact": {
    post: {
      tags: ["Public"],
      summary: "Submit public contact request",
      description:
        "No auth. Captures customer/support/contact-us enquiries. Rate-limited by IP.",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["name", "message"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          email: { type: "string", format: "email" },
          phone: { type: "string", minLength: 7, maxLength: 20 },
          subject: { type: "string", maxLength: 200 },
          message: { type: "string", minLength: 1, maxLength: 2000 },
          source: { type: "string", maxLength: 80 },
        },
        example: {
          name: "Neha Sharma",
          email: "neha@autospashine.com",
          phone: "+919812345678",
          subject: "Product demo request",
          message: "Please call me for a quick demo this week.",
          source: "landing-contact-form",
        },
      }),
      responses: {
        "201": okResponse({
          type: "object",
          properties: {
            ok: { type: "boolean" },
            id: { type: "string" },
          },
          required: ["ok", "id"],
          example: { ok: true, id: "contact-mec90bx2-jv7m9n" },
        }),
        "429": { description: "Too many requests" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/plans": {
    get: {
      tags: ["Public"],
      summary: "Public plan catalog",
      description: "No auth. Returns public-visible plans and pricing snapshot from platform settings.",
      security: [],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/pricing/quote": {
    post: {
      tags: ["Public"],
      summary: "Get anonymous subscription pricing quote",
      description:
        "No auth. Returns pricing for public calculator use. Rate-limited by IP.",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["termMonths"],
        properties: {
          planCode: {
            type: "string",
            enum: ["STARTER", "GROWTH", "BUSINESS", "ENTERPRISE", "CUSTOM"],
            default: "STARTER",
          },
          termMonths: { type: "integer", enum: [1, 3, 12, 24, 36, 60] },
          extraBranches: { type: "integer", minimum: 0, default: 0 },
          extraUsers: { type: "integer", minimum: 0, default: 0 },
          referralCode: { type: "string", nullable: true, maxLength: 32 },
          isFirstSubscription: { type: "boolean", default: true },
        },
        example: {
          planCode: "GROWTH",
          termMonths: 12,
          extraBranches: 1,
          extraUsers: 4,
          referralCode: "PARTNER1000",
          isFirstSubscription: true,
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            breakdown: { type: "object", additionalProperties: true },
          },
          required: ["breakdown"],
          example: {
            breakdown: {
              planCode: "GROWTH",
              planName: "Growth",
              termMonths: 12,
              termLabel: "1 year",
              baseAmount: 17998.2,
              extraBranchCost: 2500,
              extraUserCost: 3000,
              referralDiscount: 1000,
              gstPercent: 18,
              gstAmount: 4049.68,
              finalAmount: 26547.88,
              currency: "INR",
            },
          },
        }),
        "429": { description: "Too many requests" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/subscription/pricing": {
    post: {
      tags: ["Public"],
      summary: "Get anonymous subscription pricing quote (alias)",
      description:
        "Alias of /api/public/pricing/quote for compatibility.",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["termMonths"],
        properties: {
          planCode: {
            type: "string",
            enum: ["STARTER", "GROWTH", "BUSINESS", "ENTERPRISE", "CUSTOM"],
            default: "STARTER",
          },
          termMonths: { type: "integer", enum: [1, 3, 12, 24, 36, 60] },
          extraBranches: { type: "integer", minimum: 0, default: 0 },
          extraUsers: { type: "integer", minimum: 0, default: 0 },
          referralCode: { type: "string", nullable: true, maxLength: 32 },
          isFirstSubscription: { type: "boolean", default: true },
        },
        example: {
          planCode: "STARTER",
          termMonths: 24,
          extraBranches: 0,
          extraUsers: 2,
          referralCode: null,
          isFirstSubscription: false,
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            breakdown: { type: "object", additionalProperties: true },
          },
          required: ["breakdown"],
          example: {
            breakdown: {
              planCode: "STARTER",
              planName: "Starter",
              termMonths: 24,
              termLabel: "2 years",
              baseAmount: 18999,
              extraBranchCost: 0,
              extraUserCost: 1500,
              referralDiscount: 0,
              gstPercent: 18,
              gstAmount: 3698.82,
              finalAmount: 24197.82,
              currency: "INR",
            },
          },
        }),
        "429": { description: "Too many requests" },
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/attendance/context": {
    get: {
      tags: ["Attendance"],
      summary: "Public attendance QR context",
      description: "No auth. Staff scan branch QR on personal phones.",
      security: [],
      parameters: [
        { name: "branchId", in: "query", required: true, schema: { type: "string" } },
        { name: "qr", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/attendance/resolve-pin": {
    post: {
      tags: ["Attendance"],
      summary: "Resolve staff by attendance PIN",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["branchId", "pin"],
        properties: {
          branchId: { type: "string" },
          pin: { type: "string" },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/public/attendance/punch": {
    post: {
      tags: ["Attendance"],
      summary: "Public check-in / check-out punch",
      security: [],
      requestBody: jsonBody({
        type: "object",
        required: ["staffId", "branchId"],
        properties: {
          staffId: { type: "string" },
          branchId: { type: "string" },
          clientLocalDate: { type: "string" },
          clientLocalTime: { type: "string" },
        },
      }),
      responses: {
        "200": okResponse({ type: "object", additionalProperties: true }),
        ...commonErrorResponses(),
      },
    },
  },
};

export const attendanceAdminPaths: OpenApiPaths = {
  "/api/attendance": {
    get: {
      tags: ["Attendance"],
      summary: "List attendance records (admin)",
      description: "Requires ATTENDANCE permission. Optional `branchId` query filter.",
      security: bearerSecurity,
      parameters: [
        { name: "branchId", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": okResponse({
          type: "object",
          properties: {
            records: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        }),
        ...commonErrorResponses(),
      },
    },
    post: {
      tags: ["Attendance"],
      summary: "Create or update attendance record (manual admin entry)",
      description:
        "Requires ATTENDANCE permission. Creates a new record or updates an existing one for the same staffId + date combination. " +
        "Use this for manual corrections or entries when QR punch was missed.",
      security: bearerSecurity,
      requestBody: jsonBody({
        type: "object",
        required: ["staffId", "date", "status"],
        properties: {
          staffId: { type: "string", description: "User ID of the staff member" },
          date: { type: "string", format: "date", description: "yyyy-MM-dd" },
          checkIn: { type: "string", nullable: true, description: "HH:mm" },
          checkOut: { type: "string", nullable: true, description: "HH:mm" },
          durationMinutes: { type: "integer", nullable: true },
          status: { type: "string", enum: ["PRESENT", "ABSENT", "LATE", "HALF_DAY"] },
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          properties: { record: { type: "object", additionalProperties: true } },
        }),
        ...commonErrorResponses(),
      },
    },
    delete: {
      tags: ["Attendance"],
      summary: "Reset all attendance records (admin bulk delete)",
      description: "Requires ATTENDANCE permission. Deletes ALL records. Irreversible.",
      security: bearerSecurity,
      responses: {
        "200": okResponse({
          type: "object",
          properties: { ok: { type: "boolean" }, records: { type: "array", items: {} } },
        }),
        ...commonErrorResponses(),
      },
    },
  },
  "/api/attendance/{id}": {
    put: {
      tags: ["Attendance"],
      summary: "Update attendance record by record ID",
      description: "Requires ATTENDANCE permission. Updates an existing attendance record.",
      security: bearerSecurity,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({
        type: "object",
        required: ["staffId", "date", "status"],
        properties: {
          staffId: { type: "string" },
          date: { type: "string", format: "date" },
          checkIn: { type: "string", nullable: true },
          checkOut: { type: "string", nullable: true },
          durationMinutes: { type: "integer", nullable: true },
          status: { type: "string", enum: ["PRESENT", "ABSENT", "LATE", "HALF_DAY"] },
        },
      }),
      responses: {
        "200": okResponse({
          type: "object",
          properties: { record: { type: "object", additionalProperties: true } },
        }),
        ...commonErrorResponses(),
      },
    },
  },
};

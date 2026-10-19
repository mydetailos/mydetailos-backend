import "dotenv/config";
import path from "node:path";
import compression from "compression";
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { customerRouter } from "./modules/customers/customer.routes.js";
import { bootstrapRouter } from "./modules/bootstrap/bootstrap.routes.js";
import { collectionRouter } from "./modules/collections/collection.routes.js";
import { quotationRouter } from "./modules/quotations/quotation.routes.js";
import { branchApiRouter } from "./modules/branches/branch-api.routes.js";
import { userApiRouter } from "./modules/users/user-api.routes.js";
import { vehicleApiRouter } from "./modules/vehicles/vehicle-api.routes.js";
import { errorHandler } from "./middleware/error-handler.js";
import { isTwilioSmsEnabled, isTwilioWhatsAppEnabled } from "./services/twilio-sms.service.js";
import { isPasswordResetEmailConfigured } from "./modules/auth/password-reset-email.service.js";
import { messagingRouter } from "./routes/messaging.routes.js";
import { jobCardsRouter } from "./modules/job-cards/job-cards.routes.js";
import { invoicesRouter } from "./modules/invoices/invoices.routes.js";
import { inspectionTemplatesRouter, inspectionsRouter } from "./modules/inspections/inspections.routes.js";
import { publicAttendanceRouter } from "./routes/public-attendance.routes.js";
import { attendanceRouter } from "./routes/attendance.routes.js";
import { partyRouter } from "./modules/parties/party.routes.js";
import { organizationRouter } from "./modules/organization/organization.routes.js";
import { platformRouter } from "./modules/platform/platform.routes.js";
import { jobsRouter } from "./modules/jobs/jobs.routes.js";
import { rewardsRouter } from "./modules/rewards/rewards.routes.js";
import { customerAuthRouter } from "./modules/customers/customer-auth.routes.js";
import { customerBootstrapRouter } from "./modules/customers/customer-bootstrap.routes.js";
import { customerInspectionsRouter } from "./modules/customers/customer-inspections.routes.js";
import { membershipRouter } from "./modules/membership/membership.routes.js";
import { isSwaggerEnabled, registerSwagger } from "./docs/register-swagger.js";
import { publicRouter } from "./routes/public.routes.js";
import { webhooksRouter } from "./routes/webhooks.routes.js";

import { prisma } from "./lib/prisma.js";
import { getPublicInvoiceView } from "./modules/invoices/public-invoice.service.js";
import { getPublicBranding } from "./services/public-branding.service.js";
import { getPublicCustomerLedger } from "./modules/parties/public-ledger.service.js";
import { verifyJobCardSecureToken } from "./lib/secure-token.js";
import { getCollectionItem } from "./modules/collections/app-json-store.js";
import { AppError } from "./lib/app-error.js";
import { perfMiddleware } from "./middleware/perf.js";
import { isRazorpayEnabled } from "./lib/razorpay.js";

const app = express();

app.use(perfMiddleware);
app.use(compression());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      const defaults = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://localhost:3003",
        "http://localhost:3005",
      ];
      const allowed = (env.FRONTEND_ORIGIN ?? defaults.join(","))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const isLocalhost =
        /^http:\/\/localhost:\d+$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
      // Vercel preview / production aliases + My Detail OS custom domain.
      const isAllowedVercelPreview =
        /^https:\/\/my-detail-os-website(?:-[a-z0-9]+)?(?:-amarkumarsbgs-projects)?\.vercel\.app$/.test(
          origin
        ) ||
        /^https:\/\/my-detail-os(?:-[a-z0-9]+)?(?:-amarkumarsbgs-projects)?\.vercel\.app$/.test(
          origin
        ) ||
        /^https:\/\/[a-z0-9-]+-amarkumarsbgs-projects\.vercel\.app$/.test(origin);
      const isMyDetailOs =
        /^https:\/\/(www\.)?mydetailos\.com$/.test(origin) ||
        /^https:\/\/[a-z0-9-]+\.mydetailos\.com$/.test(origin);
      const ok =
        allowed.includes(origin) ||
        isAllowedVercelPreview ||
        isMyDetailOs ||
        (process.env.NODE_ENV !== "production" && isLocalhost);
      cb(null, ok ? origin : false);
    },
    credentials: true,
  })
);

/** Razorpay webhooks need the raw body for signature verification. */
app.use(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  webhooksRouter
);

/** Invoice email attaches base64 PDFs; default 100kb limit causes "request entity too large". */
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

const uploadsRoot = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsRoot, { maxAge: 7 * 24 * 60 * 60 * 1000 }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "My Detail OS API",
    hint: "Use the Next.js app in your browser (usually port 3000), not this URL alone.",
    frontend: env.FRONTEND_ORIGIN,
    endpoints: {
      health: "/health",
      healthApi: "/api/health",
      healthDb: "/health/db",
      healthDbApi: "/api/health/db",
      api: "/api",
      ...(isSwaggerEnabled()
        ? { docs: "/api/docs", openapi: "/api/docs/openapi.json" }
        : {}),
    },
  });
});

/** OpenAPI / Swagger UI — disabled in production unless SWAGGER_ENABLED=true */
registerSwagger(app);

app.get("/health", (_req, res) => {
  res.json({ ok: true, payments: isRazorpayEnabled() ? "razorpay" : "manual" });
});

app.get("/health/db", async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: "up" });
  } catch (e) {
    next(e);
  }
});

/** Aliases under /api for clients that expect the API prefix. */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/health/db", async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: "up" });
  } catch (e) {
    next(e);
  }
});

app.get("/api/public/invoices/:id", async (req, res, next) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!;
    const data = await getPublicInvoiceView(id);
    res.json({ data, error: null });
  } catch (e) {
    next(e);
  }
});

app.get("/api/public/job-cards/:secureToken/photos", async (req, res, next) => {
  try {
    const secureToken = Array.isArray(req.params.secureToken)
      ? req.params.secureToken[0]!
      : req.params.secureToken!;
    
    const jobCardId = verifyJobCardSecureToken(secureToken);
    if (!jobCardId) {
      throw AppError.forbidden("Invalid or expired photos link");
    }

    const jobCardRaw = (await getCollectionItem("jobCards", jobCardId)) as Record<string, any> | null;
    if (!jobCardRaw) {
      throw AppError.notFound("Job Card not found");
    }

    // Pick only public-safe fields
    const jobCard = {
      id: jobCardRaw.id,
      jobNumber: jobCardRaw.jobNumber,
      customerName: jobCardRaw.customerName,
      vehicleMakeModel: jobCardRaw.vehicleMakeModel,
      vehicleRegNumber: jobCardRaw.vehicleRegNumber,
      status: jobCardRaw.status,
      inspectionPhotos: jobCardRaw.inspectionPhotos ?? [],
    };

    const settingsRow = await prisma.appJsonRow.findUnique({
      where: { collection_entityId: { collection: "appSettings", entityId: "default" } },
    });
    const settingsPayload =
      settingsRow?.payload && typeof settingsRow.payload === "object"
        ? (settingsRow.payload as Record<string, any>)
        : null;

    const businessSettings = {
      businessName: settingsPayload?.businessName ?? "My Detail OS",
      logoUrl: settingsPayload?.logoUrl ?? null,
    };

    res.json({
      data: {
        jobCard,
        businessSettings,
      },
      error: null,
    });
  } catch (e) {
    next(e);
  }
});

app.get("/api/public/ledgers/:customerId", async (req, res, next) => {
  try {
    const customerId = Array.isArray(req.params.customerId)
      ? req.params.customerId[0]!
      : req.params.customerId!;
    const period =
      typeof req.query.period === "string" && req.query.period.trim()
        ? req.query.period.trim()
        : "last365";
    const data = await getPublicCustomerLedger(customerId, period);
    res.json({ data, error: null });
  } catch (e) {
    next(e);
  }
});

app.get("/api/public/branding", async (req, res, next) => {
  try {
    const slug =
      typeof req.query.slug === "string"
        ? req.query.slug
        : Array.isArray(req.query.slug)
          ? String(req.query.slug[0] ?? "")
          : "";
    const data = await getPublicBranding(slug || undefined);
    res.json({ data, error: null });
  } catch (e) {
    next(e);
  }
});

app.get("/api/public/organizations/by-slug/:slug", async (req, res, next) => {
  try {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0]! : req.params.slug!;
    const { getOrganizationBySlug } = await import("./services/organization-public.service.js");
    const data = await getOrganizationBySlug(slug);
    res.json({ data, error: null });
  } catch (e) {
    next(e);
  }
});

app.use("/api/auth", authRouter);
app.use("/api/job-cards", jobCardsRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/inspections", inspectionsRouter);
app.use("/api/inspection-templates", inspectionTemplatesRouter);
app.use("/api/customers", customerRouter);
app.use("/api/bootstrap", bootstrapRouter);
app.use("/api/collections", collectionRouter);
app.use("/api/quotations", quotationRouter);
app.use("/api/branches", branchApiRouter);
app.use("/api/users", userApiRouter);
app.use("/api/vehicles", vehicleApiRouter);
app.use("/api/messaging", messagingRouter);
app.use("/api/public", publicRouter);
app.use("/api/public/attendance", publicAttendanceRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/parties", partyRouter);
app.use("/api/organization", organizationRouter);
app.use("/api/platform", platformRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/rewards", rewardsRouter);
app.use("/api/auth/customer", customerAuthRouter);
app.use("/api/customer", customerBootstrapRouter);
app.use("/api/customer/inspections", customerInspectionsRouter);
app.use("/api/membership", membershipRouter);
app.use("/api/v1/membership", membershipRouter);

app.use(errorHandler);

import { ensurePlatformOwner } from "./modules/platform/ensure-platform-owner.service.js";

const isProduction = process.env.NODE_ENV === "production";

function shouldEnsurePlatformOwnerOnBoot(): boolean {
  const raw = process.env.PLATFORM_OWNER_ENSURE_ON_BOOT?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  /** Default on so free-tier Render (no Shell) can create vendor login from env alone. */
  return true;
}

app.listen(env.PORT, () => {
  if (isProduction) {
    console.log(`API listening on port ${env.PORT}`);
    if (!isPasswordResetEmailConfigured()) {
      console.warn(
        "[email] RESEND_API_KEY is not set — forgot-password will return 503 until email is configured."
      );
    }
  } else {
    console.log(`API listening on http://localhost:${env.PORT}`);
    if (isTwilioSmsEnabled()) {
      const sid = env.TWILIO_ACCOUNT_SID ?? "";
      const viaApiKey = Boolean(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET);
      console.log(
        `[twilio] SMS enabled (auth: ${viaApiKey ? "API key" : "Auth Token"}, Account SID …${sid.slice(-6)})`
      );
    }
    if (isTwilioWhatsAppEnabled()) {
      const wa = env.TWILIO_WHATSAPP_FROM ?? "";
      console.log(`[twilio] WhatsApp outbound enabled (sender …${wa.slice(-8)})`);
    }
    if (isPasswordResetEmailConfigured()) {
      console.log("[email] Password reset via Resend is enabled (RESEND_API_KEY set).");
    } else {
      console.log(
        "[email] RESEND_API_KEY not set — forgot-password prints reset links in this terminal (dev only)."
      );
    }
  }

  if (shouldEnsurePlatformOwnerOnBoot()) {
    const syncPassword =
      process.env.PLATFORM_OWNER_SYNC_PASSWORD?.trim().toLowerCase() !== "false";
    void ensurePlatformOwner({ syncPassword })
      .then((r) => {
        console.info(`[saas] PLATFORM_OWNER ${r.action}: ${r.email}`);
      })
      .catch((err) => {
        console.warn(
          "[saas] Could not ensure PLATFORM_OWNER (org/branch/schema may be missing):",
          err instanceof Error ? err.message : err
        );
      });
  }
});
# My Detail OS — Backend API

Express + TypeScript + Prisma + PostgreSQL backend serving both the Workshop App and SaaS Admin Portal.

## Architecture

```
my-detail-os-workshop  ──┐
                          ├──> my-detail-os-api (this repo)  ──> PostgreSQL
my-detail-os-admin     ──┘
```

## Setup

```bash
cp env.example .env        # fill in required values
npm install
npx prisma generate
npm run dev
```

Backend: **http://localhost:4000**  
Swagger: **http://localhost:4000/api/docs/**

## Environment Variables

See [`env.example`](./env.example) for all variables with descriptions. Required:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing JWTs |
| `PORT` | Server port (default `4000`) |
| `FRONTEND_ORIGIN` | Comma-separated CORS origins |

Optional: `RESEND_API_KEY`, `TWILIO_*`, `S3_*`, `PLATFORM_ADMIN_API_KEY`

## SMS Setup

See [Twilio SMS setup](docs/twilio-sms.md) for sender/Messaging Service configuration, India DLT onboarding, OTP templates, delivery callbacks, and troubleshooting. WhatsApp registration alone does not enable SMS.

```bash
npm run test:sms       # mocked sends, webhook signatures, OTP safeguards; no real SMS
```

## Database

```bash
npm run db:up          # start local Postgres via Docker
# If 5432 is occupied locally, set POSTGRES_PORT=5433 in .env before starting Docker.
npx prisma generate    # regenerate Prisma client
npm run db:migrate     # run pending migrations
npm run db:seed        # seed initial data
```

## Scripts

```bash
npm run dev            # development with hot reload (tsx watch)
npm run build          # compile TypeScript → dist/
npm start              # run compiled production build
```

## Tests

```bash
npm run test:security  # run all security/permission/scope tests
npm run test:plan-catalog
npm run test:subscription-lock
npm run test:referral-eligibility
```

## CORS

Both Workshop App and SaaS Admin are supported via `FRONTEND_ORIGIN` (comma-separated).  
Local dev: `http://localhost:3000,http://localhost:3001`  
Production: `https://app.mydetailos.com,https://admin.mydetailos.com`

## Swagger

Available at `/api/docs/` when `NODE_ENV !== production` (or `SWAGGER_ENABLED=true`).

## Auth

- `POST /api/auth/login` — email/password → JWT
- `POST /api/auth/otp/send` + `/verify` — OTP login
- `PLATFORM_OWNER` role required for `/api/platform/*` endpoints
- `X-Platform-Admin-Key` header as alternative for platform endpoints

## Deployment

1. Set all required env vars on your host
2. `npm run build`
3. `npm start`
4. Run `npx prisma migrate deploy` before first start (or on schema changes)

# Twilio SMS setup

This integration uses the existing Twilio SDK and credentials. WhatsApp configuration/sending are unchanged. Application code does not purchase or activate a sender or perform DLT approval.

## Sender and India routing

Twilio's [India SMS guidelines](https://www.twilio.com/en-us/guidelines/in/sms) distinguish:

- **Domestic:** register your business, header and relevant templates on an operator DLT platform, complete the applicable entity/telemarketer chain, then complete Twilio sender/template onboarding. Confirm eligibility for your account/use case. Use registered alphanumeric senders only for their approved message category and match approved wording/variables exactly.
- **International:** Twilio currently states DLT is not required on its international route. Sender IDs may be rewritten to operator-approved short codes. Confirm business/account eligibility, permitted use, costs and routing with Twilio. Buying a foreign number is not domestic DLT approval.

Check current requirements with Twilio before rollout. A personal mobile number registered only for WhatsApp cannot automatically send SMS through Twilio.

Configure one sender option:

```dotenv
# Existing number-based sending:
TWILIO_FROM_NUMBER=+your_twilio_sms_capable_number
# Or an approved/onboarded SMS sender (example only):
TWILIO_SMS_FROM=MYDTOS
# Or an SMS Messaging Service with an approved sender pool:
TWILIO_SMS_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Precedence: Messaging Service, SMS sender, legacy phone number. With a Messaging Service, Twilio selects from its sender pool; the API does not also send `From`. An `HX` WhatsApp Content SID and a DLT Template ID are not `MG` Messaging Service SIDs.

## Credentials and wording

```dotenv
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SID=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SECRET=your_secret
TWILIO_TO_NUMBER_PREFIX=+91
# Example wording ONLY; replace with approved text on the domestic route:
TWILIO_SMS_OTP_TEMPLATE="Your My Detail OS login code is {code}. Valid 10 minutes. Do not share this code."
TWILIO_SMS_TEST_BODY="Your approved fixed test message"
```

Alternatively use `TWILIO_AUTH_TOKEN` instead of API-key credentials. Do not commit secrets or expose them in frontend/public variables. Keep `TWILIO_WHATSAPP_FROM` unchanged. Restart after environment changes. Trial accounts must verify recipients; enable destination-country SMS permissions and confirm billing/sending eligibility.

`{code}` is an application placeholder replaced by a four-digit OTP, not a DLT template ID. Without an override, the existing OTP wording is retained. Do not change approved punctuation, static text or variable positions without approval.

Existing owner notifications, payment links and other transactional SMS calls share this sender configuration. **Every domestic message pattern still needs relevant DLT registration and Twilio mapping.** OTP approval does not approve all notifications or free-form admin tests. Use approved explicit test `body` or omit it to use `TWILIO_SMS_TEST_BODY`.

DLT Entity/Template IDs are not invented parameters in the Twilio Messages API. Supply registrations through Twilio's current onboarding process and confirm matching with support. Twilio Content SIDs are separate from DLT approval.

## Delivery callbacks

```dotenv
TWILIO_SMS_STATUS_CALLBACK_URL=https://api.yourdomain.com/api/messaging/sms/status
TWILIO_AUTH_TOKEN=your_primary_account_auth_token
```

Use public HTTPS with the exact path above and no query, fragment or embedded credentials. The primary Auth Token is required for signature verification even with API-key sends. For local development, use an HTTPS tunnel to port 4000; localhost is not reachable by Twilio. Configure the same externally visible URL that Twilio signs.

Callbacks require SDK signature validation and a matching Account SID. They log only SID, status and numeric error code, never full payloads, bodies, recipients or OTPs. Events are not persisted in a new table. Use existing log aggregation for durable history; callbacks can arrive out of order.

## Sending and status lookup

Platform-owner/API-key authenticated endpoints:

- `GET /api/platform/messaging`: configuration flags, sender mode and callback readiness, not proof of sender approval.
- `POST /api/platform/messaging/test`: SMS submissions return `sid` and initial `status` alongside existing fields.
- `GET /api/platform/messaging/sms/{sid}`: current outbound SMS status; returns `sid`, `status`, `delivered`, `errorCode`, `errorMessage`, not recipients or content.

```json
{
  "channel": "sms",
  "to": "+917004509790",
  "body": "Replace this example with approved message text"
}
```

Workshop settings-admin test remains `POST /api/messaging/sms/test` with `{ "phone": "+917004509790" }`. It uses configured test wording and returns SID/status. Its communications log stores initial status/SID; callbacks do not rewrite that record. Use the platform lookup, callback logs or Twilio Console for subsequent status.

HTTP 200, `queued`, `accepted`, and `sent` do not confirm handset delivery. `sent` means upstream carrier acceptance; `delivered` means Twilio received delivery confirmation. Immediate provider failures return errors; delayed failures must be checked separately. There are no silent retries, avoiding duplicate send charges.

Check failure codes for sender approval, DLT matching, geographic permissions, trial recipient verification, account balance and carrier filtering. WhatsApp's 24-hour session rules do not apply to SMS.

## OTP security and deployment limits

- Cryptographic four-digit OTPs, ten-minute expiry, single use, invalidation after five incorrect attempts.
- One-minute resend cooldown, maximum five requests per phone per ten-minute window, HTTP 429 on limits. Failed lookup/send requests count too.
- Production sends return 503 without SMS configuration; no successful log-only fallback.
- Demo bypass is never accepted in production, even when configured. Set `LOGIN_OTP_DEMO_CODE=` to disable it in development.
- OTP and send-limit state remain in-memory per process, cleaned/bounded for normal issuance and reset on restart. They are not shared across replicas. Use shared storage, appropriate trusted-proxy/IP/edge abuse controls and Twilio spend safeguards before scaling. This is not a global account-wide throttle.

## Verify and activate

```bash
npm run test:sms
npm run build
```

Tests mock Twilio SDK transport and use local callback HTTP requests: no real SMS or credentials needed. A live delivery test still requires actual credentials, an approved sender/Messaging Service, geographic permissions and applicable DLT/template onboarding. No production settings or database schema are changed automatically.

References: [Messages API](https://www.twilio.com/docs/messaging/api/message-resource), [delivery tracking](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status), [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
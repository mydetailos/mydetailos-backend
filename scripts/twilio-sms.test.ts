import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import twilio from "twilio";
import express from "express";
import type { Server } from "node:http";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET = "sms-test-only-jwt-secret";
process.env.TWILIO_ACCOUNT_SID = `AC${"0".repeat(32)}`;
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_API_KEY_SID = `SK${"0".repeat(32)}`;
process.env.TWILIO_API_KEY_SECRET = "test-api-key-secret";
process.env.TWILIO_SMS_FROM = "";
process.env.TWILIO_SMS_MESSAGING_SERVICE_SID = "";
process.env.TWILIO_SMS_OTP_TEMPLATE = "";
process.env.TWILIO_SMS_STATUS_CALLBACK_URL = "";

const { env } = await import("../src/config/env.js");
const { isTwilioSmsEnabled, isTwilioWhatsAppEnabled, sendTransactionalSms, sendLoginOtpSms, getSmsMessageStatus } = await import("../src/services/twilio-sms.service.js");
const { messagingRouter } = await import("../src/routes/messaging.routes.js");
const { enforceLoginOtpSendLimit, issueLoginOtp, consumeLoginOtpIfValid, isDemoLoginOtp } = await import("../src/modules/auth/login-otp.service.js");

describe("Twilio SMS", () => {
  let requests: Record<string, unknown>[];
  let outcome: { sid: string; status: string; to?: string; direction?: string; error_code?: number; error_message?: string };

  beforeEach(() => {
    requests = [];
    outcome = { sid: `SM${"1".repeat(32)}`, status: "queued" };
    env.TWILIO_FROM_NUMBER = "+15555551234";
    env.TWILIO_SMS_FROM = undefined;
    env.TWILIO_SMS_MESSAGING_SERVICE_SID = undefined;
    env.TWILIO_SMS_OTP_TEMPLATE = undefined;
    env.TWILIO_SMS_STATUS_CALLBACK_URL = undefined;
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    mock.method(twilio.Twilio.prototype, "request", async (request: { data: Record<string, unknown> }) => {
      requests.push(request.data);
      return { statusCode: 201, body: outcome, headers: {} };
    });
  });

  afterEach(() => mock.restoreAll());

  it("preserves the legacy SMS sender and reports submission status", async () => {
    assert.equal(isTwilioSmsEnabled(), true);
    assert.deepEqual(await sendTransactionalSms("+917004509790", "Approved message"), { sid: outcome.sid, status: "queued" });
    assert.equal(requests[0].From, "+15555551234");
    assert.equal(requests[0].To, "+917004509790");
  });

  it("uses a Messaging Service without requiring a phone sender", async () => {
    env.TWILIO_FROM_NUMBER = undefined;
    env.TWILIO_SMS_MESSAGING_SERVICE_SID = `MG${"2".repeat(32)}`;
    assert.equal(isTwilioSmsEnabled(), true);
    await sendTransactionalSms("+917004509790", "Approved message");
    assert.equal(requests[0].MessagingServiceSid, env.TWILIO_SMS_MESSAGING_SERVICE_SID);
    assert.equal(requests[0].From, undefined);
  });

  it("uses the approved alphanumeric SMS sender without changing WhatsApp", async () => {
    env.TWILIO_SMS_FROM = "MYDTOS";
    env.TWILIO_WHATSAPP_FROM = "whatsapp:+919919366665";
    await sendTransactionalSms("+917004509790", "Approved message");
    assert.equal(requests[0].From, "MYDTOS");
    assert.equal(isTwilioWhatsAppEnabled(), true);
    assert.equal(env.TWILIO_WHATSAPP_FROM, "whatsapp:+919919366665");
  });

  it("renders configured OTP wording without changing its static text", async () => {
    env.TWILIO_SMS_OTP_TEMPLATE = "Your OTP is {code}. MYDTOS";
    await sendLoginOtpSms("+917004509790", "4821");
    assert.equal(requests[0].Body, "Your OTP is 4821. MYDTOS");
  });

  it("rejects malformed recipients and empty messages before contacting Twilio", async () => {
    await assert.rejects(sendTransactionalSms("7004509790", "Hi"), /E.164/);
    await assert.rejects(sendTransactionalSms("+917004509790", " "), /SMS body/);
    assert.equal(requests.length, 0);
  });

  it("does not treat an immediate delivery failure as success", async () => {
    outcome = { ...outcome, status: "undelivered", error_code: 30007, error_message: "Filtered" };
    await assert.rejects(sendTransactionalSms("+917004509790", "Approved message"), /30007/);
  });

  it("does not enable SMS from WhatsApp credentials alone", () => {
    env.TWILIO_FROM_NUMBER = undefined;
    env.TWILIO_WHATSAPP_FROM = "whatsapp:+919919366665";
    assert.equal(isTwilioSmsEnabled(), false);
  });

  it("passes the configured callback URL to Twilio", async () => {
    env.TWILIO_SMS_STATUS_CALLBACK_URL = "https://api.example.test/api/messaging/sms/status";
    await sendTransactionalSms("+917004509790", "Approved message");
    assert.equal(requests[0].StatusCallback, env.TWILIO_SMS_STATUS_CALLBACK_URL);
  });

  it("requires the account Auth Token for callback verification", async () => {
    env.TWILIO_SMS_STATUS_CALLBACK_URL = "https://api.example.test/api/messaging/sms/status";
    env.TWILIO_AUTH_TOKEN = undefined;
    await assert.rejects(sendTransactionalSms("+917004509790", "Approved message"), /signature verification/);
    assert.equal(requests.length, 0);
  });

  it("reports delayed provider failure without returning recipient or body", async () => {
    outcome = { ...outcome, to: "+917004509790", direction: "outbound-api", status: "undelivered", error_code: 30007 };
    assert.deepEqual(await getSmsMessageStatus(outcome.sid), {
      sid: outcome.sid, status: "undelivered", delivered: false, errorCode: 30007, errorMessage: null,
    });
  });

  it("does not confuse carrier acceptance with confirmed delivery", async () => {
    outcome = { ...outcome, to: "+917004509790", direction: "outbound-api", status: "sent" };
    assert.equal((await getSmsMessageStatus(outcome.sid)).delivered, false);
    outcome.status = "delivered";
    assert.equal((await getSmsMessageStatus(outcome.sid)).delivered, true);
  });

  it("rejects malformed SIDs before requesting provider data", async () => {
    await assert.rejects(getSmsMessageStatus("../messages"), /Invalid Twilio SMS/);
    assert.equal(requests.length, 0);
  });

  it("does not expose WhatsApp records from the SMS status endpoint", async () => {
    outcome = { ...outcome, to: "whatsapp:+917004509790", direction: "outbound-api" };
    await assert.rejects(getSmsMessageStatus(outcome.sid), /SMS message not found/);
  });
});

describe("Twilio SMS callbacks", () => {
  let server: Server;
  let base: string;
  const callbackUrl = "https://api.example.test/api/messaging/sms/status";
  const payload = { AccountSid: `AC${"0".repeat(32)}`, MessageSid: `SM${"1".repeat(32)}`, MessageStatus: "delivered", FutureProviderField: "supported" };

  before(async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use("/api/messaging", messagingRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address unavailable");
    base = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    env.TWILIO_SMS_STATUS_CALLBACK_URL = callbackUrl;
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    mock.method(console, "info", () => {});
  });
  afterEach(() => mock.restoreAll());
  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function post(fields: Record<string, string>, signature?: string) {
    return fetch(`${base}/api/messaging/sms/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(signature ? { "X-Twilio-Signature": signature } : {}) },
      body: new URLSearchParams(fields),
    });
  }

  it("accepts a signed callback including new provider fields without user authentication", async () => {
    const signature = twilio.getExpectedTwilioSignature("test-auth-token", callbackUrl, payload);
    assert.equal((await post(payload, signature)).status, 200);
  });

  it("rejects missing and forged signatures", async () => {
    assert.equal((await post(payload)).status, 403);
    assert.equal((await post(payload, "forged")).status, 403);
  });

  it("rejects tampered callback fields", async () => {
    const signature = twilio.getExpectedTwilioSignature("test-auth-token", callbackUrl, payload);
    assert.equal((await post({ ...payload, MessageStatus: "failed" }, signature)).status, 403);
  });

  it("rejects a signed callback for another account", async () => {
    const fields = { ...payload, AccountSid: `AC${"9".repeat(32)}` };
    const signature = twilio.getExpectedTwilioSignature("test-auth-token", callbackUrl, fields);
    assert.equal((await post(fields, signature)).status, 403);
  });

  it("keeps the SMS test endpoint behind authentication", async () => {
    const response = await fetch(`${base}/api/messaging/sms/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "7004509790" }) });
    assert.equal(response.status, 401);
  });
});

describe("SMS OTP safeguards", () => {
  it("never permits demo OTP authentication in production", () => {
    const previousMode = process.env.NODE_ENV;
    const previousCode = process.env.LOGIN_OTP_DEMO_CODE;
    try {
      process.env.NODE_ENV = "production";
      process.env.LOGIN_OTP_DEMO_CODE = "1234";
      assert.equal(isDemoLoginOtp("1234"), false);
      delete process.env.LOGIN_OTP_DEMO_CODE;
      assert.equal(isDemoLoginOtp("1234"), false);
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      if (previousCode === undefined) delete process.env.LOGIN_OTP_DEMO_CODE;
      else process.env.LOGIN_OTP_DEMO_CODE = previousCode;
    }
  });

  it("enforces a one-minute resend cooldown", () => {
    const now = Date.now();
    enforceLoginOtpSendLimit("9000000001", now);
    assert.throws(() => enforceLoginOtpSendLimit("9000000001", now + 30_000), /Too many OTP/);
    assert.doesNotThrow(() => enforceLoginOtpSendLimit("9000000001", now + 60_000));
  });

  it("limits each phone to five requests per ten-minute window", () => {
    const now = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      enforceLoginOtpSendLimit("9000000002", now + attempt * 60_000);
    }
    assert.throws(() => enforceLoginOtpSendLimit("9000000002", now + 5 * 60_000), /Too many OTP/);
    assert.doesNotThrow(() => enforceLoginOtpSendLimit("9000000002", now + 10 * 60_000));
  });

  it("generates four-digit codes and consumes them only once", () => {
    const code = issueLoginOtp("9000000003");
    assert.match(code, /^[1-9]\d{3}$/);
    assert.equal(consumeLoginOtpIfValid("9000000003", code), true);
    assert.equal(consumeLoginOtpIfValid("9000000003", code), false);
  });

  it("invalidates an OTP after five incorrect attempts", () => {
    const code = issueLoginOtp("9000000004");
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(consumeLoginOtpIfValid("9000000004", "0000"), false);
    }
    assert.equal(consumeLoginOtpIfValid("9000000004", code), false);
  });
});
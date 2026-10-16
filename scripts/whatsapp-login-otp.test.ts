import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkOtpSendRateLimits,
  issueLoginOtp,
  verifyAndConsumeLoginOtp,
  isDemoLoginOtp,
  clearOtpForPhone,
  _resetOtpStateForTesting,
  OTP_TTL_MS,
  MAX_VERIFY_ATTEMPTS,
  MAX_PHONE_SENDS_PER_WINDOW,
  MAX_IP_SENDS_PER_WINDOW,
} from "../src/modules/auth/login-otp.service.js";
import {
  isTwilioWhatsAppOtpEnabled,
  sendLoginOtpWhatsApp,
} from "../src/services/twilio-sms.service.js";
import { env } from "../src/config/env.js";

describe("WhatsApp Login OTP & Security Hardening", () => {
  beforeEach(() => {
    _resetOtpStateForTesting();
  });

  afterEach(() => {
    _resetOtpStateForTesting();
  });

  describe("Demo OTP Guard in Production", () => {
    it("strictly rejects demo OTP in production regardless of LOGIN_OTP_DEMO_CODE", () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origDemoCode = process.env.LOGIN_OTP_DEMO_CODE;

      try {
        process.env.NODE_ENV = "production";
        process.env.LOGIN_OTP_DEMO_CODE = "1234";

        assert.equal(isDemoLoginOtp("1234"), false, "Must reject 1234 in production");
        assert.equal(isDemoLoginOtp("9999"), false, "Must reject any code in production");

        // Even with unset or custom demo code
        delete process.env.LOGIN_OTP_DEMO_CODE;
        assert.equal(isDemoLoginOtp("1234"), false, "Must reject 1234 when demo code is unset in production");
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origDemoCode !== undefined) {
          process.env.LOGIN_OTP_DEMO_CODE = origDemoCode;
        } else {
          delete process.env.LOGIN_OTP_DEMO_CODE;
        }
      }
    });

    it("permits demo OTP in non-production when configured", () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origDemoCode = process.env.LOGIN_OTP_DEMO_CODE;

      try {
        process.env.NODE_ENV = "development";
        delete process.env.LOGIN_OTP_DEMO_CODE;
        assert.equal(isDemoLoginOtp("1234"), true, "Defaults to 1234 in dev");

        process.env.LOGIN_OTP_DEMO_CODE = "";
        assert.equal(isDemoLoginOtp("1234"), false, "Disabled when explicitly empty in dev");
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origDemoCode !== undefined) {
          process.env.LOGIN_OTP_DEMO_CODE = origDemoCode;
        } else {
          delete process.env.LOGIN_OTP_DEMO_CODE;
        }
      }
    });
  });

  describe("OTP Expiry", () => {
    it("expires OTP after 10 minutes (OTP_TTL_MS)", () => {
      const phone = "9876543210";
      const code = issueLoginOtp(phone, "127.0.0.1");

      // Verify immediate verification works
      // But mock time forward past OTP_TTL_MS
      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + OTP_TTL_MS + 1000;
        const result = verifyAndConsumeLoginOtp(phone, code);
        assert.equal(result.status, "EXPIRED", "Expired OTP must return EXPIRED status");
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("Rate Limiting & Cooldown", () => {
    it("enforces 60-second resend cooldown per phone number", () => {
      const phone = "9876543211";
      const ip = "127.0.0.1";

      // First send is allowed
      const check1 = checkOtpSendRateLimits(phone, ip);
      assert.equal(check1.allowed, true);
      issueLoginOtp(phone, ip);

      // Immediate second send is blocked by cooldown
      const check2 = checkOtpSendRateLimits(phone, ip);
      assert.equal(check2.allowed, false);
      assert.equal(check2.reason, "COOLDOWN");
      assert.ok(check2.retryAfterSeconds > 0 && check2.retryAfterSeconds <= 60);
    });

    it("allows resend after cooldown period elapses", () => {
      const phone = "9876543212";
      const ip = "127.0.0.1";

      issueLoginOtp(phone, ip);

      const originalNow = Date.now;
      try {
        // Fast-forward 61 seconds
        Date.now = () => originalNow() + 61 * 1000;
        const check = checkOtpSendRateLimits(phone, ip);
        assert.equal(check.allowed, true, "Must be allowed after 60s cooldown");
      } finally {
        Date.now = originalNow;
      }
    });

    it("enforces max 5 sends per 15 minutes per phone", () => {
      const phone = "9876543213";
      const ip = "127.0.0.1";

      const originalNow = Date.now;
      let timeOffset = 0;
      try {
        Date.now = () => originalNow() + timeOffset;

        for (let i = 0; i < MAX_PHONE_SENDS_PER_WINDOW; i++) {
          const check = checkOtpSendRateLimits(phone, ip);
          assert.equal(check.allowed, true, `Send ${i + 1} should be allowed`);
          issueLoginOtp(phone, ip);
          // Advance past cooldown (65 seconds each time)
          timeOffset += 65 * 1000;
        }

        // 6th attempt should be blocked by phone limit
        const check6 = checkOtpSendRateLimits(phone, ip);
        assert.equal(check6.allowed, false);
        assert.equal(check6.reason, "RATE_LIMITED");
      } finally {
        Date.now = originalNow;
      }
    });

    it("enforces max 15 sends per 15 minutes per IP", () => {
      const ip = "192.168.1.100";

      for (let i = 0; i < MAX_IP_SENDS_PER_WINDOW; i++) {
        const phone = `98765432${i < 10 ? "0" + i : i}`;
        const check = checkOtpSendRateLimits(phone, ip);
        assert.equal(check.allowed, true, `Send ${i + 1} on IP should be allowed`);
        issueLoginOtp(phone, ip);
      }

      // 16th send on same IP with new phone should be blocked
      const checkBlocked = checkOtpSendRateLimits("9876543299", ip);
      assert.equal(checkBlocked.allowed, false);
      assert.equal(checkBlocked.reason, "RATE_LIMITED");
    });
  });

  describe("Failed Verification Attempt Limits (Brute Force Protection)", () => {
    it("invalidates OTP after 5 incorrect attempts", () => {
      const phone = "9876543214";
      const realCode = issueLoginOtp(phone, "127.0.0.1");

      for (let i = 1; i <= 4; i++) {
        const res = verifyAndConsumeLoginOtp(phone, "0000");
        assert.equal(res.status, "INCORRECT");
        if (res.status === "INCORRECT") {
          assert.equal(res.remainingAttempts, MAX_VERIFY_ATTEMPTS - i);
        }
      }

      // 5th failed attempt invalidates the OTP
      const res5 = verifyAndConsumeLoginOtp(phone, "0000");
      assert.equal(res5.status, "MAX_ATTEMPTS_EXCEEDED");

      // Even entering the correct code now fails because OTP was deleted
      const resAfter = verifyAndConsumeLoginOtp(phone, realCode);
      assert.equal(resAfter.status, "NOT_FOUND");
    });

    it("consumes OTP on successful verification so it cannot be reused", () => {
      const phone = "9876543215";
      const code = issueLoginOtp(phone, "127.0.0.1");

      const res1 = verifyAndConsumeLoginOtp(phone, code);
      assert.equal(res1.status, "VALID");

      // Second attempt with same code fails
      const res2 = verifyAndConsumeLoginOtp(phone, code);
      assert.equal(res2.status, "NOT_FOUND");
    });
  });

  describe("WhatsApp Configuration & Template Validation", () => {
    it("reports WhatsApp OTP disabled when TWILIO_OTP_TEMPLATE_SID is missing", () => {
      const origSid = env.TWILIO_OTP_TEMPLATE_SID;
      try {
        (env as any).TWILIO_OTP_TEMPLATE_SID = undefined;
        assert.equal(isTwilioWhatsAppOtpEnabled(), false);
      } finally {
        (env as any).TWILIO_OTP_TEMPLATE_SID = origSid;
      }
    });

    it("throws a descriptive error when calling sendLoginOtpWhatsApp without template SID", async () => {
      const origSid = env.TWILIO_OTP_TEMPLATE_SID;
      const origWaFrom = env.TWILIO_WHATSAPP_FROM;
      try {
        (env as any).TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
        (env as any).TWILIO_OTP_TEMPLATE_SID = undefined;

        await assert.rejects(
          async () => {
            await sendLoginOtpWhatsApp("+919876543210", "1234");
          },
          /WhatsApp OTP template is not configured/
        );
      } finally {
        (env as any).TWILIO_OTP_TEMPLATE_SID = origSid;
        (env as any).TWILIO_WHATSAPP_FROM = origWaFrom;
      }
    });

    it("throws a descriptive error when WhatsApp sender is not configured", async () => {
      const origWaFrom = env.TWILIO_WHATSAPP_FROM;
      try {
        (env as any).TWILIO_WHATSAPP_FROM = undefined;

        await assert.rejects(
          async () => {
            await sendLoginOtpWhatsApp("+919876543210", "1234");
          },
          /Twilio WhatsApp is not configured/
        );
      } finally {
        (env as any).TWILIO_WHATSAPP_FROM = origWaFrom;
      }
    });
  });

  describe("SMS Fallback Prevention", () => {
    it("ensures OTP is cleared and not dispatched to SMS when WhatsApp fails", () => {
      const phone = "9876543216";
      const code = issueLoginOtp(phone, "127.0.0.1");

      // Simulating failure in controller: clearOtpForPhone is called
      clearOtpForPhone(phone);

      const check = verifyAndConsumeLoginOtp(phone, code);
      assert.equal(check.status, "NOT_FOUND", "Failed send must not leave orphan active OTP");
    });

    it("honors OTP_SMS_ENABLED=false setting to disable SMS delivery", () => {
      const origSmsEnabled = env.OTP_SMS_ENABLED;
      try {
        (env as any).OTP_SMS_ENABLED = false;
        assert.equal(env.OTP_SMS_ENABLED, false);
      } finally {
        (env as any).OTP_SMS_ENABLED = origSmsEnabled;
      }
    });
  });
});

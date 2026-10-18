import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMonths,
  daysUntilExpiry,
  graceOrLockStatus,
  isExportLocked,
  isSubscriptionFullyExpired,
  isOrganizationExpiredOrInactive,
  termLabelFromMonths,
} from "../src/lib/subscription-lock.js";

describe("subscription-lock", () => {
  it("locks when 30 or fewer days remain", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const in30 = new Date("2026-09-20T12:00:00.000Z");
    const in31 = new Date("2026-09-21T12:00:00.000Z");
    assert.equal(daysUntilExpiry(in30, now), 30);
    assert.equal(isExportLocked(in30, now), true);
    assert.equal(graceOrLockStatus(in30, now), "EXPORT_LOCKED");
    assert.equal(isExportLocked(in31, now), false);
    assert.equal(graceOrLockStatus(in31, now), "OK");
  });

  it("marks expired when past expiry", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const past = new Date("2026-08-01T12:00:00.000Z");
    assert.ok((daysUntilExpiry(past, now) ?? 0) < 0);
    assert.equal(isExportLocked(past, now), true);
    assert.equal(graceOrLockStatus(past, now), "EXPIRED");
  });

  it("does not lock when expiresAt is null", () => {
    assert.equal(isExportLocked(null), false);
    assert.equal(graceOrLockStatus(null), "OK");
  });

  it("adds months and labels terms", () => {
    const start = new Date("2026-01-15T00:00:00.000Z");
    const end = addMonths(start, 12);
    assert.ok(end.toISOString().startsWith("2027-01-15"));
    assert.equal(termLabelFromMonths(12), "1 year");
    assert.equal(termLabelFromMonths(24), "2 years");
    assert.equal(termLabelFromMonths(36), "3 years");
  });

  describe("isSubscriptionFullyExpired", () => {
    it("is false when subscription has days remaining (even <= 30 days)", () => {
      const now = new Date("2026-08-21T12:00:00.000Z");
      const in5Days = new Date("2026-08-26T12:00:00.000Z");
      assert.equal(isExportLocked(in5Days, now), true); // bulk export is locked
      assert.equal(isSubscriptionFullyExpired(in5Days, now), false); // operational delivery is NOT expired
    });

    it("is true only when strictly past expiry (days < 0)", () => {
      const now = new Date("2026-08-21T12:00:00.000Z");
      const past = new Date("2026-08-20T12:00:00.000Z");
      assert.equal(isSubscriptionFullyExpired(past, now), true);
    });

    it("is false when expiresAt is null", () => {
      assert.equal(isSubscriptionFullyExpired(null), false);
    });
  });

  describe("isOrganizationExpiredOrInactive", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");

    it("blocks when organization is explicitly inactive", () => {
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: false,
          subscriptionStatus: "ACTIVE",
          expiresAt: new Date("2026-12-01T12:00:00.000Z"),
          now,
        }),
        true
      );
    });

    it("blocks when subscription status is EXPIRED or CANCELLED", () => {
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: true,
          subscriptionStatus: "EXPIRED",
          now,
        }),
        true
      );
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: true,
          subscriptionStatus: "CANCELLED",
          now,
        }),
        true
      );
    });

    it("does NOT block when in TRIAL with days remaining", () => {
      const trialEndsIn7Days = new Date("2026-08-28T12:00:00.000Z");
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: true,
          subscriptionStatus: "TRIAL",
          expiresAt: trialEndsIn7Days,
          now,
        }),
        false
      );
    });

    it("blocks when TRIAL is past its expiry date", () => {
      const trialEndedYesterday = new Date("2026-08-20T12:00:00.000Z");
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: true,
          subscriptionStatus: "TRIAL",
          expiresAt: trialEndedYesterday,
          now,
        }),
        true
      );
    });

    it("does NOT block when ACTIVE with 10 days remaining (unlike isExportLocked)", () => {
      const activeEndsIn10Days = new Date("2026-08-31T12:00:00.000Z");
      assert.equal(isExportLocked(activeEndsIn10Days, now), true);
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: true,
          subscriptionStatus: "ACTIVE",
          expiresAt: activeEndsIn10Days,
          now,
        }),
        false
      );
    });

    it("does NOT block when active with no expiresAt", () => {
      assert.equal(
        isOrganizationExpiredOrInactive({
          orgIsActive: true,
          subscriptionStatus: "ACTIVE",
          expiresAt: null,
          now,
        }),
        false
      );
    });
  });
});

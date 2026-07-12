import {
  createPaymentAccessToken,
  verifyPaymentAccessToken,
} from "../server/api/payment/accessToken";
import {
  issueBookingEmailDispatchToken,
  verifyBookingEmailDispatchToken,
} from "../server/api/ref/bookingEmailDispatchToken";
import {
  freezeUpgradeIntent,
  issueUpgradeIntentToken,
  verifyUpgradeIntentToken,
} from "../server/api/ref/upgradeIntentToken";
import { issueHoldToken, verifyHoldToken } from "../server/booking/holdToken";
import {
  createDownloadToken,
  verifyDownloadToken,
} from "../server/downloads/downloadToken";
import {
  createTourneySessionToken,
  readTourneySessionPayload,
} from "../server/tourney/auth";
import {
  createTourneyDiscordEmailToken,
  readTourneyDiscordEmailToken,
} from "../server/tourney/discordOAuth";

describe("signed commerce token canonicality", () => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  beforeAll(() => {
    process.env.PAYMENT_SESSION_SECRET = "canonical-token-test-secret";
    process.env.HOLD_TOKEN_SECRET = "canonical-hold-token-test-secret";
    process.env.BOOKING_EMAIL_TOKEN_SECRET = "canonical-email-token-test-secret";
    process.env.UPGRADE_INTENT_SECRET = "canonical-upgrade-token-test-secret";
    process.env.DOWNLOAD_TOKEN_SECRET = "canonical-download-token-test-secret";
  });

  test("rejects extra dot-separated segments on every commerce capability token", () => {
    const payment = createPaymentAccessToken({
      paymentRecordId: "payment-record-1",
      provider: "paypal",
      pricingFingerprint: "pricing-1",
      expirySeconds: 600,
    });
    const email = issueBookingEmailDispatchToken({
      bookingId: "booking-1",
      email: "customer@example.com",
    });
    const upgrade = issueUpgradeIntentToken({
      bookingId: "booking-1",
      email: "customer@example.com",
      targetPackageTitle: "Performance Vertex Max",
      expiresAt,
    });
    const hold = issueHoldToken({
      holdId: "slot-hold-1",
      startTimeUTC: "2099-07-17T02:30:00.000Z",
      expiresAt,
      holdNonce: "nonce-1",
    });
    const download = createDownloadToken({
      slug: "tool",
      fileName: "tool.zip",
      bookingId: "booking-1",
      email: "customer@example.com",
    });
    const tourneySession = createTourneySessionToken({
      account: {
        username: "caster",
        role: "caster",
        version: "1",
      },
    });
    const discordEmail = createTourneyDiscordEmailToken({
      player: { id: "player-1", version: "1" },
    });

    expect(verifyPaymentAccessToken({ token: `${payment}.ignored` })).toMatchObject({
      ok: false,
      reason: "payment_access_token_malformed",
    });
    expect(
      verifyBookingEmailDispatchToken({ token: `${email}.ignored` })
    ).toMatchObject({ ok: false, reason: "booking_email_token_invalid" });
    expect(
      verifyUpgradeIntentToken({
        token: `${upgrade}.ignored`,
        bookingId: "booking-1",
        email: "customer@example.com",
        targetPackageTitle: "Performance Vertex Max",
      })
    ).toBeNull();
    expect(
      verifyHoldToken({
        token: `${hold}.ignored`,
        holdId: "slot-hold-1",
        startTimeUTC: "2099-07-17T02:30:00.000Z",
        holdNonce: "nonce-1",
      })
    ).toBeNull();
    expect(verifyDownloadToken({ token: `${download}.ignored` })).toMatchObject({
      ok: false,
      reason: "download_token_malformed",
    });
    expect(
      readTourneySessionPayload({ token: `${tourneySession}.ignored` })
    ).toBeNull();
    expect(
      readTourneyDiscordEmailToken({ token: `${discordEmail}.ignored` })
    ).toBeNull();
  });

  test("payment and download tokens expire at the exact exp second", () => {
    const issuedAtMs = 2_000_000_000_000;
    const payment = createPaymentAccessToken({
      paymentRecordId: "payment-record-1",
      provider: "paypal",
      pricingFingerprint: "pricing-1",
      issuedAtMs,
      expirySeconds: 60,
    });
    const download = createDownloadToken({
      slug: "tool",
      fileName: "tool.zip",
      bookingId: "booking-1",
      email: "customer@example.com",
      issuedAtMs,
      ttlSeconds: 60,
    });
    const expiresAtMs = issuedAtMs + 60_000;

    expect(verifyPaymentAccessToken({ token: payment, nowMs: expiresAtMs })).toMatchObject({
      ok: false,
      reason: "payment_access_token_expired",
    });
    expect(verifyDownloadToken({ token: download, nowMs: expiresAtMs })).toMatchObject({
      ok: false,
      reason: "download_token_expired",
    });
  });

  test("preserves the signed upgrade intent nonce for retry idempotency", () => {
    const token = issueUpgradeIntentToken({
      bookingId: "booking-upgrade",
      email: "customer@example.com",
      targetPackageTitle: "Performance Vertex Max",
      expiresAt,
    });
    const payload = verifyUpgradeIntentToken({
      token,
      bookingId: "booking-upgrade",
      email: "customer@example.com",
      targetPackageTitle: "Performance Vertex Max",
    });
    const snapshot = freezeUpgradeIntent({ payload });
    expect(snapshot.intentId).toBe(payload.n);
    expect(snapshot.intentId).toBeTruthy();
  });
});

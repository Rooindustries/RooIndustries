const sample = {
  version: 1,
  journeyId: "12345678-1234-4123-8123-123456789abc",
  capturedAt: "2026-09-11T10:00:00.000Z",
  landingPath: "/",
  creatorCode: "winton",
  source: "creator",
  campaign: "vertex-max",
};

describe("sales attribution", () => {
  beforeEach(() => {
    jest.resetModules();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  test("keeps existing creator codes across navigation and checkout", () => {
    const { captureSalesAttribution } = require("../lib/salesAttribution");
    sessionStorage.setItem("referral_session", "winton");
    window.history.replaceState({}, "", "/?ref=winton&utm_campaign=vertex-max");
    const initial = captureSalesAttribution();
    expect(initial).toEqual(expect.objectContaining({ creatorCode: "winton", campaign: "vertex-max" }));
    window.history.replaceState({}, "", "/booking?ref=winton");
    expect(captureSalesAttribution()).toEqual(initial);
    window.history.replaceState({}, "", "/payment");
    expect(captureSalesAttribution()).toEqual(initial);
    expect(sessionStorage.getItem("referral_session")).toBe("winton");
  });

  test("keeps browser attribution independent from referral accounting", () => {
    const { captureSalesAttribution } = require("../lib/salesAttribution");
    sessionStorage.setItem("referral_session", "winton");
    window.history.replaceState({}, "", "/?ref=soapy");
    expect(captureSalesAttribution().creatorCode).toBe("soapy");
    expect(sessionStorage.getItem("referral_session")).toBe("winton");
  });

  test("discards arbitrary customer data, URLs, and invalid identifiers", () => {
    const { sanitizeSalesAttribution } = require("../lib/salesAttribution");
    expect(sanitizeSalesAttribution({ ...sample, email: "buyer@example.invalid", source: "buyer@example.invalid", campaign: "https://example.invalid/?token=secret", landingPath: "/download/private-token", referrerHost: "https://example.invalid" })).toEqual({ version: 1, journeyId: sample.journeyId, capturedAt: sample.capturedAt, landingPath: "/", creatorCode: "winton" });
    expect(sanitizeSalesAttribution({ ...sample, journeyId: "buyer@example.invalid" })).toBeNull();
    expect(sanitizeSalesAttribution({ ...sample, capturedAt: "not-a-date" })).toBeNull();
    expect(sanitizeSalesAttribution({ ...sample, campaign: "Alice Customer", content: "919876543210", source: "token.segment.signature" })).toEqual({ version: 1, journeyId: sample.journeyId, capturedAt: sample.capturedAt, landingPath: "/", creatorCode: "winton" });
  });

  test("redacts payment URLs and omits authentication routes", () => {
    const { sanitizeAnalyticsEvent } = require("../lib/salesAttribution");
    expect(sanitizeAnalyticsEvent({ type: "event", url: "https://www.rooindustries.com/payment?email=buyer@example.invalid&paymentAccessToken=secret#token", name: "checkout_started" })).toEqual({ type: "event", url: "https://www.rooindustries.com/payment", name: "checkout_started" });
    expect(sanitizeAnalyticsEvent({ type: "pageview", url: "https://www.rooindustries.com/referrals/reset?token=secret" })).toBeNull();
    expect(sanitizeAnalyticsEvent({ type: "pageview", url: "https://www.rooindustries.com/upgrade/customer-order" }).url).toBe("https://www.rooindustries.com/upgrade");
  });

  test("starts a new attribution journey for a different explicit campaign", () => {
    const { captureSalesAttribution } = require("../lib/salesAttribution");
    window.history.replaceState({}, "", "/?ref=winton&utm_campaign=first");
    const first = captureSalesAttribution();
    window.history.replaceState({}, "", "/?ref=winton&utm_campaign=second");
    const second = captureSalesAttribution();
    expect(second.journeyId).not.toBe(first.journeyId);
    expect(second.campaign).toBe("second");
  });
});

describe("confirmed purchase receipts", () => {
  const record = {
    _id: "paymentRecord.private-order",
    bookingId: "booking.private-order",
    status: "booked",
    provider: "paypal",
    verificationState: "server_verified",
    providerPublicData: { currency: "USD", orderId: "private-order" },
    pricingSnapshot: { netAmount: 89.95, effectiveReferralCode: "winton" },
    bookingPayload: { packageTitle: "Performance Vertex Max", salesAttribution: sample, email: "buyer@example.invalid" },
  };

  test("issues a stable anonymous receipt only after a verified booking", () => {
    const { buildSalesReceipt } = require("../server/api/payment/salesReceipt");
    const receipt = buildSalesReceipt(record);
    expect(receipt).toEqual(expect.objectContaining({ eventId: expect.stringMatching(/^[a-f0-9]{40}$/), amount: 89.95, currency: "USD", attribution: sample, referralCode: "winton" }));
    expect(buildSalesReceipt(record)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toMatch(/private-order|buyer@example/);
  });

  test.each([
    { status: "started" }, { status: "failed" }, { bookingId: "" },
    { verificationState: "unverified" }, { refundState: "full" },
    { pricingSnapshot: { netAmount: "invalid" } },
  ])("does not issue a receipt for an unconfirmed or invalid payment %j", overrides => {
    const { buildSalesReceipt } = require("../server/api/payment/salesReceipt");
    expect(buildSalesReceipt({ ...record, ...overrides })).toBeNull();
  });

  test("reports free bookings distinctly without inventing paid revenue", () => {
    const { buildSalesReceipt } = require("../server/api/payment/salesReceipt");
    expect(buildSalesReceipt({ ...record, provider: "free", verificationState: "", providerPublicData: {}, pricingSnapshot: { netAmount: 0 } })).toEqual(expect.objectContaining({ paymentType: "free", amount: 0, currency: "USD" }));
  });
});

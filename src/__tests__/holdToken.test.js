describe("hold token secret isolation", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test("does not reuse JWT_SECRET in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.HOLD_TOKEN_SECRET;
    delete process.env.REF_SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    process.env.JWT_SECRET = "jwt_fallback_secret_for_test";

    const { issueHoldToken } = require("../../src/server/booking/holdToken");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    expect(() =>
      issueHoldToken({
        holdId: "hold_1",
        startTimeUTC: "2099-01-10T10:00:00.000Z",
        expiresAt,
      })
    ).toThrow("HOLD_TOKEN_SECRET is required");
  });

  test("uses the dedicated hold token secret", () => {
    process.env.NODE_ENV = "production";
    process.env.HOLD_TOKEN_SECRET = "dedicated_hold_secret_for_test";
    process.env.JWT_SECRET = "unrelated_jwt_secret_for_test";

    const { issueHoldToken, verifyHoldToken } = require("../../src/server/booking/holdToken");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const token = issueHoldToken({
      holdId: "hold_1",
      startTimeUTC: "2099-01-10T10:00:00.000Z",
      expiresAt,
    });

    const payload = verifyHoldToken({
      token,
      holdId: "hold_1",
      startTimeUTC: "2099-01-10T10:00:00.000Z",
    });

    expect(payload).toBeTruthy();
    expect(payload.hid).toBe("hold_1");
  });
});

describe("booking identity", () => {
  test("free booking request keys are stable without collapsing every free booking", () => {
    const { buildDeterministicBookingId } = require("../../src/server/booking/slotIdentity");
    const first = buildDeterministicBookingId({
      paymentProvider: "free",
      idempotencyKey: "request-one",
      startTimeUTC: "2099-01-10T10:00:00.000Z",
      email: "client@example.com",
      couponCode: "FREE",
    });
    const retry = buildDeterministicBookingId({
      paymentProvider: "free",
      idempotencyKey: "request-one",
      startTimeUTC: "2099-01-10T10:00:00.000Z",
      email: "client@example.com",
      couponCode: "FREE",
    });
    const second = buildDeterministicBookingId({
      paymentProvider: "free",
      idempotencyKey: "request-two",
      startTimeUTC: "2099-01-10T11:00:00.000Z",
      email: "client@example.com",
      couponCode: "FREE",
    });

    expect(retry).toBe(first);
    expect(second).not.toBe(first);
  });
});

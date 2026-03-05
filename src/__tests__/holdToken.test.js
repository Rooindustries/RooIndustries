describe("hold token secret fallback", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test("uses JWT_SECRET fallback in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.HOLD_TOKEN_SECRET;
    delete process.env.REF_SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    process.env.JWT_SECRET = "jwt_fallback_secret_for_test";

    const { issueHoldToken, verifyHoldToken } = require("../../api/holdToken");
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

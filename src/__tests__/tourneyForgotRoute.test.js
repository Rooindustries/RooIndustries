const mockExecuteCommand = jest.fn();
const mockReadCommandId = jest.fn();
const mockCreateTourneyPasswordReset = jest.fn();
const mockFindTourneyAccount = jest.fn();
const mockGetTourneyAdminEmail = jest.fn();
const mockReadEffectiveTourneyAccounts = jest.fn();
const mockEnqueueTourneyEmailDispatch = jest.fn();
const mockCheckTourneyRateLimit = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => Response.json(body, init) },
}));
jest.mock("../server/tourney/auth", () => ({
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  createTourneyPasswordReset: (...args) => mockCreateTourneyPasswordReset(...args),
  findTourneyAccount: (...args) => mockFindTourneyAccount(...args),
  findTourneyAccountByEmail: jest.fn(() => null),
  getTourneyAdminEmail: (...args) => mockGetTourneyAdminEmail(...args),
  getClientAddressFromHeaders: jest.fn(() => "127.0.0.1"),
  readEffectiveTourneyAccounts: (...args) =>
    mockReadEffectiveTourneyAccounts(...args),
}));
jest.mock("../server/tourney/emailDispatch", () => ({
  enqueueTourneyEmailDispatch: (...args) =>
    mockEnqueueTourneyEmailDispatch(...args),
}));
jest.mock("../server/tourney/playerStore", () => ({
  createTourneyResetToken: jest.fn(async () => null),
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteCommand(...args),
  readTourneyCommandId: (...args) => mockReadCommandId(...args),
}));

const { POST } = require("../../app/api/tourney/forgot/route.js");
const makeRequest = () => ({
  url: "https://www.rooindustries.com/api/tourney/forgot",
  headers: {
    get: (name) => {
      const normalized = String(name).toLowerCase();
      if (normalized === "origin") return "https://www.rooindustries.com";
      if (normalized === "content-type") return "application/json";
      return "";
    },
  },
  text: async () => JSON.stringify({ login: "player@example.com" }),
});

describe("Tourney forgot-password route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckTourneyRateLimit.mockResolvedValue({ ok: true });
    mockReadCommandId.mockReturnValue("forgot-command-00000001");
    mockExecuteCommand.mockResolvedValue({ status: 200, body: { ok: true } });
    mockReadEffectiveTourneyAccounts.mockResolvedValue([]);
    mockFindTourneyAccount.mockReturnValue(null);
    mockGetTourneyAdminEmail.mockReturnValue("");
    mockCreateTourneyPasswordReset.mockReturnValue({ token: "", expiresAt: "" });
    mockEnqueueTourneyEmailDispatch.mockResolvedValue({ id: "dispatch-1" });
  });

  test("rejects reserved idempotency keys instead of masking them as success", async () => {
    mockReadCommandId.mockImplementation(() => {
      throw Object.assign(new Error("Idempotency-Key uses a reserved prefix."), {
        code: "TOURNEY_IDEMPOTENCY_KEY_RESERVED",
        status: 400,
      });
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_IDEMPOTENCY_KEY_RESERVED",
    });
  });

  test("rejects an oversized body before any reset work", async () => {
    const oversized = makeRequest();
    const originalGet = oversized.headers.get;
    oversized.headers.get = (name) =>
      String(name).toLowerCase() === "content-length" ? "8193" : originalGet(name);
    const response = await POST(oversized);
    expect(response.status).toBe(413);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  test("consumes the request rate limit before parsing a malformed body", async () => {
    const request = makeRequest();
    request.text = jest.fn(async () => "{");

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockCheckTourneyRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckTourneyRateLimit).toHaveBeenCalledWith({
      key: "tourney-forgot-request:127.0.0.1",
      max: 20,
      windowMs: 30 * 60 * 1000,
    });
    expect(mockCheckTourneyRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      request.text.mock.invocationCallOrder[0]
    );
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  test("persists the reset link absolute expiry in the email dispatch", async () => {
    const account = {
      username: "serviroo",
      email: "serviroo@rooindustries.com",
      role: "owner",
      active: true,
      version: "1",
    };
    mockReadEffectiveTourneyAccounts.mockResolvedValue([account]);
    mockFindTourneyAccount.mockReturnValue(account);
    mockGetTourneyAdminEmail.mockReturnValue(account.email);
    mockCreateTourneyPasswordReset.mockReturnValue({
      token: "signed-reset-token",
      expiresAt: "2026-07-14T01:00:00.000Z",
    });
    mockExecuteCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return { status: 200, body: result.body };
    });

    await POST(makeRequest());

    expect(mockEnqueueTourneyEmailDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "reset",
        payload: expect.objectContaining({
          token: "signed-reset-token",
          expiresAt: "2026-07-14T01:00:00.000Z",
        }),
      })
    );
  });

  test("returns the durable background-sync state without exposing account existence", async () => {
    mockExecuteCommand.mockResolvedValue({
      status: 200,
      body: { ok: true },
      syncPending: true,
    });
    const response = await POST(makeRequest());
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "If that account exists, a reset link was sent.",
      syncPending: true,
    });
  });
});

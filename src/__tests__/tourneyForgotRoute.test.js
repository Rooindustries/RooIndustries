const mockExecuteCommand = jest.fn();
const mockReadCommandId = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => Response.json(body, init) },
}));
jest.mock("../server/tourney/auth", () => ({
  checkTourneyRateLimit: jest.fn(async () => ({ ok: true })),
  createTourneyPasswordResetToken: jest.fn(),
  findTourneyAccount: jest.fn(() => null),
  findTourneyAccountByEmail: jest.fn(() => null),
  getTourneyAdminEmail: jest.fn(() => ""),
  getClientAddressFromHeaders: jest.fn(() => "127.0.0.1"),
  readEffectiveTourneyAccounts: jest.fn(async () => []),
}));
jest.mock("../server/tourney/emailDispatch", () => ({
  enqueueTourneyEmailDispatch: jest.fn(),
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
  json: async () => ({ login: "player@example.com" }),
});

describe("Tourney forgot-password route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadCommandId.mockReturnValue("forgot-command-00000001");
    mockExecuteCommand.mockResolvedValue({ status: 200, body: { ok: true } });
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

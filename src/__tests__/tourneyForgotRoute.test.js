const mockExecuteCommand = jest.fn();
const mockReadCommandId = jest.fn();
const mockCreateTourneyPasswordReset = jest.fn();
const mockFindTourneyAccount = jest.fn();
const mockGetTourneyAdminEmail = jest.fn();
const mockReadEffectiveTourneyAccounts = jest.fn();
const mockEnqueueTourneyEmailDispatch = jest.fn();
const mockCheckTourneyRateLimit = jest.fn();
const mockCreateTourneyResetToken = jest.fn(async () => null);

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
  // Mirrors the real export. The route gates recovery on this list, so a mock that
  // omitted it would make every admin role look ineligible.
  TOURNEY_ADMIN_ROLES: ["viewer", "caster", "owner"],
}));
jest.mock("../server/tourney/emailDispatch", () => ({
  enqueueTourneyEmailDispatch: (...args) =>
    mockEnqueueTourneyEmailDispatch(...args),
}));
jest.mock("../server/tourney/playerStore", () => ({
  createTourneyResetToken: (...args) => mockCreateTourneyResetToken(...args),
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
    // clearAllMocks drops the factory implementation, so restore it here.
    mockCreateTourneyResetToken.mockResolvedValue(null);
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

  // A viewer is an owner-manageable admin role that can sign in. Gating recovery on
  // owner/caster alone made it fall through to the player lookup, match nothing, and
  // return the generic success response with no email sent -- a locked-out account that
  // looked like a delivered reset. Every role that can log in must be recoverable.
  test.each(["owner", "caster", "viewer"])(
    "mints a reset token for the %s role",
    async (role) => {
      const account = {
        username: `admin-${role}`,
        email: `${role}@rooindustries.com`,
        role,
        active: true,
        version: "1",
      };
      mockReadEffectiveTourneyAccounts.mockResolvedValue([account]);
      mockFindTourneyAccount.mockReturnValue(account);
      mockGetTourneyAdminEmail.mockReturnValue(account.email);
      mockCreateTourneyPasswordReset.mockReturnValue({
        token: `signed-${role}-token`,
        expiresAt: "2026-07-14T01:00:00.000Z",
      });
      mockExecuteCommand.mockImplementation(async ({ callback }) => {
        const result = await callback();
        return { status: 200, body: result.body };
      });

      await POST(makeRequest());

      expect(mockCreateTourneyPasswordReset).toHaveBeenCalledWith({ account });
      expect(mockEnqueueTourneyEmailDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: account.email,
          payload: expect.objectContaining({ token: `signed-${role}-token` }),
        })
      );
      // The player fallback must not run for an admin account.
      expect(mockCreateTourneyResetToken).not.toHaveBeenCalled();
    }
  );

  // Adding `viewer` to the role list was necessary but not sufficient: an admin with
  // no configured email and no legacy fallback passes the role gate, gets "" from
  // getTourneyAdminEmail, and used to fall through to the player lookup -- which can
  // never match an admin username, so the caller got the generic success response and
  // no email. Three active production admins were in exactly this state. The route
  // must stop at the admin branch instead of pretending the player path might work.
  test("an admin with no recovery email does not fall through to the player lookup", async () => {
    const account = {
      username: "viewer-demo",
      email: "",
      role: "viewer",
      active: true,
      version: "1",
    };
    mockReadEffectiveTourneyAccounts.mockResolvedValue([account]);
    mockFindTourneyAccount.mockReturnValue(account);
    mockGetTourneyAdminEmail.mockReturnValue("");
    mockExecuteCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return { status: 200, body: result.body };
    });

    const response = await POST(makeRequest());

    expect(mockCreateTourneyPasswordReset).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyEmailDispatch).not.toHaveBeenCalled();
    // The regression: a player-token lookup keyed on an admin username.
    expect(mockCreateTourneyResetToken).not.toHaveBeenCalled();
    // The response stays generic so the endpoint cannot be used to enumerate which
    // usernames exist or which of them are administrators.
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "If that account exists, a reset link was sent.",
    });
  });

  test("an inactive admin account is not sent a reset link", async () => {
    // Disabling an account has to revoke recovery too, or a removed caster could mint a
    // token and walk back in.
    const account = {
      username: "retired-caster",
      email: "retired@rooindustries.com",
      role: "caster",
      active: false,
      version: "3",
    };
    mockReadEffectiveTourneyAccounts.mockResolvedValue([account]);
    mockFindTourneyAccount.mockReturnValue(account);
    mockGetTourneyAdminEmail.mockReturnValue(account.email);
    mockExecuteCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return { status: 200, body: result.body };
    });

    const response = await POST(makeRequest());

    expect(mockCreateTourneyPasswordReset).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyEmailDispatch).not.toHaveBeenCalled();
    // Still the generic response: the caller learns nothing about the account.
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });
});

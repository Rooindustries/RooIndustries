const mockExecuteTourneyCommand = jest.fn();
const mockCheckTourneyRateLimit = jest.fn();

const createResponse = (body, init = {}) => {
  const headers = new Map();
  return {
    status: init.status || 200,
    json: async () => body,
    headers: {
      get: (name) => headers.get(String(name).toLowerCase()) || null,
      set: (name, value) => headers.set(String(name).toLowerCase(), String(value)),
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => createResponse(body, init) },
}));

jest.mock("../server/request/sameOrigin", () => ({
  isSameOriginMutation: jest.fn(() => true),
}));

jest.mock("../server/tourney/accountStore", () => ({
  getTourneyAccountsCanonicalHash: jest.fn(() => "accounts-hash"),
  writePersistedTourneyAccountsJson: jest.fn(),
}));

jest.mock("../server/tourney/auth", () => ({
  buildUpdatedTourneyAccounts: jest.fn(),
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  getClientAddressFromHeaders: jest.fn(() => "127.0.0.1"),
  readEffectiveTourneyAccounts: jest.fn(async () => []),
  readTourneyPasswordReset: jest.fn(() => null),
  renderTourneyAccountsJson: jest.fn(() => "[]"),
  // Mirrors the real export; the route gates the admin branch on this list.
  TOURNEY_ADMIN_ROLES: ["viewer", "caster", "owner"],
}));

jest.mock("../server/tourney/playerStore", () => ({
  hashTourneyToken: jest.fn((value) => `hash:${value}`),
  createTourneyPasswordHash: jest.fn(async () => "prepared-password-hash"),
  resetTourneyPlayerPassword: jest.fn(),
}));

jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteTourneyCommand(...args),
}));

const { POST } = require("../../app/api/tourney/reset/route.js");

const makeRequest = ({ contentLength = "" } = {}) => ({
  headers: { get: (name) => {
    const key = String(name).toLowerCase();
    if (key === "content-type") return "application/json";
    if (key === "content-length") return contentLength;
    return "";
  } },
  text: async () => JSON.stringify({ token: "reset-token", password: "new-password" }),
});

describe("Tourney reset route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckTourneyRateLimit.mockResolvedValue({ ok: true });
  });

  test("preserves the writes-paused code", async () => {
    mockExecuteTourneyCommand.mockRejectedValue(Object.assign(
      new Error("Tournament updates are briefly paused. Try again shortly."),
      { code: "TOURNEY_WRITES_PAUSED", status: 503, retryAfter: 30 }
    ));

    const response = await POST(makeRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_WRITES_PAUSED",
    });
  });

  test("rejects an oversized reset body", async () => {
    const response = await POST(makeRequest({ contentLength: "8193" }));
    expect(response.status).toBe(413);
    expect(mockExecuteTourneyCommand).not.toHaveBeenCalled();
  });

  test("consumes the reset rate limit before parsing a malformed body", async () => {
    const request = makeRequest();
    request.text = jest.fn(async () => "{");

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockCheckTourneyRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckTourneyRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      request.text.mock.invocationCallOrder[0]
    );
    expect(mockExecuteTourneyCommand).not.toHaveBeenCalled();
  });

  // The reset route has to accept every role the forgot route mints tokens for. A
  // narrower list here would validate a viewer's token, decline the admin branch, then
  // fall through to the player reset and reject the token it had just accepted.
  describe.each(["owner", "caster", "viewer"])("the %s role", (role) => {
    test("takes the admin branch and carries the plaintext for the Auth write", async () => {
      const auth = require("../server/tourney/auth");
      const accountStore = require("../server/tourney/accountStore");
      const playerStore = require("../server/tourney/playerStore");
      const account = { username: `admin-${role}`, role, active: true, version: "2" };
      auth.readTourneyPasswordReset.mockReturnValue(account);
      auth.buildUpdatedTourneyAccounts.mockResolvedValue([
        { ...account, passwordHash: "$2b$12$digest" },
      ]);
      mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
        const result = await callback();
        return { status: 200, body: result.body };
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(auth.buildUpdatedTourneyAccounts).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "change-password",
          username: account.username,
        })
      );
      // Auth discards a digest on update, so the snapshot write has to carry the
      // submitted plaintext scoped to this one username.
      expect(accountStore.writePersistedTourneyAccountsJson).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialUsername: account.username,
          credentialPassword: "new-password",
        })
      );
      // The player fallback must not run for an admin token.
      expect(playerStore.resetTourneyPlayerPassword).not.toHaveBeenCalled();
    });
  });
});

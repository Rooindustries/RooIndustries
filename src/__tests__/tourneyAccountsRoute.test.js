const mockBuildUpdatedTourneyAccounts = jest.fn();
const mockCheckTourneyRateLimit = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockFindTourneyAccount = jest.fn();
const mockReadEffectiveTourneyAccounts = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockWritePersistedTourneyAccountsJson = jest.fn();
const mockExecuteTourneyCommand = jest.fn();

const createResponse = (body, init = {}) => {
  const headers = new Map();
  const cookies = [];
  return {
    status: init.status || 200,
    json: async () => body,
    headers: {
      get: (name) => headers.get(String(name).toLowerCase()) || null,
      set: (name, value) => headers.set(String(name).toLowerCase(), String(value)),
    },
    cookies: {
      set: (cookie) => cookies.push(cookie),
      getAll: () => [...cookies],
      values: cookies,
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => createResponse(body, init) },
}));

jest.mock("../server/request/sameOrigin", () => ({
  isSameOriginMutation: jest.fn(() => true),
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  buildUpdatedTourneyAccounts: (...args) =>
    mockBuildUpdatedTourneyAccounts(...args),
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  createTourneySessionToken: (...args) => mockCreateTourneySessionToken(...args),
  getClientAddressFromHeaders: jest.fn(() => "127.0.0.1"),
  getTourneyCookieOptions: jest.fn(() => ({ httpOnly: true, path: "/" })),
  findTourneyAccount: (...args) => mockFindTourneyAccount(...args),
  readEffectiveTourneyAccounts: (...args) =>
    mockReadEffectiveTourneyAccounts(...args),
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
  renderTourneyAccountsJson: (accounts) => JSON.stringify(accounts),
  summarizeTourneyAccounts: (accounts) => accounts,
}));

jest.mock("../server/tourney/accountStore", () => ({
  getTourneyAccountsCanonicalHash: jest.fn(() => "current-hash"),
  writePersistedTourneyAccountsJson: (...args) =>
    mockWritePersistedTourneyAccountsJson(...args),
}));

jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteTourneyCommand(...args),
  readTourneyCommandId: jest.fn(() => "accounts-command-00000001"),
}));

const { POST } = require("../../app/api/tourney/accounts/route.js");

const currentAccounts = [{
  username: "serviroo",
  email: "serviroo@rooindustries.com",
  role: "owner",
  passwordHash: "old-hash",
  active: true,
  version: "1",
}];

const updatedAccounts = [{
  ...currentAccounts[0],
  passwordHash: "new-hash",
  version: "2",
}];

const makeRequest = (payload = {}, contentLength = "") => ({
  headers: { get: (name) => {
    const key = String(name).toLowerCase();
    if (key === "content-type") return "application/json";
    if (key === "content-length") return contentLength;
    return "";
  } },
  cookies: {
    get: (name) => name === "tourney_session" ? { value: "owner-session" } : undefined,
  },
  text: async () => JSON.stringify(payload),
});

describe("Tourney accounts route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "serviroo",
      role: "owner",
      authBackend: "supabase",
    });
    mockCheckTourneyRateLimit.mockResolvedValue({ ok: true });
    mockReadEffectiveTourneyAccounts.mockResolvedValue(currentAccounts);
    mockBuildUpdatedTourneyAccounts.mockResolvedValue(updatedAccounts);
    mockWritePersistedTourneyAccountsJson.mockResolvedValue({
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    mockFindTourneyAccount.mockImplementation((username, accounts) =>
      accounts.find((account) => account.username === username) || null
    );
    mockCreateTourneySessionToken.mockReturnValue("n-plus-one-session");
    mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return { status: 200, body: result.body, syncPending: false };
    });
  });

  test("rejects an oversized account mutation", async () => {
    const response = await POST(makeRequest({ action: "change-role" }, "16385"));
    expect(response.status).toBe(413);
    expect(mockExecuteTourneyCommand).not.toHaveBeenCalled();
  });

  test("keeps the current Supabase owner cookie while password projection is pending", async () => {
    mockReadTourneySessionFromStore
      .mockResolvedValueOnce({
        username: "serviroo",
        role: "owner",
        authBackend: "supabase",
      })
      .mockResolvedValueOnce(null);
    mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return {
        status: 200,
        body: { ...result.body, syncPending: true },
        syncPending: true,
      };
    });

    const response = await POST(makeRequest({
      action: "change-password",
      username: "serviroo",
      password: "new-password",
    }));

    expect(response.status).toBe(200);
    expect(response.cookies.values).toHaveLength(0);
    expect(mockReadTourneySessionFromStore).toHaveBeenLastCalledWith({
      token: "n-plus-one-session",
    });
  });

  test("uses the updated cookie when general session validation confirms projection", async () => {
    mockReadTourneySessionFromStore
      .mockResolvedValueOnce({
        username: "serviroo",
        role: "owner",
        authBackend: "supabase",
      })
      .mockResolvedValueOnce({
        username: "serviroo",
        role: "owner",
        authBackend: "supabase",
      });
    mockExecuteTourneyCommand.mockImplementation(async ({ callback }) => {
      const result = await callback();
      return {
        status: 200,
        body: { ...result.body, syncPending: true },
        syncPending: true,
      };
    });

    const response = await POST(makeRequest({
      action: "change-password",
      username: "serviroo",
      password: "new-password",
    }));

    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({ value: "n-plus-one-session" })
    );
  });

  test("issues the updated owner cookie after projection completes", async () => {
    const response = await POST(makeRequest({
      action: "change-password",
      username: "serviroo",
      password: "new-password",
    }));

    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "tourney_session",
        value: "n-plus-one-session",
      })
    );
  });

  test("preserves the writes-paused code", async () => {
    mockExecuteTourneyCommand.mockRejectedValue(Object.assign(
      new Error("Tournament updates are briefly paused. Try again shortly."),
      { code: "TOURNEY_WRITES_PAUSED", status: 503, retryAfter: 30 }
    ));

    const response = await POST(makeRequest({
      action: "change-password",
      username: "serviroo",
      password: "new-password",
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_WRITES_PAUSED",
    });
  });
});

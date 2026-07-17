const mockCheckTourneyRateLimit = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();
const mockVerifyTourneyCredentials = jest.fn();
const mockLogSafeError = jest.fn();
const mockClearNextSupabaseSession = jest.fn();
const mockInstallNextSupabaseSession = jest.fn();
const mockLinkPendingDiscordIdentity = jest.fn();
const mockReadPendingDiscordLink = jest.fn();
const mockResolvePendingDiscordUser = jest.fn();
const mockQueueTourneyDiscordAuthProjection = jest.fn();

const createResponse = ({ body = null, status = 200, url = "" } = {}) => {
  const cookieValues = [];
  const headerValues = new Map();
  return {
    status,
    url,
    json: async () => body,
    cookies: {
      set: (...args) => cookieValues.push(args.length === 1 ? args[0] : args),
      values: cookieValues,
    },
    headers: {
      get: (name) => headerValues.get(String(name).toLowerCase()) || null,
      set: (name, value) =>
        headerValues.set(String(name).toLowerCase(), String(value)),
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) =>
      createResponse({ body, status: init.status || 200 }),
    redirect: (url, init = {}) =>
      createResponse({ status: init.status || 307, url: String(url) }),
  },
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
  TOURNEY_SESSION_MAX_AGE_SECONDS: 60 * 60 * 12,
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  createTourneySessionToken: (...args) => mockCreateTourneySessionToken(...args),
  getClientAddressFromHeaders: (...args) => mockGetClientAddressFromHeaders(...args),
  getTourneyCookieOptions: (...args) => mockGetTourneyCookieOptions(...args),
  verifyTourneyCredentials: (...args) => mockVerifyTourneyCredentials(...args),
}));
jest.mock("../server/safeErrorLog", () => ({
  logSafeError: (...args) => mockLogSafeError(...args),
}));
jest.mock("../server/supabase/serverSession", () => ({
  clearNextSupabaseSession: (...args) => mockClearNextSupabaseSession(...args),
  installNextSupabaseSession: (...args) => mockInstallNextSupabaseSession(...args),
}));
jest.mock("../server/supabase/pendingSocialLink", () => ({
  clearPendingDiscordLinkCookie: () => ({
    name: "roo_pending_tourney_discord_link",
    value: "",
    maxAge: 0,
  }),
  linkPendingDiscordIdentity: (...args) =>
    mockLinkPendingDiscordIdentity(...args),
  readPendingDiscordLink: (...args) => mockReadPendingDiscordLink(...args),
  resolvePendingDiscordUser: (...args) => mockResolvePendingDiscordUser(...args),
}));
jest.mock("../server/tourney/discordDesiredState", () => ({
  queueTourneyDiscordAuthProjection: (...args) =>
    mockQueueTourneyDiscordAuthProjection(...args),
}));

const { POST } = require("../../app/api/tourney/login/route.js");

const makeJsonRequest = (payload) => {
  const body = JSON.stringify(payload);
  return {
    url: "https://www.rooindustries.com/api/tourney/login",
    headers: {
      get: (name) => {
        const normalizedName = String(name || "").toLowerCase();
        if (normalizedName === "accept") return "application/json";
        if (normalizedName === "content-type") return "application/json";
        if (normalizedName === "content-length") return String(Buffer.byteLength(body));
        return "";
      },
    },
    text: async () => body,
  };
};

describe("tourney login API route", () => {
  beforeEach(() => {
    mockCheckTourneyRateLimit.mockReset();
    mockCreateTourneySessionToken.mockReset();
    mockGetClientAddressFromHeaders.mockReset();
    mockGetTourneyCookieOptions.mockReset();
    mockVerifyTourneyCredentials.mockReset();
    mockLogSafeError.mockReset();
    mockClearNextSupabaseSession.mockReset();
    mockInstallNextSupabaseSession.mockReset();
    mockLinkPendingDiscordIdentity.mockReset();
    mockReadPendingDiscordLink.mockReset();
    mockResolvePendingDiscordUser.mockReset();
    mockQueueTourneyDiscordAuthProjection.mockReset();

    mockCheckTourneyRateLimit.mockReturnValue({ ok: true });
    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
    mockCreateTourneySessionToken.mockReturnValue("tourney-session-token");
    mockGetTourneyCookieOptions.mockReturnValue({
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    mockClearNextSupabaseSession.mockResolvedValue(undefined);
    mockInstallNextSupabaseSession.mockResolvedValue(true);
    mockLinkPendingDiscordIdentity.mockResolvedValue({ linked: true });
    mockQueueTourneyDiscordAuthProjection.mockResolvedValue({
      applied: true,
      reason: "applied",
    });
  });

  test("returns the suspended tourney message for removed players", async () => {
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: false,
      account: null,
      reason: "suspended",
    });

    const response = await POST(
      makeJsonRequest({
        username: "doggington",
        password: "correct-password",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      ok: false,
      error:
        "You have been suspended from the tourney. Please contact serviroo through Discord or at serviroo@rooindustries.com for further queries.",
    });
  });

  test("safely logs credential verification exceptions", async () => {
    const failure = Object.assign(new Error("database unavailable"), {
      code: "TERRAIN_UNAVAILABLE",
    });
    mockVerifyTourneyCredentials.mockRejectedValue(failure);

    const response = await POST(
      makeJsonRequest({ username: "player-one", password: "private-password" })
    );

    expect(response.status).toBe(503);
    expect(mockLogSafeError).toHaveBeenCalledWith(
      "Tournament login credential verification failed",
      failure
    );
  });

  test("links the proved Discord identity and resumes durable role reconciliation", async () => {
    const pendingLink = {
      intentId: "11111111-1111-4111-8111-111111111111",
      userId: "20000000-0000-4000-8000-000000000002",
    };
    const pendingUser = {
      id: pendingLink.userId,
      identities: [{ provider: "discord" }],
    };
    const primaryUserId = "30000000-0000-4000-8000-000000000003";
    const supabaseSession = {
      access_token: "primary-access-token",
      refresh_token: "primary-refresh-token",
      user: { id: primaryUserId },
    };
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: true,
      account: {
        authBackend: "supabase",
        principalId: "40000000-0000-4000-8000-000000000004",
        role: "player",
        username: "player-one",
        version: "3",
      },
      supabaseSession,
    });
    mockReadPendingDiscordLink.mockReturnValue(pendingLink);
    mockResolvePendingDiscordUser.mockResolvedValue(pendingUser);

    const response = await POST(
      makeJsonRequest({
        linkDiscord: true,
        password: "correct-password",
        redirectTo: "/tourney/manage",
        username: "player-one",
      })
    );
    const body = await response.json();

    expect(body).toEqual({
      ok: true,
      role: "player",
      username: "player-one",
      discordLinked: true,
    });
    expect(mockLinkPendingDiscordIdentity).toHaveBeenCalledWith({
      accountScope: "tourney",
      pendingUser,
      primaryUserId,
    });
    expect(mockQueueTourneyDiscordAuthProjection).toHaveBeenCalledWith({
      accountUserId: pendingLink.userId,
      attemptExternalWork: true,
      claimedUserId: pendingLink.userId,
      commandId: `discord-oauth:${pendingLink.intentId}:${pendingLink.userId}`,
      intentId: pendingLink.intentId,
      resumeStoredCredential: true,
      userId: pendingLink.userId,
    });
    expect(mockInstallNextSupabaseSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: supabaseSession })
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_pending_tourney_discord_link",
        maxAge: 0,
      })
    );
  });

  test("keeps a wrong-password error explicit without consuming the pending proof", async () => {
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: false,
      account: null,
      reason: "invalid_credentials",
    });

    const response = await POST(
      makeJsonRequest({
        linkDiscord: true,
        password: "wrong-password",
        username: "player-one",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe(
      "Invalid Discord username, email, or password. Wait for approval before trying to log in."
    );
    expect(mockReadPendingDiscordLink).not.toHaveBeenCalled();
    expect(mockLinkPendingDiscordIdentity).not.toHaveBeenCalled();
    expect(mockQueueTourneyDiscordAuthProjection).not.toHaveBeenCalled();
    expect(response.cookies.values).toHaveLength(0);
  });

  test("preserves login and shows the explicit failure when the proof is lost or expired", async () => {
    const supabaseSession = {
      access_token: "primary-access-token",
      refresh_token: "primary-refresh-token",
      user: { id: "30000000-0000-4000-8000-000000000003" },
    };
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: true,
      account: {
        authBackend: "supabase",
        role: "player",
        username: "player-one",
        version: "3",
      },
      supabaseSession,
    });
    mockReadPendingDiscordLink.mockReturnValue(null);

    const response = await POST(
      makeJsonRequest({
        linkDiscord: true,
        password: "correct-password",
        username: "player-one",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      role: "player",
      username: "player-one",
      discordLinkError:
        "Discord linking did not complete. Try the Discord login again.",
    });
    expect(mockLinkPendingDiscordIdentity).not.toHaveBeenCalled();
    expect(mockQueueTourneyDiscordAuthProjection).not.toHaveBeenCalled();
    expect(mockInstallNextSupabaseSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: supabaseSession })
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_pending_tourney_discord_link",
        maxAge: 0,
      })
    );
  });
});

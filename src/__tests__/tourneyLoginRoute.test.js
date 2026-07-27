const mockCheckTourneyRateLimit = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();
const mockVerifyTourneyCredentials = jest.fn();
const mockLogSafeError = jest.fn();
const mockClearNextSupabaseSession = jest.fn();
const mockInstallNextSupabaseSession = jest.fn();
const mockLinkPendingDiscordIdentity = jest.fn();
const mockResolvePendingSocialLink = jest.fn();
const mockResolvePendingDiscordUser = jest.fn();
const mockQueueTourneyDiscordAuthProjection = jest.fn();
const mockQueueTourneyDiscordCrossDomainRoleProjection = jest.fn();

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
  clearPendingDiscordLinkCookie: ({ provider = "discord" } = {}) => ({
    name: `roo_pending_tourney_${provider}_link`,
    value: "",
    maxAge: 0,
  }),
  linkPendingDiscordIdentity: (...args) =>
    mockLinkPendingDiscordIdentity(...args),
  PENDING_LINK_PROVIDERS: ["discord", "google"],
  resolvePendingDiscordUser: (...args) => mockResolvePendingDiscordUser(...args),
  resolvePendingSocialLink: (...args) => mockResolvePendingSocialLink(...args),
}));
jest.mock("../server/tourney/discordDesiredState", () => ({
  queueTourneyDiscordAuthProjection: (...args) =>
    mockQueueTourneyDiscordAuthProjection(...args),
  queueTourneyDiscordCrossDomainRoleProjection: (...args) =>
    mockQueueTourneyDiscordCrossDomainRoleProjection(...args),
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
    mockResolvePendingSocialLink.mockReset();
    mockResolvePendingDiscordUser.mockReset();
    mockQueueTourneyDiscordAuthProjection.mockReset();
    mockQueueTourneyDiscordCrossDomainRoleProjection.mockReset();

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
    mockQueueTourneyDiscordCrossDomainRoleProjection.mockResolvedValue({
      queued: true,
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
      provider: "discord",
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
    mockResolvePendingSocialLink.mockReturnValue(pendingLink);
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
      linkedProvider: "discord",
    });
    expect(mockLinkPendingDiscordIdentity).toHaveBeenCalledWith({
      accountScope: "tourney",
      pendingUser,
      primaryUserId,
      provider: "discord",
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
      "Invalid roster name, email, or password. Wait for approval before trying to log in."
    );
    expect(mockResolvePendingSocialLink).not.toHaveBeenCalled();
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
    mockResolvePendingSocialLink.mockReturnValue(null);

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

  test("links a proved Google identity without queueing a guild role", async () => {
    const pendingLink = {
      intentId: "22222222-2222-4222-8222-222222222222",
      provider: "google",
      userId: "20000000-0000-4000-8000-000000000002",
    };
    const pendingUser = {
      id: pendingLink.userId,
      identities: [{ provider: "google" }],
    };
    const primaryUserId = "30000000-0000-4000-8000-000000000003";
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: true,
      account: {
        authBackend: "supabase",
        role: "player",
        username: "player-one",
        version: "3",
      },
      supabaseSession: {
        access_token: "primary-access-token",
        refresh_token: "primary-refresh-token",
        user: { id: primaryUserId },
      },
    });
    mockResolvePendingSocialLink.mockReturnValue(pendingLink);
    mockResolvePendingDiscordUser.mockResolvedValue(pendingUser);

    const response = await POST(
      makeJsonRequest({
        linkDiscord: true,
        linkProvider: "google",
        password: "correct-password",
        username: "player-one",
      })
    );
    const body = await response.json();

    expect(body).toEqual({
      ok: true,
      role: "player",
      username: "player-one",
      discordLinked: true,
      linkedProvider: "google",
    });
    expect(mockLinkPendingDiscordIdentity).toHaveBeenCalledWith({
      accountScope: "tourney",
      pendingUser,
      primaryUserId,
      provider: "google",
    });
    // Google has no guild membership to project.
    expect(mockQueueTourneyDiscordAuthProjection).not.toHaveBeenCalled();
    expect(
      mockQueueTourneyDiscordCrossDomainRoleProjection
    ).not.toHaveBeenCalled();
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_pending_tourney_google_link",
        maxAge: 0,
      })
    );
  });

  test("spends the held Discord proof even when the body claims Google", async () => {
    const pendingLink = {
      intentId: "33333333-3333-4333-8333-333333333333",
      provider: "discord",
      userId: "20000000-0000-4000-8000-000000000002",
    };
    mockVerifyTourneyCredentials.mockResolvedValue({
      ok: true,
      account: {
        authBackend: "supabase",
        role: "player",
        username: "player-one",
        version: "3",
      },
      supabaseSession: {
        access_token: "primary-access-token",
        refresh_token: "primary-refresh-token",
        user: { id: "30000000-0000-4000-8000-000000000003" },
      },
    });
    mockResolvePendingSocialLink.mockReturnValue(pendingLink);
    mockResolvePendingDiscordUser.mockResolvedValue({
      id: pendingLink.userId,
      identities: [{ provider: "discord" }],
    });

    const response = await POST(
      makeJsonRequest({
        linkDiscord: true,
        linkProvider: "google",
        password: "correct-password",
        username: "player-one",
      })
    );
    const body = await response.json();

    // The proof is authoritative: the request body cannot turn a Discord proof
    // into a Google link.
    expect(body.linkedProvider).toBe("discord");
    expect(mockLinkPendingDiscordIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "discord" })
    );
    expect(mockQueueTourneyDiscordAuthProjection).toHaveBeenCalled();
  });
});

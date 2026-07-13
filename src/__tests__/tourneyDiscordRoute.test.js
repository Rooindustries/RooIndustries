const mockReadTourneySessionFromStore = jest.fn();
const mockGetApprovedTourneyPlayerById = jest.fn();
const mockListManageTourneyPlayers = jest.fn();
const mockRecordTourneyPlayerDiscordLink = jest.fn();
const mockEnqueueTourneyExternalOperation = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url, init = {}) => {
      const headers = new Map();
      return {
        status: init.status || 307,
        url: String(url),
        headers: { set: (name, value) => headers.set(name, value) },
      };
    },
    json: (body, init = {}) => {
      const headers = new Map();
      return {
        status: init.status || 200,
        json: async () => body,
        headers: { set: (name, value) => headers.set(name, value) },
      };
    },
  },
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/playerStore", () => ({
  getApprovedTourneyPlayerById: (...args) =>
    mockGetApprovedTourneyPlayerById(...args),
  listManageTourneyPlayers: (...args) => mockListManageTourneyPlayers(...args),
  recordTourneyPlayerDiscordLink: (...args) =>
    mockRecordTourneyPlayerDiscordLink(...args),
}));

jest.mock("../server/tourney/externalOperations", () => ({
  enqueueTourneyExternalOperation: (...args) =>
    mockEnqueueTourneyExternalOperation(...args),
  reconcileTourneyExternalOperations: jest.fn(async () => ({ applied: 1 })),
  hasPendingTourneyExternalOperations: jest.fn(async () => false),
}));

const startRoute = require("../../app/api/tourney/discord/start/route.js");
const callbackRoute = require("../../app/api/tourney/discord/callback/route.js");
const backfillRoute = require("../../app/api/tourney/discord/backfill/route.js");
const discordOAuth = require("../server/tourney/discordOAuth.js");

const originalEnv = process.env;
const originalFetch = global.fetch;

const env = {
  ...originalEnv,
  NODE_ENV: "test",
  TOURNEY_SESSION_SECRET: "test_tourney_session_secret",
  TOURNEY_DISCORD_INVITE_URL: "https://discord.gg/tourney",
  DISCORD_CLIENT_ID: "client_1",
  DISCORD_CLIENT_SECRET: "client_secret_1",
  DISCORD_BOT_TOKEN: "bot_token_1",
  DISCORD_GUILD_ID: "guild_1",
  DISCORD_PARTICIPANT_ROLE_ID: "role_1",
  DISCORD_HOST_ROLE_ID: "role_2",
};

const player = {
  id: "player_1",
  version: "2",
  username: "playerone",
  role: "player",
  email: "playerone@example.com",
  discord: "PlayerOne#1234",
};

const makeRequest = ({ url, cookie = "player-session", payload = {} } = {}) => ({
  url,
  headers: {
    get: (name) =>
      String(name || "").toLowerCase() === "origin"
        ? "https://www.rooindustries.com"
        : "",
  },
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
  json: async () => payload,
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("tourney Discord OAuth routes", () => {
  beforeEach(() => {
    process.env = { ...env };
    global.fetch = jest.fn();
    mockReadTourneySessionFromStore.mockReset();
    mockGetApprovedTourneyPlayerById.mockReset();
    mockListManageTourneyPlayers.mockReset();
    mockRecordTourneyPlayerDiscordLink.mockReset();
    mockEnqueueTourneyExternalOperation.mockReset();
    mockRecordTourneyPlayerDiscordLink.mockResolvedValue(player);
    mockEnqueueTourneyExternalOperation.mockResolvedValue({ status: "pending" });
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  test("redirects the retired start route to the signed-in connection page", async () => {
    const response = await startRoute.GET(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/start",
        cookie: "",
      })
    );

    expect(response.status).toBe(303);
    expect(response.url).toBe("https://www.rooindustries.com/tourney/discord");
  });

  test("keeps approved-player Discord email links valid without expiry", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      const newToken = discordOAuth.createTourneyDiscordEmailToken({
        player,
        env: process.env,
      });
      const legacyExpiringToken = discordOAuth.createTourneyDiscordEmailToken({
        player,
        env: process.env,
        maxAgeSeconds: 1,
      });

      jest.setSystemTime(new Date("2026-06-01T00:00:05.000Z"));

      expect(
        discordOAuth.readTourneyDiscordEmailToken({
          token: newToken,
          env: process.env,
        })
      ).toEqual({ playerId: "player_1" });
      expect(
        discordOAuth.readTourneyDiscordEmailToken({
          token: legacyExpiringToken,
          env: process.env,
        })
      ).toEqual({ playerId: "player_1" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("permanent email links cannot start a Discord link without account authentication", async () => {
    const token = discordOAuth.createTourneyDiscordEmailToken({
      player,
      env: process.env,
    });
    mockReadTourneySessionFromStore.mockResolvedValue(null);
    mockGetApprovedTourneyPlayerById.mockResolvedValue(player);

    const response = await startRoute.GET(
      makeRequest({
        url: `https://www.rooindustries.com/api/tourney/discord/start?token=${token}`,
        cookie: "",
      })
    );

    expect(mockGetApprovedTourneyPlayerById).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.url).toBe("https://www.rooindustries.com/tourney/discord");
  });

  test("retires token-bearing POST starts", async () => {
    const token = discordOAuth.createTourneyDiscordEmailToken({
      player,
      env: process.env,
    });
    mockReadTourneySessionFromStore.mockResolvedValue(null);
    mockGetApprovedTourneyPlayerById.mockResolvedValue(player);

    const response = await startRoute.POST(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/start",
        cookie: "",
        payload: { token },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.ok).toBe(false);
    expect(body.signInUrl).toBe("/tourney/login?next=/tourney/discord");
  });

  test("keeps Discord OAuth state tokens time-limited", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      const state = discordOAuth.createTourneyDiscordOAuthStateToken({
        player,
        env: process.env,
        maxAgeSeconds: 1,
      });

      jest.setSystemTime(new Date("2026-06-01T00:00:05.000Z"));

      expect(
        discordOAuth.readTourneyDiscordOAuthStateToken({
          token: state,
          env: process.env,
        })
      ).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects callback requests with invalid state", async () => {
    const response = await callbackRoute.GET(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/callback?code=abc&state=bad",
      })
    );

    expect(response.status).toBe(303);
    expect(response.url).toContain("discord=invalid");
    expect(mockGetApprovedTourneyPlayerById).not.toHaveBeenCalled();
  });

  test("commits Discord identity and queues the participant role", async () => {
    const state = discordOAuth.createTourneyDiscordOAuthStateToken({
      player,
      env: process.env,
    });
    mockGetApprovedTourneyPlayerById.mockResolvedValue(player);
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ access_token: "user_access_token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "discord_user_1",
          username: "servi",
          global_name: "Serviroo",
        })
      );

    const response = await callbackRoute.GET(
      makeRequest({
        url: `https://www.rooindustries.com/api/tourney/discord/callback?code=abc&state=${state}`,
      })
    );

    expect(mockRecordTourneyPlayerDiscordLink).toHaveBeenCalledWith({
      playerId: "player_1",
      discordUser: {
        id: "discord_user_1",
        username: "servi",
        global_name: "Serviroo",
      },
    });
    expect(mockEnqueueTourneyExternalOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "discord-oauth:player_1:discord_user_1",
        operationKind: "discord_membership",
        entityId: "player_1",
      })
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(response.url).toContain("discord=linked");
  });

  test("fails before commit when Discord identity exchange fails", async () => {
    const state = discordOAuth.createTourneyDiscordOAuthStateToken({
      player,
      env: process.env,
    });
    mockGetApprovedTourneyPlayerById.mockResolvedValue(player);
    global.fetch.mockResolvedValueOnce(jsonResponse({ message: "Denied" }, 403));

    const response = await callbackRoute.GET(
      makeRequest({
        url: `https://www.rooindustries.com/api/tourney/discord/callback?code=abc&state=${state}`,
      })
    );

    expect(mockRecordTourneyPlayerDiscordLink).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyExternalOperation).not.toHaveBeenCalled();
    expect(response.url).toContain("discord=role-failed");
  });

  test("requires an admin session for Discord backfills", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue(null);

    const response = await backfillRoute.POST(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Not found." });
    expect(mockListManageTourneyPlayers).not.toHaveBeenCalled();
  });

  test("dry-runs linked Discord members without mutating roles", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockListManageTourneyPlayers.mockResolvedValue([
      {
        id: "player_1",
        status: "approved",
        discordUserId: "discord_user_1",
        discordRoleAssignedAt: "",
      },
      {
        id: "player_2",
        status: "approved",
        discordUserId: "discord_user_2",
        discordRoleAssignedAt: "",
      },
      {
        id: "player_3",
        status: "approved",
        discordUserId: "discord_user_3",
        discordRoleAssignedAt: "",
      },
      {
        id: "player_4",
        status: "approved",
        discordUserId: "discord_user_4",
        discordRoleAssignedAt: "",
      },
      {
        id: "player_5",
        status: "approved",
        discordUserId: "discord_user_5",
        discordRoleAssignedAt: "2026-06-08T00:02:00.000Z",
      },
      {
        id: "player_6",
        status: "pending",
        discordUserId: "discord_user_6",
        discordRoleAssignedAt: "",
      },
    ]);
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ roles: ["role_1"] }))
      .mockResolvedValueOnce(jsonResponse({ roles: [] }))
      .mockResolvedValueOnce(jsonResponse({ roles: [] }))
      .mockResolvedValueOnce(jsonResponse({ message: "Unknown Member" }, 404))
      .mockResolvedValueOnce(jsonResponse({ roles: [] }));

    const response = await backfillRoute.POST(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      })
    );
    const body = await response.json();

    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      counts: { linked: 5, present: 4, blockedReauth: 1 },
    });
    expect(body.rows).toHaveLength(5);
    expect(mockEnqueueTourneyExternalOperation).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  test("reports unavailable Discord members without aborting inventory", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([
      { id: "player_1", status: "approved", discordUserId: "discord_user_1" },
    ]);
    global.fetch.mockRejectedValue(new Error("network unavailable"));
    const response = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
    }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      counts: { linked: 1, present: 0 },
      rows: [{ membership: "unknown", errorCode: "discord_unavailable" }],
    });
  });

  test("continues the desired-state batch after one player fails", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([
      { id: "player_1", status: "approved", discordUserId: "discord_user_1" },
      { id: "player_2", status: "approved", discordUserId: "discord_user_2" },
    ]);
    mockEnqueueTourneyExternalOperation
      .mockRejectedValueOnce(new Error("queue failed"))
      .mockResolvedValueOnce({ status: "pending" });
    const response = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply" },
    }));
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      dryRun: false,
      queued: 1,
      failed: 1,
      contactedDiscord: false,
    });
  });
});

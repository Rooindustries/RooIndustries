const mockReadTourneySessionFromStore = jest.fn();
const mockGetApprovedTourneyPlayerById = jest.fn();
const mockListManageTourneyPlayers = jest.fn();
const mockRecordTourneyPlayerDiscordLink = jest.fn();
const mockMarkTourneyPlayerDiscordRoleAssigned = jest.fn();
const mockMarkTourneyPlayerDiscordRoleFailed = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url, init = {}) => ({
      status: init.status || 307,
      url: String(url),
    }),
    json: (body, init = {}) => ({
      status: init.status || 200,
      json: async () => body,
    }),
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
  markTourneyPlayerDiscordRoleAssigned: (...args) =>
    mockMarkTourneyPlayerDiscordRoleAssigned(...args),
  markTourneyPlayerDiscordRoleFailed: (...args) =>
    mockMarkTourneyPlayerDiscordRoleFailed(...args),
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
};

const player = {
  id: "player_1",
  version: "2",
  username: "playerone",
  role: "player",
  email: "playerone@example.com",
  discord: "PlayerOne#1234",
};

const makeRequest = ({ url, cookie = "player-session" } = {}) => ({
  url,
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
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
    mockMarkTourneyPlayerDiscordRoleAssigned.mockReset();
    mockMarkTourneyPlayerDiscordRoleFailed.mockReset();
    mockRecordTourneyPlayerDiscordLink.mockResolvedValue(player);
    mockMarkTourneyPlayerDiscordRoleAssigned.mockResolvedValue(player);
    mockMarkTourneyPlayerDiscordRoleFailed.mockResolvedValue(player);
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  test("rejects non-approved users before starting Discord OAuth", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue(null);
    mockGetApprovedTourneyPlayerById.mockResolvedValue(null);

    const response = await startRoute.GET(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/start",
        cookie: "",
      })
    );

    expect(response.status).toBe(303);
    expect(response.url).toContain("/tourney/login");
    expect(response.url).toContain("discord-auth");
  });

  test("redirects approved player sessions to Discord OAuth", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "playerone",
      role: "player",
      playerId: "player_1",
    });
    mockGetApprovedTourneyPlayerById.mockResolvedValue(player);

    const response = await startRoute.GET(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/start",
      })
    );

    expect(response.status).toBe(303);
    expect(response.url).toContain("https://discord.com/oauth2/authorize");
    expect(response.url).toContain("client_id=client_1");
    expect(response.url).toContain("scope=identify+guilds.join");
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

  test("starts Discord OAuth from permanent approved-player email links", async () => {
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

    expect(mockGetApprovedTourneyPlayerById).toHaveBeenCalledWith({
      playerId: "player_1",
    });
    expect(response.status).toBe(303);
    expect(response.url).toContain("https://discord.com/oauth2/authorize");
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

  test("links Discord identity and assigns the participant role", async () => {
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
      )
      .mockResolvedValueOnce(jsonResponse({}, 204))
      .mockResolvedValueOnce(jsonResponse({}, 204));

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
    expect(global.fetch.mock.calls[2][0]).toContain(
      "/guilds/guild_1/members/discord_user_1"
    );
    expect(JSON.parse(global.fetch.mock.calls[2][1].body)).toEqual({
      access_token: "user_access_token",
    });
    expect(global.fetch.mock.calls[3][0]).toContain(
      "/guilds/guild_1/members/discord_user_1/roles/role_1"
    );
    expect(mockMarkTourneyPlayerDiscordRoleAssigned).toHaveBeenCalledWith({
      playerId: "player_1",
    });
    expect(response.url).toContain("discord=linked");
  });

  test("records role assignment failures after Discord API errors", async () => {
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
      )
      .mockResolvedValueOnce(jsonResponse({ message: "Missing Permissions" }, 403));

    const response = await callbackRoute.GET(
      makeRequest({
        url: `https://www.rooindustries.com/api/tourney/discord/callback?code=abc&state=${state}`,
      })
    );

    expect(mockMarkTourneyPlayerDiscordRoleFailed).toHaveBeenCalledWith({
      playerId: "player_1",
      errorMessage: "Missing Permissions",
    });
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

  test("backfills linked Discord members from current guild state", async () => {
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
      .mockResolvedValueOnce(jsonResponse({}, 204))
      .mockResolvedValueOnce(jsonResponse({ message: "Unknown Member" }, 404))
      .mockResolvedValueOnce(jsonResponse({ roles: [] }))
      .mockResolvedValueOnce(jsonResponse({ message: "Missing Permissions" }, 403));

    const response = await backfillRoute.POST(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      })
    );
    const body = await response.json();

    expect(body).toEqual({
      ok: true,
      checked: 4,
      alreadyHadRole: 1,
      roleAdded: 1,
      notInGuildNeedsReauth: 1,
      failed: 1,
    });
    expect(mockMarkTourneyPlayerDiscordRoleAssigned).toHaveBeenCalledWith({
      playerId: "player_1",
    });
    expect(mockMarkTourneyPlayerDiscordRoleAssigned).toHaveBeenCalledWith({
      playerId: "player_2",
    });
    expect(mockMarkTourneyPlayerDiscordRoleFailed).toHaveBeenCalledWith({
      playerId: "player_3",
      errorMessage:
        "Discord member not found after OAuth; user must re-authorize after the join fix.",
    });
    expect(mockMarkTourneyPlayerDiscordRoleFailed).toHaveBeenCalledWith({
      playerId: "player_4",
      errorMessage: "Missing Permissions",
    });
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });
});

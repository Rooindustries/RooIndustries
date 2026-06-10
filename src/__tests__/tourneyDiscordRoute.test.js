const mockReadTourneySessionFromStore = jest.fn();
const mockGetApprovedTourneyPlayerById = jest.fn();
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
  recordTourneyPlayerDiscordLink: (...args) =>
    mockRecordTourneyPlayerDiscordLink(...args),
  markTourneyPlayerDiscordRoleAssigned: (...args) =>
    mockMarkTourneyPlayerDiscordRoleAssigned(...args),
  markTourneyPlayerDiscordRoleFailed: (...args) =>
    mockMarkTourneyPlayerDiscordRoleFailed(...args),
}));

const startRoute = require("../../app/api/tourney/discord/start/route.js");
const callbackRoute = require("../../app/api/tourney/discord/callback/route.js");
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
});

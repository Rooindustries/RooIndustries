const mockReadTourneySessionFromStore = jest.fn();
const mockGetApprovedTourneyPlayerById = jest.fn();
const mockListManageTourneyPlayers = jest.fn();
const mockRecordTourneyPlayerDiscordLink = jest.fn();
const mockRecordTourneyDiscordDesiredState = jest.fn();
const mockListTourneyDiscordDesiredState = jest.fn();
const mockListAuthoritativeTourneyDiscordMappings = jest.fn();
const mockGetTourneyDiscordStatusForPlayer = jest.fn();
const mockEnqueueTourneyExternalOperation = jest.fn();
const mockSaveTourneyDiscordOperationAccessToken = jest.fn();
const mockGetTourneySqlForBackend = jest.fn();
const mockIdentitySql = jest.fn();

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

jest.mock("../server/tourney/discordDesiredState", () => ({
  getTourneyDiscordStatusForPlayer: (...args) =>
    mockGetTourneyDiscordStatusForPlayer(...args),
  listTourneyDiscordDesiredState: (...args) =>
    mockListTourneyDiscordDesiredState(...args),
  listAuthoritativeTourneyDiscordMappings: (...args) =>
    mockListAuthoritativeTourneyDiscordMappings(...args),
  recordTourneyDiscordDesiredState: (...args) =>
    mockRecordTourneyDiscordDesiredState(...args),
}));

jest.mock("../server/tourney/externalOperations", () => ({
  enqueueTourneyExternalOperation: (...args) =>
    mockEnqueueTourneyExternalOperation(...args),
  saveTourneyDiscordOperationAccessToken: (...args) =>
    mockSaveTourneyDiscordOperationAccessToken(...args),
  reconcileTourneyExternalOperations: jest.fn(async () => ({ applied: 1 })),
  hasPendingTourneyExternalOperations: jest.fn(async () => false),
}));

jest.mock("../server/tourney/sqlClient", () => ({
  ...jest.requireActual("../server/tourney/sqlClient"),
  getTourneySqlForBackend: (...args) => mockGetTourneySqlForBackend(...args),
}));

const startRoute = require("../../app/api/tourney/discord/start/route.js");
const callbackRoute = require("../../app/api/tourney/discord/callback/route.js");
const backfillRoute = require("../../app/api/tourney/discord/backfill/route.js");
const statusRoute = require("../../app/api/tourney/discord/status/route.js");
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

const makeRequest = ({
  url,
  cookie = "player-session",
  payload = {},
  contentLength = "",
  idempotencyKey = "",
} = {}) => ({
  url,
  headers: {
    get: (name) => {
      const key = String(name || "").toLowerCase();
      if (key === "origin") return "https://www.rooindustries.com";
      if (key === "content-type") return "application/json";
      if (key === "content-length") return contentLength;
      if (key === "idempotency-key") return idempotencyKey;
      return "";
    },
  },
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
  text: async () => JSON.stringify(payload),
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
    mockRecordTourneyDiscordDesiredState.mockReset();
    mockListTourneyDiscordDesiredState.mockReset();
    mockListAuthoritativeTourneyDiscordMappings.mockReset();
    mockGetTourneyDiscordStatusForPlayer.mockReset();
    mockEnqueueTourneyExternalOperation.mockReset();
    mockSaveTourneyDiscordOperationAccessToken.mockReset();
    mockGetTourneySqlForBackend.mockReset();
    mockIdentitySql.mockReset();
    mockRecordTourneyPlayerDiscordLink.mockResolvedValue(player);
    mockRecordTourneyDiscordDesiredState.mockResolvedValue({
      principal_id: "principal_1",
      discord_user_id: "discord_user_1",
      previous_discord_user_id: "",
      desired_role: "participant",
      generation: 1,
    });
    mockListTourneyDiscordDesiredState.mockResolvedValue([]);
    mockGetTourneyDiscordStatusForPlayer.mockResolvedValue(null);
    mockEnqueueTourneyExternalOperation.mockResolvedValue({
      operation_key: "discord-operation-1",
      status: "pending",
    });
    mockSaveTourneyDiscordOperationAccessToken.mockResolvedValue(true);
    mockIdentitySql.mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({
      player_id: `player_${index + 1}`,
      principal_id: `principal_${index + 1}`,
      account_active: true,
      discord_user_id: `discord_user_${index + 1}`,
    })));
    mockListAuthoritativeTourneyDiscordMappings.mockImplementation(
      (...args) => mockIdentitySql(...args)
    );
    mockGetTourneySqlForBackend.mockResolvedValue(mockIdentitySql);
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

  test("retires the split-authority callback before consuming OAuth state", async () => {
    const response = await callbackRoute.GET(
      makeRequest({
        url: "https://www.rooindustries.com/api/tourney/discord/callback?code=abc&state=bad",
      })
    );

    expect(response.status).toBe(303);
    expect(response.url).toContain("discord=retired");
    expect(mockGetApprovedTourneyPlayerById).not.toHaveBeenCalled();
    expect(mockRecordTourneyPlayerDiscordLink).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyExternalOperation).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("reports durable pending role state without claiming success", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      role: "player",
      playerId: "player_1",
    });
    mockGetApprovedTourneyPlayerById.mockResolvedValue({
      ...player,
      discordUserId: "discord_user_1",
    });
    mockGetTourneyDiscordStatusForPlayer.mockResolvedValue({
      linked: true,
      roleAssigned: false,
      roleAssignedAt: "",
      lastError: "",
      state: "pending",
    });

    const response = await statusRoute.GET(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/status",
    }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      discord: { linked: true, roleAssigned: false, state: "pending" },
    });
  });

  test("returns unavailable when durable Discord state cannot be read", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      role: "player",
      playerId: "player_1",
    });
    mockGetApprovedTourneyPlayerById.mockResolvedValue(player);
    mockGetTourneyDiscordStatusForPlayer.mockRejectedValue(new Error("database unavailable"));

    const response = await statusRoute.GET(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/status",
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Discord role status is temporarily unavailable.",
    });
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

  test("rejects an oversized Discord backfill body before inventory", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    const response = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      contentLength: "4097",
    }));
    expect(response.status).toBe(413);
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

  test("never targets a stale legacy Discord identity during inventory or apply", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([
      { id: "player_1", status: "approved", discordUserId: "stale_discord_user" },
    ]);
    mockIdentitySql.mockResolvedValue([{
      player_id: "player_1",
      principal_id: "principal_1",
      account_active: true,
      discord_user_id: "authoritative_discord_user",
    }]);
    global.fetch.mockResolvedValue(jsonResponse({ roles: ["role_1"] }));

    const inventoryResponse = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
    }));
    await expect(inventoryResponse.json()).resolves.toMatchObject({
      ok: true,
      dryRun: true,
      counts: { conflicts: 1, identityMismatches: 1 },
      rows: [{
        legacyDiscordUserId: "stale_discord_user",
        discordUserId: "authoritative_discord_user",
        membership: "present",
        conflictCode: "legacy_identity_mismatch",
      }],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/guilds/guild_1/members/authoritative_discord_user",
      expect.any(Object)
    );
    expect(JSON.stringify(global.fetch.mock.calls)).not.toContain("stale_discord_user");

    const applyResponse = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply" },
    }));
    await expect(applyResponse.json()).resolves.toMatchObject({
      ok: true,
      queued: 1,
      skippedConflicts: 0,
      identityMismatchesQueued: 1,
    });
    expect(mockRecordTourneyDiscordDesiredState).toHaveBeenCalledWith(
      expect.objectContaining({
        player: expect.objectContaining({ discordUserId: "authoritative_discord_user" }),
        discordUser: { id: "authoritative_discord_user" },
      })
    );
    expect(mockEnqueueTourneyExternalOperation).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "player_1" })
    );
    expect(JSON.stringify(mockRecordTourneyDiscordDesiredState.mock.calls))
      .not.toContain("stale_discord_user");
  });

  test("uses a fresh semantic command for a repeated repair batch", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([
      { id: "player_1", status: "approved", discordUserId: "discord_user_1" },
    ]);

    await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply" },
    }));
    await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply" },
    }));

    const commandIds = mockEnqueueTourneyExternalOperation.mock.calls.map(
      ([operation]) => operation.commandId
    );
    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).not.toBe(commandIds[1]);
    expect(commandIds.every((value) => /^discord-backfill:[0-9a-f-]{36}:player_1$/.test(value))).toBe(true);
    expect(mockRecordTourneyDiscordDesiredState).toHaveBeenCalledTimes(2);
    expect(mockRecordTourneyDiscordDesiredState).toHaveBeenCalledWith(
      expect.objectContaining({ forceRepair: true })
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("replays one authoritative principal-scoped repair for the same idempotency key", async () => {
    const principalId = "11111111-1111-4111-8111-111111111111";
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([{
      id: "player_1",
      principalId,
      status: "approved",
      discordUserId: "discord_user_1",
    }]);
    mockIdentitySql.mockResolvedValue([{
      player_id: "player_1",
      principal_id: principalId,
      account_active: true,
      discord_user_id: "discord_user_1",
    }]);

    const request = () => makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply", principalId },
      idempotencyKey: "admin-repair-20260714-same",
    });
    const first = await backfillRoute.POST(request());
    const second = await backfillRoute.POST(request());

    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      queued: 1,
      contactedDiscord: false,
      scope: { principalId, playerId: "player_1" },
    });
    await expect(second.json()).resolves.toMatchObject({ ok: true, queued: 1 });
    expect(mockListAuthoritativeTourneyDiscordMappings).toHaveBeenCalledWith(
      expect.objectContaining({ principalIds: [principalId], playerIds: [] })
    );
    expect(mockRecordTourneyDiscordDesiredState).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTourneyExternalOperation).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTourneyExternalOperation.mock.calls[0][0].commandId)
      .toMatch(/^discord-backfill:scoped:[0-9a-f]{64}$/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("requires a valid idempotency key before resolving a scoped repair", async () => {
    const principalId = "33333333-3333-4333-8333-333333333333";
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });

    const missing = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply", principalId },
    }));
    const invalid = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply", principalId },
      idempotencyKey: "short",
    }));

    expect(missing.status).toBe(400);
    expect(invalid.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_IDEMPOTENCY_KEY_REQUIRED",
    });
    await expect(invalid.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_IDEMPOTENCY_KEY_REQUIRED",
    });
    expect(mockListManageTourneyPlayers).not.toHaveBeenCalled();
    expect(mockListAuthoritativeTourneyDiscordMappings).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyExternalOperation).not.toHaveBeenCalled();
  });

  test("queues a fresh scoped repair when the admin supplies a new idempotency key", async () => {
    const principalId = "44444444-4444-4444-8444-444444444444";
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([{
      id: "player_4",
      principalId,
      status: "approved",
      discordUserId: "discord_user_4",
    }]);
    mockIdentitySql.mockResolvedValue([{
      player_id: "player_4",
      principal_id: principalId,
      account_active: true,
      discord_user_id: "discord_user_4",
    }]);

    const call = (idempotencyKey) => backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply", principalId },
      idempotencyKey,
    }));
    await call("admin-repair-20260714-first");
    await call("admin-repair-20260714-second");

    expect(mockRecordTourneyDiscordDesiredState).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTourneyExternalOperation).toHaveBeenCalledTimes(2);
    const commandIds = mockEnqueueTourneyExternalOperation.mock.calls.map(
      ([operation]) => operation.commandId
    );
    expect(commandIds[0]).not.toBe(commandIds[1]);
    expect(commandIds.every((commandId) =>
      /^discord-backfill:scoped:[0-9a-f]{64}$/.test(commandId)
    )).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects an unknown scoped Discord repair target without enqueueing", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([]);
    mockIdentitySql.mockResolvedValue([]);

    const response = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply", playerId: "missing_player" },
      idempotencyKey: "admin-repair-20260714-unknown",
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_DISCORD_REPAIR_TARGET_NOT_FOUND",
    });
    expect(mockRecordTourneyDiscordDesiredState).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyExternalOperation).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects a scoped legacy identity mismatch without enqueueing", async () => {
    const principalId = "22222222-2222-4222-8222-222222222222";
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([{
      id: "player_1",
      principalId,
      status: "approved",
      discordUserId: "stale_discord_user",
    }]);
    mockIdentitySql.mockResolvedValue([{
      player_id: "player_1",
      principal_id: principalId,
      account_active: true,
      discord_user_id: "authoritative_discord_user",
    }]);

    const response = await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply", principalId },
      idempotencyKey: "admin-repair-20260714-mismatch",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "TOURNEY_DISCORD_REPAIR_TARGET_CONFLICT",
    });
    expect(mockRecordTourneyDiscordDesiredState).not.toHaveBeenCalled();
    expect(mockEnqueueTourneyExternalOperation).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("queues the memory-store desired-state shape during repair", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({ username: "yukari", role: "caster" });
    mockListManageTourneyPlayers.mockResolvedValue([
      { id: "player_1", status: "approved", discordUserId: "discord_user_1" },
    ]);
    mockRecordTourneyDiscordDesiredState.mockResolvedValueOnce({
      principalId: "principal_1",
      discordUserId: "discord_user_1",
      previousDiscordUserId: "discord_user_old",
      desiredRole: "participant",
      generation: 7,
    });

    await backfillRoute.POST(makeRequest({
      url: "https://www.rooindustries.com/api/tourney/discord/backfill",
      payload: { action: "apply" },
    }));

    expect(mockEnqueueTourneyExternalOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredState: {
          assignment: {
            principalId: "principal_1",
            discordUserId: "discord_user_1",
            previousDiscordUserId: "discord_user_old",
            staleDiscordUserIds: [],
            desiredRole: "participant",
            generation: 7,
          },
        },
      })
    );
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

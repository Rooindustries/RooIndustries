const mockReadAccounts = jest.fn();
const mockRenderAccounts = jest.fn();
const mockRoleConfig = jest.fn();
const mockGetSql = jest.fn();
const mockGetBackendSql = jest.fn();
const mockResolvePolicy = jest.fn();
const mockExecuteCommand = jest.fn();
const mockRecordDesiredState = jest.fn();
const mockEnqueueExternalOperation = jest.fn();
const mockSql = jest.fn();

jest.mock("../server/tourney/auth", () => ({
  readEffectiveTourneyAccounts: (...args) => mockReadAccounts(...args),
  renderTourneyAccountsJson: (...args) => mockRenderAccounts(...args),
}));
jest.mock("../server/tourney/accountStore", () => ({
  writePersistedTourneyAccountsJson: jest.fn(),
}));
jest.mock("../server/tourney/discordConfig", () => ({
  getTourneyDiscordRoleConfig: (...args) => mockRoleConfig(...args),
}));
jest.mock("../server/tourney/discordDesiredState", () => ({
  recordTourneyDiscordDesiredState: (...args) => mockRecordDesiredState(...args),
}));
jest.mock("../server/tourney/externalOperations", () => ({
  enqueueTourneyExternalOperation: (...args) => mockEnqueueExternalOperation(...args),
}));
jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySql: (...args) => mockGetSql(...args),
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
}));
jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteCommand(...args),
  resolveTourneyStorePolicy: (...args) => mockResolvePolicy(...args),
}));

const {
  applyTourneyV4Activation,
  inventoryTourneyV4Activation,
  seedTourneyDiscordDesiredStateV4,
} = require("../server/tourney/activation.js");

const env = {
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "1",
  TOURNEY_FAILOVER_GENERATION: "1",
  TOURNEY_HARDENING_V4_ENABLED: "0",
  TOURNEY_V4_ACTIVATION_ENABLED: "1",
};

describe("Tourney v4 activation", () => {
  let authorityRows;
  let databaseState;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      mirrorEnabled: true,
      writesPaused: true,
      generation: 1,
    });
    mockReadAccounts.mockResolvedValue([{ username: "owner", passwordHash: "hash" }]);
    mockRenderAccounts.mockReturnValue('[{"username":"owner"}]');
    authorityRows = [{
      player_id: "private-player",
      player_principal_id: null,
      legacy_discord_user_id: "1234567890",
      account_principal_id: "principal-1",
      account_active: true,
      authoritative_discord_user_id: "1234567890",
    }];
    mockRoleConfig.mockReturnValue({
      enabled: true,
      apiBaseUrl: "https://discord.test",
      botToken: "private-token",
      guildId: "111111",
      participantRoleId: "222222",
      hostRoleId: "333333",
    });
    databaseState = {
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
      hardened_active: true,
      identity_conflicts: 0,
      ambiguous_imports: 0,
      principal_mismatches: 0,
      missing_principals: 0,
      duplicate_discord_users: 0,
      latency_baselines: 5,
    };
    mockSql.mockImplementation(async (strings) => {
      const query = strings.join(" ");
      if (query.includes("select player.id as player_id")) return authorityRows;
      if (query.includes("update accounts.discord_role_assignments")) {
        return [{ principal_id: "principal-1" }];
      }
      if (query.includes("update tourney.external_operations")) return [];
      return [databaseState];
    });
    mockGetSql.mockResolvedValue(mockSql);
    mockGetBackendSql.mockResolvedValue(jest.fn().mockResolvedValue([{
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
      hardened_active: true,
    }]));
    mockRecordDesiredState.mockResolvedValue({
      principal_id: "principal-1",
      discord_user_id: "1234567890",
      previous_discord_user_id: "",
      desired_role: "participant",
      generation: 3,
    });
    mockEnqueueExternalOperation.mockResolvedValue({ operationKey: "operation-1" });
    mockExecuteCommand.mockImplementation(async ({ callback }) => ({
      body: (await callback()).body,
      syncPending: false,
    }));
  });

  test("returns only aggregate inventory evidence", async () => {
    const inventory = await inventoryTourneyV4Activation({
      env,
      fetchImpl: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ roles: ["222222"] }),
      }),
    });
    expect(inventory).toMatchObject({
      dryRun: true,
      contactedDiscord: true,
      counts: {
        linked: 1,
        present: 1,
        unknown: 0,
        needsRepair: 0,
        databaseControlsReady: true,
        latencyBaselines: 5,
      },
    });
    expect(inventory.inventoryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inventory)).not.toContain("private-player");
    expect(JSON.stringify(inventory)).not.toContain("1234567890");
  });

  test("serializes Discord inventory and retries rate-limited members", async () => {
    authorityRows = Array.from({ length: 6 }, (_, index) => ({
      player_id: `private-player-${index}`,
      player_principal_id: null,
      legacy_discord_user_id: String(1234567890 + index),
      account_principal_id: `principal-${index}`,
      account_active: true,
      authoritative_discord_user_id: String(1234567890 + index),
    }));
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        json: async () => ({ retry_after: 0 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) });
    const sleepImpl = jest.fn().mockResolvedValue(undefined);

    const inventory = await inventoryTourneyV4Activation({
      env,
      fetchImpl,
      sleepImpl,
    });

    expect(inventory.counts).toMatchObject({ linked: 6, present: 6, unknown: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(sleepImpl).toHaveBeenCalledWith(50);
  });

  test("retries transient Discord server failures", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ roles: [] }) });
    const sleepImpl = jest.fn().mockResolvedValue(undefined);

    const inventory = await inventoryTourneyV4Activation({
      env,
      fetchImpl,
      sleepImpl,
    });

    expect(inventory.counts).toMatchObject({ linked: 1, present: 1, unknown: 0 });
    expect(sleepImpl).toHaveBeenCalledWith(250);
  });

  test("versions Discord repair commands and supersedes stale operations", async () => {
    const result = await seedTourneyDiscordDesiredStateV4({ env });

    expect(result).toEqual({ queued: 1, normalized: 1, contactedDiscord: false });
    expect(mockExecuteCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "discord-state-seed:g1:v3:private-player:1234567890",
      maintenanceWhilePaused: true,
      attemptExternalWork: false,
    }));
    expect(mockEnqueueExternalOperation).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "discord-state-seed:g1:v3:private-player:1234567890",
      operationKind: "discord_role_reconcile",
      entityId: "private-player",
    }));
    expect(mockSql.mock.calls.some(([strings]) =>
      strings.join(" ").includes("superseded_by_newer_desired_state")
    )).toBe(true);
  });

  test.each([
    {
      name: "missing authoritative identity",
      authoritativeDiscordUserId: null,
      expectedCounts: { missingDiscordIdentities: 1, mismatchedDiscordIdentities: 0 },
    },
    {
      name: "mismatched legacy identity",
      accountActive: true,
      authoritativeDiscordUserId: "9988776655",
      expectedCounts: { missingDiscordIdentities: 0, mismatchedDiscordIdentities: 1 },
    },
    {
      name: "inactive Tourney account",
      accountActive: false,
      authoritativeDiscordUserId: "1234567890",
      expectedCounts: { inactiveTourneyAccounts: 1 },
      expectedEvidence: { inactiveTourneyAccounts: 1 },
    },
  ])("blocks activation and seeding for $name", async ({
    accountActive = true,
    authoritativeDiscordUserId,
    expectedCounts,
    expectedEvidence,
  }) => {
    authorityRows = [{
      player_id: "private-player",
      player_principal_id: null,
      legacy_discord_user_id: "1234567890",
      account_principal_id: "principal-1",
      account_active: accountActive,
      authoritative_discord_user_id: authoritativeDiscordUserId,
    }];
    const fetchImpl = jest.fn();
    const inventory = await inventoryTourneyV4Activation({ env, fetchImpl });

    expect(inventory.counts).toMatchObject(expectedCounts);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(applyTourneyV4Activation({
      env,
      inventoryHash: inventory.inventoryHash,
      fetchImpl,
    })).rejects.toMatchObject({
      code: "TOURNEY_ACTIVATION_INVENTORY_BLOCKED",
      status: 409,
    });

    jest.clearAllMocks();
    mockGetSql.mockResolvedValue(mockSql);
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      mirrorEnabled: true,
      writesPaused: true,
      generation: 1,
    });
    mockRoleConfig.mockReturnValue({
      enabled: true,
      guildId: "111111",
    });
    await expect(seedTourneyDiscordDesiredStateV4({ env })).rejects.toMatchObject({
      code: "TOURNEY_DISCORD_IDENTITY_AUTHORITY_CONFLICT",
      status: 409,
      ...(expectedEvidence ? { evidence: expectedEvidence } : {}),
    });
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(mockRecordDesiredState).not.toHaveBeenCalled();
    expect(mockEnqueueExternalOperation).not.toHaveBeenCalled();
  });

  test("requires exact paused generation-one controls", async () => {
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      mirrorEnabled: true,
      writesPaused: false,
      generation: 1,
    });
    await expect(inventoryTourneyV4Activation({ env })).rejects.toMatchObject({
      code: "TOURNEY_ACTIVATION_CONTROL_MISMATCH",
      status: 409,
    });
  });

  test("refuses apply when the inventory hash changed", async () => {
    await expect(applyTourneyV4Activation({
      env,
      inventoryHash: "f".repeat(64),
      fetchImpl: jest.fn().mockResolvedValue({ status: 404, ok: false }),
    })).rejects.toMatchObject({
      code: "TOURNEY_ACTIVATION_INVENTORY_BLOCKED",
      status: 409,
    });
  });
});

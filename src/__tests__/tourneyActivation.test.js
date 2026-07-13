const mockReadAccounts = jest.fn();
const mockRenderAccounts = jest.fn();
const mockRoleConfig = jest.fn();
const mockListPlayers = jest.fn();
const mockGetSql = jest.fn();
const mockGetBackendSql = jest.fn();
const mockResolvePolicy = jest.fn();

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
  recordTourneyDiscordDesiredState: jest.fn(),
}));
jest.mock("../server/tourney/externalOperations", () => ({
  enqueueTourneyExternalOperation: jest.fn(),
}));
jest.mock("../server/tourney/playerStore", () => ({
  listManageTourneyPlayers: (...args) => mockListPlayers(...args),
}));
jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySql: (...args) => mockGetSql(...args),
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
}));
jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: jest.fn(),
  resolveTourneyStorePolicy: (...args) => mockResolvePolicy(...args),
}));

const {
  applyTourneyV4Activation,
  inventoryTourneyV4Activation,
} = require("../server/tourney/activation.js");

const env = {
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "1",
  TOURNEY_FAILOVER_GENERATION: "1",
  TOURNEY_HARDENING_V4_ENABLED: "1",
};

describe("Tourney v4 activation", () => {
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
    mockListPlayers.mockResolvedValue([
      { id: "private-player", status: "approved", discordUserId: "1234567890" },
    ]);
    mockRoleConfig.mockReturnValue({
      enabled: true,
      apiBaseUrl: "https://discord.test",
      botToken: "private-token",
      guildId: "111111",
      participantRoleId: "222222",
      hostRoleId: "333333",
    });
    mockGetSql.mockResolvedValue(jest.fn().mockResolvedValue([{
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
      hardened_active: true,
      identity_conflicts: 0,
      ambiguous_imports: 0,
      principal_mismatches: 0,
      missing_principals: 0,
      duplicate_discord_users: 0,
    }]));
    mockGetBackendSql.mockResolvedValue(jest.fn().mockResolvedValue([{
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
      hardened_active: true,
    }]));
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
      },
    });
    expect(inventory.inventoryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inventory)).not.toContain("private-player");
    expect(JSON.stringify(inventory)).not.toContain("1234567890");
  });

  test("serializes Discord inventory and retries rate-limited members", async () => {
    mockListPlayers.mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({
      id: `private-player-${index}`,
      status: "approved",
      discordUserId: String(1234567890 + index),
    })));
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

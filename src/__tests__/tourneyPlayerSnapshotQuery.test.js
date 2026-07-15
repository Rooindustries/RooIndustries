const mockAssertTourneySchemaVersion = jest.fn();
const mockSql = jest.fn();

jest.mock("../server/tourney/sqlClient.js", () => ({
  assertTourneySchemaVersion: (...args) =>
    mockAssertTourneySchemaVersion(...args),
  getTourneySql: async () => mockSql,
  isSupabaseTourneyDatabase: () => true,
  resolveTourneyDatabaseUrl: () => "postgres://snapshot-test",
  runTourneyTransaction: jest.fn(),
}));

const store = require("../server/tourney/playerStore.js");

describe("Tourney admin player snapshot query", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertTourneySchemaVersion.mockResolvedValue(true);
  });

  test("returns players and capacity with one database query", async () => {
    mockSql.mockResolvedValue([{
      config: {
        team_count: 2,
        updated_at: "2026-07-15T00:00:00.000Z",
        updated_by: "serviroo",
      },
      players: [{
        id: "player-1",
        username: "player-one",
        email: "player@example.com",
        status: "approved",
        discord: "PlayerOne",
        display_name: "Player One",
        role_play: "Support",
        approved_role_play: "Support",
        registration_pool: "main",
        created_at: "2026-07-15T00:00:00.000Z",
      }],
    }]);

    const result = await store.getManageTourneyPlayersSnapshot({
      env: { NODE_ENV: "production", TOURNEY_DATABASE_MODE: "supabase" },
    });

    expect(mockAssertTourneySchemaVersion).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("jsonb_agg");
    expect(result.players).toEqual([
      expect.objectContaining({
        id: "player-1",
        email: "player@example.com",
        rolePlay: "Support",
        status: "approved",
      }),
    ]);
    expect(result.capacity).toMatchObject({
      teamCount: 2,
      updatedBy: "serviroo",
      roles: expect.arrayContaining([
        expect.objectContaining({ role: "Support", mainCount: 1 }),
      ]),
    });
  });

  test("keeps an empty tournament readable", async () => {
    mockSql.mockResolvedValue([{
      config: { team_count: 8, updated_at: "", updated_by: "" },
      players: [],
    }]);

    await expect(store.getManageTourneyPlayersSnapshot({
      env: { NODE_ENV: "production", TOURNEY_DATABASE_MODE: "supabase" },
    })).resolves.toMatchObject({
      players: [],
      capacity: { teamCount: 8, roles: expect.any(Array) },
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

const queryTexts = [];

const sql = jest.fn(async (strings) => {
  const query = strings.join(" ").replace(/\s+/g, " ").trim();
  queryTexts.push(query);
  return [{
    meta: {
      id: "legacy-series-2026",
      stage_id: null,
      status: "draft",
      published: false,
      generated_at: null,
      updated_at: null,
      updated_by: "",
    },
    teams: [],
    entities: [],
  }];
});

jest.mock("../server/tourney/sqlClient", () => ({
  assertTourneySchemaVersion: jest.fn(async () => true),
  getTourneySql: jest.fn(async () => sql),
  isSupabaseTourneyDatabase: jest.fn(() => false),
  runSupabaseTourneyTransaction: jest.fn(),
  resolveTourneyDatabaseUrl: jest.fn(() => "postgres://legacy.example/tourney"),
}));

const { getTourneyBracketSnapshot } = require("../server/tourney/bracketStore");

describe("legacy Tourney bracket reads", () => {
  beforeEach(() => {
    queryTexts.length = 0;
    sql.mockClear();
  });

  test("loads the complete public bracket snapshot in one database round trip", async () => {
    const result = await getTourneyBracketSnapshot({
      env: { TOURNEY_DATABASE_MODE: "legacy" },
    });

    expect(result).toMatchObject({ ok: true, generated: false, matches: [] });
    expect(sql).toHaveBeenCalledTimes(1);
    expect(queryTexts[0]).toContain("from tourney_bracket_meta");
    expect(queryTexts[0]).toContain("from tourney_bracket_teams");
    expect(queryTexts[0]).toContain("from tourney_bracket_entities");
    expect(queryTexts[0]).toContain("entity_type = any");
  });
});

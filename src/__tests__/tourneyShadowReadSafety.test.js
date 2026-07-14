const mockGetBackendSql = jest.fn();
const mockReadService = jest.fn();

jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
  isSupabaseTourneyDatabase: (env) => env.TOURNEY_DATABASE_MODE === "supabase",
  runTourneyTransaction: jest.fn(),
}));

jest.mock("../server/tourney/readService", () => ({
  TOURNEY_READ_SERVICES: { public_roster: {} },
  readTourneyService: (...args) => mockReadService(...args),
}));

const { runTourneyShadowReadSamples } = require("../server/tourney/store");

const createSql = () => {
  const sql = jest.fn((strings) =>
    Array.isArray(strings) ? Promise.resolve([]) : strings
  );
  return sql;
};

describe("Tourney shadow-read safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const sourceSql = createSql();
    const targetSql = createSql();
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "supabase" ? sourceSql : targetSql)
    );
  });

  test("keeps matching successful responses clean", async () => {
    mockReadService
      .mockResolvedValueOnce({
        status: 200,
        errorCode: null,
        body: { players: [] },
        latencyMs: 10,
      })
      .mockResolvedValueOnce({
        status: 200,
        errorCode: null,
        body: { players: [] },
        latencyMs: 12,
      });

    await expect(runTourneyShadowReadSamples({
      env: {
        TOURNEY_DATABASE_MODE: "supabase",
        TOURNEY_FAILOVER_GENERATION: "1",
      },
      rounds: 1,
    })).resolves.toMatchObject({ samples: 1, mismatches: 0 });
  });

  test("counts matching non-2xx responses as a mismatch", async () => {
    mockReadService
      .mockResolvedValueOnce({
        status: 503,
        errorCode: "TOURNEY_UNAVAILABLE",
        body: { error: "Unavailable" },
        latencyMs: 10,
      })
      .mockResolvedValueOnce({
        status: 503,
        errorCode: "TOURNEY_UNAVAILABLE",
        body: { error: "Unavailable" },
        latencyMs: 12,
      });

    await expect(runTourneyShadowReadSamples({
      env: {
        TOURNEY_DATABASE_MODE: "supabase",
        TOURNEY_FAILOVER_GENERATION: "1",
      },
      rounds: 1,
    })).resolves.toMatchObject({ samples: 1, mismatches: 1 });
  });
});

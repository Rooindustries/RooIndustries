const mockGetBackendSql = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
}));
jest.mock("../server/tourney/store", () => ({
  resolveTourneyStorePolicy: () => ({
    primaryBackend: "legacy",
    generation: 2,
    mirrorEnabled: true,
    writesPaused: true,
  }),
}));

const { GET } = require("../../app/api/admin/tourney-readiness/route.js");
const originalAdminKey = process.env.REF_ADMIN_KEY;

const request = (key = "readiness-secret") => ({
  headers: { get: (name) => name === "x-admin-key" ? key : "" },
});

const createLegacySql = () => jest.fn(async (strings) => {
  const query = strings.join(" ");
  if (query.includes("from tourney_cutover_metadata")) {
    return [{
      primary_backend: "legacy",
      generation: 2,
      writes_paused: true,
      fallback_read_only: false,
      clock_last_reset_reason: null,
    }];
  }
  if (query.includes("from tourney_players group by status")) {
    return [{ status: "approved", count: 1 }];
  }
  if (query.includes("as players") && query.includes("as command_receipts")) {
    return [{ players: 1, tokens: 0, teams: 0, team_members: 0,
      appeals: 0, payouts: 0, account_snapshots: 1, command_receipts: 1 }];
  }
  if (query.includes("from tourney_mirror_outbox group by status")) {
    return [{ counts: { applied: 1 }, oldest_pending_at: null }];
  }
  if (query.includes("from tourney_external_operations group by status")) {
    return [{ counts: {}, oldest_pending_at: null }];
  }
  if (query.includes("from tourney_email_dispatches group by status")) return [];
  if (query.includes("from tourney_discord_role_assignments group by status")) {
    return [{ status: "blocked_reauth", count: 1 }];
  }
  if (query.includes("from tourney_parity_runs")) return [];
  if (query.includes("from ranked") && query.includes("sample_rank <= 30")) {
    return [{
      route: "public_roster",
      samples: 1,
      mismatches: 1,
      primary_p95_ms: 10,
      shadow_p95_ms: 12,
      last_observed_at: new Date("2026-07-14T00:00:00.000Z"),
    }];
  }
  if (query.includes("from tourney_identity_conflicts")) return [{ count: 0 }];
  throw new Error(`Unexpected readiness query: ${query}`);
});

describe("Tourney legacy readiness route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REF_ADMIN_KEY = "readiness-secret";
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = originalAdminKey;
  });

  test("reports blocked reauthentication and non-2xx shadow samples", async () => {
    const sql = createLegacySql();
    mockGetBackendSql.mockResolvedValue(sql);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetBackendSql).toHaveBeenCalledWith({ backend: "legacy" });
    expect(body.readiness.clock_blockers).toEqual(
      expect.arrayContaining(["discord_blocker", "shadow_mismatch"])
    );
    expect(body.readiness.shadow_reads.public_roster.mismatches).toBe(1);
    const shadowQuery = sql.mock.calls
      .map(([strings]) => strings.join(" "))
      .find((query) => query.includes("sample_rank <= 30"));
    expect(shadowQuery).toContain("primary_status between 200 and 299");
    expect(shadowQuery).toContain("shadow_status between 200 and 299");
  });
});

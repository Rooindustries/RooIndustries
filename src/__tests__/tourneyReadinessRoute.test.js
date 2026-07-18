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

const {
  GET,
  currentShadowAcceptancePasses,
  normalizeTourneyReadinessForResponse,
} = require("../../app/api/admin/tourney-readiness/route.js");
const originalAdminKey = process.env.REF_ADMIN_KEY;
const originalHardening = process.env.TOURNEY_HARDENING_V4_ENABLED;
const originalActivation = process.env.TOURNEY_V4_ACTIVATION_ENABLED;

const request = (key = "readiness-secret") => ({
  headers: { get: (name) => name === "x-admin-key" ? key : "" },
});

const createLegacySql = () => jest.fn(async (strings) => {
  const query = strings.join(" ");
  if (query.includes("tourney_mirror_trigger_binding_status_v4")) {
    return [{ readiness: { ready: true, correctly_bound: 17 } }];
  }
  if (query.includes("from tourney_cutover_metadata")) {
    return [{
      primary_backend: "legacy",
      generation: 2,
      writes_paused: true,
      fallback_read_only: false,
      hardened_active: true,
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
  if (query.includes("from tourney_shadow_latency_baselines")) {
    return [{
      route: "public_roster",
      primary_p95_ms: 10,
      sample_count: 30,
    }];
  }
  if (query.includes("from tourney_identity_conflicts")) return [{ count: 0 }];
  throw new Error(`Unexpected readiness query: ${query}`);
});

describe("Tourney legacy readiness route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REF_ADMIN_KEY = "readiness-secret";
    process.env.TOURNEY_HARDENING_V4_ENABLED = "1";
    process.env.TOURNEY_V4_ACTIVATION_ENABLED = "0";
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = originalAdminKey;
    if (originalHardening === undefined) delete process.env.TOURNEY_HARDENING_V4_ENABLED;
    else process.env.TOURNEY_HARDENING_V4_ENABLED = originalHardening;
    if (originalActivation === undefined) delete process.env.TOURNEY_V4_ACTIVATION_ENABLED;
    else process.env.TOURNEY_V4_ACTIVATION_ENABLED = originalActivation;
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
    expect(body.controlMatchesDeployment).toBe(true);
    expect(body.finalReadiness).toBe(false);
    const shadowQuery = sql.mock.calls
      .map(([strings]) => strings.join(" "))
      .find((query) => query.includes("sample_rank <= 30"));
    expect(shadowQuery).toContain("primary_status between 200 and 299");
    expect(shadowQuery).toContain("shadow_status between 200 and 299");
  });

  test("requires hardened control agreement and a disabled activation flag", async () => {
    const sql = createLegacySql();
    mockGetBackendSql.mockResolvedValue(sql);

    process.env.TOURNEY_HARDENING_V4_ENABLED = "0";
    process.env.TOURNEY_V4_ACTIVATION_ENABLED = "1";
    const response = await GET(request());
    const body = await response.json();

    expect(body.controlMatchesDeployment).toBe(false);
    expect(body.activationEnabled).toBe(true);
    expect(body.finalReadiness).toBe(false);
  });

  test("accepts canonical truthy deployment flag values", async () => {
    const sql = createLegacySql();
    mockGetBackendSql.mockResolvedValue(sql);
    process.env.TOURNEY_HARDENING_V4_ENABLED = "  On  ";
    process.env.TOURNEY_V4_ACTIVATION_ENABLED = "off";

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.hardenedEnabled).toBe(true);
    expect(body.activationEnabled).toBe(false);
    expect(body.controlMatchesDeployment).toBe(true);
  });

  test("reports only current routes and deduplicates blockers", () => {
    const cleanRoute = {
      samples: 30,
      mismatches: 0,
      primary_p95_ms: 100,
      shadow_p95_ms: 110,
    };
    const readiness = {
      clock_blockers: [
        "discord_blocker",
        "shadow_acceptance_gate_failed",
        "discord_blocker",
      ],
      shadow_reads: {
        public_roster: cleanRoute,
        public_bracket: cleanRoute,
        admin_players: cleanRoute,
        appeals: cleanRoute,
        payouts: cleanRoute,
        players: { samples: 30, mismatches: 30 },
        bracket: { samples: 30, mismatches: 30 },
        operations: { samples: 30, mismatches: 30 },
      },
      shadow_latency_baselines: Object.fromEntries(
        [
          "public_roster",
          "public_bracket",
          "admin_players",
          "appeals",
          "payouts",
        ].map((route) => [route, { primary_p95_ms: 100 }])
      ),
    };
    expect(currentShadowAcceptancePasses(readiness)).toBe(true);
    expect(normalizeTourneyReadinessForResponse(readiness)).toMatchObject({
      clock_blockers: ["discord_blocker"],
      shadow_reads: {
        public_roster: cleanRoute,
        public_bracket: cleanRoute,
        admin_players: cleanRoute,
        appeals: cleanRoute,
        payouts: cleanRoute,
      },
    });
    expect(normalizeTourneyReadinessForResponse({
      shadow_reads: { operations: { samples: 30, mismatches: 30 } },
    }).shadow_reads).toEqual({});
  });

  test("retains the acceptance blocker when a current route misses the contract", () => {
    const readiness = {
      clock_blockers: ["shadow_acceptance_gate_failed"],
      shadow_reads: Object.fromEntries(
        [...currentShadowRoutesForTest()].map((route) => [route, {
          samples: route === "payouts" ? 29 : 30,
          mismatches: 0,
          primary_p95_ms: 100,
          shadow_p95_ms: 110,
        }])
      ),
      shadow_latency_baselines: Object.fromEntries(
        [...currentShadowRoutesForTest()].map((route) => [
          route,
          { primary_p95_ms: 100 },
        ])
      ),
    };

    expect(currentShadowAcceptancePasses(readiness)).toBe(false);
    expect(normalizeTourneyReadinessForResponse(readiness).clock_blockers)
      .toContain("shadow_acceptance_gate_failed");
  });
});

function currentShadowRoutesForTest() {
  return new Set([
    "public_roster",
    "public_bracket",
    "admin_players",
    "appeals",
    "payouts",
  ]);
}

/** @jest-environment node */

const mockMigrate = jest.fn();
const mockReadSnapshot = jest.fn();
const mockCreateAdminClient = jest.fn();
const mockReadAccounts = jest.fn();
const mockSplitStatements = jest.fn();
const mockGetSql = jest.fn();
const mockGetBackendSql = jest.fn();
const mockExecuteCommand = jest.fn();
const mockCheckManualFailoverReadiness = jest.fn();
const mockReconcileMirror = jest.fn();
const mockRunParity = jest.fn();
const mockRunShadowSamples = jest.fn();
const mockLogSafeError = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({
  logSafeError: (...args) => mockLogSafeError(...args),
}));
jest.mock("../server/supabase/tourneyMigration", () => ({
  migrateTourneyShadow: (...args) => mockMigrate(...args),
  readTourneySnapshot: (...args) => mockReadSnapshot(...args),
}));
jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: (...args) => mockCreateAdminClient(...args),
}));
jest.mock("../server/tourney/accountStore", () => ({
  readPersistedTourneyAccountsJson: (...args) => mockReadAccounts(...args),
}));
jest.mock("../server/tourney/sqlStatements", () => ({
  splitPostgresStatements: (...args) => mockSplitStatements(...args),
}));
jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySql: (...args) => mockGetSql(...args),
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
}));
jest.mock("../server/tourney/store", () => ({
  executeTourneyCommand: (...args) => mockExecuteCommand(...args),
  checkTourneyManualFailoverReadiness: (...args) =>
    mockCheckManualFailoverReadiness(...args),
  reconcileTourneyMirror: (...args) => mockReconcileMirror(...args),
  runTourneyParity: (...args) => mockRunParity(...args),
  runTourneyShadowReadSamples: (...args) => mockRunShadowSamples(...args),
}));

const migrationTargetSafety = require("../server/supabase/migrationTargetSafety.cjs");
const { POST } = require("../../app/api/supabase/tourney-shadow/route.js");
const originalEnv = { ...process.env };
const events = [];

const request = ({
  adminKey = "route-admin-key",
  forwardedHost = "",
  host = "preview.example.vercel.app",
  payload = {},
  contentLength = "",
} = {}) => ({
  headers: {
    get: (name) => {
      const key = String(name).toLowerCase();
      if (key === "x-admin-key") return adminKey;
      if (key === "x-forwarded-host") return forwardedHost;
      if (key === "host") return host;
      if (key === "content-type") return "application/json";
      if (key === "content-length") return contentLength;
      return "";
    },
  },
  text: async () => JSON.stringify(payload),
});

const makeSql = (
  backend,
  {
    failProbe = false,
    failUpdate = false,
    failUpdateAfterApply = false,
    updateErrorCode = "40001",
    beforeFailedUpdate = () => {},
    readiness = {},
    parity = {},
  } = {}
) => {
  const state = {
    primary_backend: "legacy",
    generation: 0,
    writes_paused: true,
    updated_by: "fixture",
    row_version: "1",
  };
  let shouldFailUpdate = failUpdate;
  const updates = [];
  const sql = jest.fn((first, ...values) => {
    if (typeof first === "string") return first;
    const text = first.join(" ").replace(/\s+/g, " ").trim();
    if (text.includes("select true as ok")) {
      events.push(`${backend}:probe`);
      return failProbe
        ? Promise.reject(new Error("fixture probe failed"))
        : Promise.resolve([{ ok: true }]);
    }
    if (text.includes("from tourney.parity_runs")) {
      return Promise.resolve([{
        status: "clean",
        fresh: true,
        after_latest_mirror: true,
        ...parity,
      }]);
    }
    if (text.includes("account_snapshots")) {
      return Promise.resolve([{
        primary_backend: state.primary_backend,
        generation: state.generation,
        writes_paused: state.writes_paused,
        hardened_active: true,
        fallback_read_only: false,
        schema_version: 4,
        mirror: 0,
        external: 0,
        email: 0,
        receipts: 0,
        auth: 0,
        discord: 0,
        conflicts: 0,
        ambiguous: 0,
        player_principals: 0,
        account_snapshots: 1,
        account_principals: 0,
        ...readiness,
      }]);
    }
    if (text.includes("select primary_backend")) {
      events.push(`${backend}:read-control`);
      return Promise.resolve([{ ...state }]);
    }
    if (text.includes("update") && text.includes("primary_backend")) {
      const [, primaryBackend, generation, writesPaused, actor, expectedVersion] =
        values;
      events.push(`${backend}:update:${actor}`);
      updates.push({ primaryBackend, generation, writesPaused, actor });
      if (expectedVersion !== state.row_version) return Promise.resolve([]);
      const applyUpdate = () => Object.assign(state, {
        primary_backend: primaryBackend,
        generation,
        writes_paused: writesPaused,
        updated_by: actor,
        row_version: String(Number(state.row_version) + 1),
      });
      if (shouldFailUpdate) {
        shouldFailUpdate = false;
        beforeFailedUpdate();
        if (failUpdateAfterApply) applyUpdate();
        return Promise.reject(Object.assign(new Error("fixture update failed"), {
          code: updateErrorCode,
        }));
      }
      applyUpdate();
      return Promise.resolve([{ ...state }]);
    }
    return Promise.resolve([]);
  });
  return { sql, state, updates };
};

const previewTargetEnv = () => ({
  SUPABASE_MIGRATION_ENDPOINT_ENABLED: "1",
  SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "preview",
  SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS: "0",
  VERCEL_ENV: "preview",
  REF_ADMIN_KEY: "route-admin-key",
  CRON_SECRET: "",
  TOURNEY_PREVIEW_DATABASE_URL:
    "postgresql://preview_owner:placeholder@preview-legacy.example.com/tourney",
  SUPABASE_PREVIEW_DATABASE_URL:
    "postgresql://postgres.previewproject:placeholder@preview.pooler.supabase.com:6543/postgres",
  SUPABASE_PREVIEW_URL: "https://previewproject.supabase.co",
  SUPABASE_PREVIEW_SECRET_KEY: "preview-secret-placeholder-1234567890",
  TOURNEY_DATABASE_URL:
    "postgresql://production_owner:placeholder@production-legacy.example.com/tourney",
  SUPABASE_DATABASE_URL:
    "postgresql://postgres.production:placeholder@production.pooler.supabase.com:6543/postgres",
  SUPABASE_URL: "https://production.supabase.co",
  SUPABASE_SECRET_KEY: "production-secret-placeholder-1234567890",
});

const setTargetEnv = (overrides = {}) => {
  process.env = { ...originalEnv, ...previewTargetEnv(), ...overrides };
  const fingerprints = migrationTargetSafety.computeMigrationTargetFingerprints(
    process.env
  );
  process.env.SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT =
    fingerprints.legacy;
  process.env.SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT =
    fingerprints.supabase;
  return fingerprints;
};

const setDatabases = ({
  failLegacyProbe = false,
  failLegacyUpdate = false,
  failLegacyUpdateAfterApply = false,
  legacyUpdateErrorCode = "40001",
  failSupabaseProbe = false,
  failSupabaseUpdate = false,
  failSupabaseUpdateAfterApply = false,
  supabaseUpdateErrorCode = "40001",
  beforeSupabaseFailure = () => {},
  legacyReadiness = {},
  supabaseReadiness = {},
  supabaseParity = {},
} = {}) => {
  const legacy = makeSql("legacy", {
    failProbe: failLegacyProbe,
    failUpdate: failLegacyUpdate,
    failUpdateAfterApply: failLegacyUpdateAfterApply,
    updateErrorCode: legacyUpdateErrorCode,
    readiness: legacyReadiness,
  });
  const supabase = makeSql("supabase", {
    failProbe: failSupabaseProbe,
    failUpdate: failSupabaseUpdate,
    failUpdateAfterApply: failSupabaseUpdateAfterApply,
    updateErrorCode: supabaseUpdateErrorCode,
    beforeFailedUpdate: () => beforeSupabaseFailure(legacy),
    readiness: supabaseReadiness,
    parity: supabaseParity,
  });
  mockGetBackendSql.mockImplementation(({ backend }) =>
    Promise.resolve(backend === "legacy" ? legacy.sql : supabase.sql)
  );
  return { legacy, supabase };
};

const cutoverPayload = (extra = {}) => ({
  action: "cutover-control",
  primaryBackend: "supabase",
  generation: 1,
  writesPaused: true,
  ...extra,
});

describe("Tourney shadow route target safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    setTargetEnv();
    setDatabases();
    mockMigrate.mockResolvedValue({ migrated: true });
    mockRunParity.mockResolvedValue({ status: "clean" });
    mockRunShadowSamples.mockResolvedValue({ samples: 1 });
    mockReconcileMirror.mockResolvedValue({ failed: 0 });
    mockCheckManualFailoverReadiness.mockResolvedValue({ ready: true, blockers: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("conceals disabled, unauthorized, and production-hosted endpoints", async () => {
    process.env.SUPABASE_MIGRATION_ENDPOINT_ENABLED = "0";
    expect((await POST(request({ payload: cutoverPayload() }))).status).toBe(404);

    setTargetEnv();
    expect((await POST(request({
      adminKey: "wrong",
      payload: cutoverPayload(),
    }))).status).toBe(404);
    expect((await POST(request({
      host: "www.rooindustries.com",
      payload: cutoverPayload(),
    }))).status).toBe(404);
    expect((await POST(request({
      forwardedHost: "preview.example.vercel.app, rooindustries.com.",
      payload: cutoverPayload(),
    }))).status).toBe(404);
    expect((await POST(request({
      forwardedHost: "preview.example.vercel.app",
      host: "www.rooindustries.com",
      payload: cutoverPayload(),
    }))).status).toBe(404);

    process.env.VERCEL_ENV = "production";
    expect((await POST(request({ payload: cutoverPayload() }))).status).toBe(404);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects unknown actions instead of falling through to migration", async () => {
    const response = await POST(request({ payload: { action: "migrtae" } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid migration action.",
    });
    expect(mockMigrate).not.toHaveBeenCalled();
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects an oversized migration request before target inspection", async () => {
    const response = await POST(request({
      payload: cutoverPayload(),
      contentLength: String(64 * 1024 + 1),
    }));
    expect(response.status).toBe(413);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
    expect(mockMigrate).not.toHaveBeenCalled();
  });

  test("requires fingerprint acknowledgement for inherited production targets", async () => {
    const selected = previewTargetEnv();
    const fingerprints = setTargetEnv({
      TOURNEY_PREVIEW_DATABASE_URL: selected.TOURNEY_DATABASE_URL.replace(
        "production_owner",
        "preview_role"
      ),
      SUPABASE_PREVIEW_DATABASE_URL: selected.SUPABASE_DATABASE_URL.replace(
        "postgres.production",
        "preview.production"
      ),
      SUPABASE_PREVIEW_URL: selected.SUPABASE_URL,
    });

    let response = await POST(request({ payload: cutoverPayload() }));
    let body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      error: "Migration target validation failed.",
      code: "MIGRATION_TARGET_VALIDATION_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("postgresql://");
    expect(JSON.stringify(body)).not.toContain("placeholder");
    expect(mockGetBackendSql).not.toHaveBeenCalled();

    process.env.SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS = "1";
    response = await POST(request({ payload: cutoverPayload() }));
    body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe("PRODUCTION_MUTATION_ACKNOWLEDGEMENT_REQUIRED");
    expect(mockGetBackendSql).not.toHaveBeenCalled();

    response = await POST(request({
      payload: cutoverPayload({
        productionMutationAcknowledgement: {
          confirmed: true,
          action: "cutover-control",
          legacyTargetFingerprint: fingerprints.legacy,
          supabaseTargetFingerprint: fingerprints.supabase,
        },
      }),
    }));
    expect(response.status).toBe(200);
    expect(mockGetBackendSql).toHaveBeenCalled();
  });

  test("allows flagged inherited targets for read-only health checks", async () => {
    const selected = previewTargetEnv();
    setTargetEnv({
      SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS: "1",
      TOURNEY_PREVIEW_DATABASE_URL: selected.TOURNEY_DATABASE_URL.replace(
        "production_owner",
        "preview_role"
      ),
    });

    const response = await POST(request({
      payload: { action: "backend-health" },
    }));

    expect(response.status).toBe(200);
    expect(mockGetBackendSql).toHaveBeenCalledTimes(2);
  });

  test("detects inherited targets through nonempty fallback variables", async () => {
    const selected = previewTargetEnv();
    setTargetEnv({
      TOURNEY_DATABASE_URL: "   ",
      POSTGRES_URL: selected.TOURNEY_DATABASE_URL,
      TOURNEY_PREVIEW_DATABASE_URL: selected.TOURNEY_DATABASE_URL.replace(
        "production_owner",
        "preview_role"
      ),
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects an inherited legacy target even if the generic Supabase target is invalid", async () => {
    const selected = previewTargetEnv();
    setTargetEnv({
      TOURNEY_PREVIEW_DATABASE_URL: selected.TOURNEY_DATABASE_URL.replace(
        "production_owner",
        "preview_role"
      ),
      SUPABASE_DATABASE_URL: "not-a-postgres-url",
      SUPABASE_URL: "",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects an inherited Supabase target even if the generic legacy target is invalid", async () => {
    const selected = previewTargetEnv();
    setTargetEnv({
      TOURNEY_DATABASE_URL: "not-a-postgres-url",
      SUPABASE_PREVIEW_DATABASE_URL: selected.SUPABASE_DATABASE_URL.replace(
        "postgres.production",
        "preview.production"
      ),
      SUPABASE_PREVIEW_URL: selected.SUPABASE_URL,
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects an inherited Supabase database behind a different API URL", async () => {
    const selected = previewTargetEnv();
    setTargetEnv({
      SUPABASE_PREVIEW_DATABASE_URL: selected.SUPABASE_DATABASE_URL.replace(
        "postgres.production",
        "preview.production"
      ),
      SUPABASE_PREVIEW_URL: "https://preview-auth.example.com",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects an inherited Supabase API paired with a different database", async () => {
    setTargetEnv({
      SUPABASE_URL: "https://auth.production.example.com",
      SUPABASE_PREVIEW_URL: "https://auth.production.example.com",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects a target whose configured fingerprint changed", async () => {
    process.env.SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT = "f".repeat(64);

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("requires the production flag and per-request fingerprint acknowledgement", async () => {
    const fingerprints = setTargetEnv({
      SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "production",
      SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS: "0",
    });
    let response = await POST(request({ payload: cutoverPayload() }));
    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();

    process.env.SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS = "1";
    response = await POST(request({ payload: cutoverPayload() }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(
      "PRODUCTION_MUTATION_ACKNOWLEDGEMENT_REQUIRED"
    );
    expect(mockGetBackendSql).not.toHaveBeenCalled();

    const acknowledgement = {
      confirmed: true,
      action: "cutover-control",
      legacyTargetFingerprint: fingerprints.legacy,
      supabaseTargetFingerprint: "f".repeat(64),
    };
    response = await POST(request({
      payload: cutoverPayload({
        productionMutationAcknowledgement: acknowledgement,
      }),
    }));
    expect(response.status).toBe(409);
    expect(mockGetBackendSql).not.toHaveBeenCalled();

    acknowledgement.supabaseTargetFingerprint = fingerprints.supabase;
    response = await POST(request({
      payload: cutoverPayload({
        productionMutationAcknowledgement: acknowledgement,
      }),
    }));
    expect(response.status).toBe(200);
  });

  test.each([
    ["legacy", { failLegacyProbe: true }],
    ["Supabase", { failSupabaseProbe: true }],
  ])("does not write when the %s target probe fails", async (_target, options) => {
    const databases = setDatabases(options);

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(500);
    expect(databases.legacy.updates).toEqual([]);
    expect(databases.supabase.updates).toEqual([]);
  });

  test.each([
    ["a missing writes-paused value", { writesPaused: undefined }],
    ["a string writes-paused value", { writesPaused: "true" }],
    ["a string generation", { generation: "1" }],
  ])("rejects cutover control with %s", async (_case, override) => {
    const databases = setDatabases();

    const response = await POST(request({ payload: cutoverPayload(override) }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid cutover control state.",
    });
    expect(databases.legacy.updates).toEqual([]);
    expect(databases.supabase.updates).toEqual([]);
  });

  test("rejects a combined authority switch and write resumption", async () => {
    const databases = setDatabases();

    const response = await POST(request({
      payload: cutoverPayload({ writesPaused: false }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "TOURNEY_CUTOVER_SEPARATE_UNPAUSE_REQUIRED",
    });
    expect(databases.legacy.updates).toEqual([]);
    expect(databases.supabase.updates).toEqual([]);
  });

  test("allows write resumption only after both paused controls share authority", async () => {
    const databases = setDatabases();
    const paused = await POST(request({ payload: cutoverPayload() }));
    expect(paused.status).toBe(200);

    const resumed = await POST(request({
      payload: cutoverPayload({ writesPaused: false }),
    }));

    expect(resumed.status).toBe(200);
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: false,
    });
    expect(databases.supabase.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: false,
    });
  });

  test.each([
    ["a Discord blocker", { supabaseReadiness: { discord: 1 } }, "supabase_discord"],
    ["an inactive legacy schema", { legacyReadiness: { hardened_active: false } }, "legacy_schema_v4"],
    ["a missing account snapshot", { legacyReadiness: { account_snapshots: 0 } }, "legacy_account_snapshot"],
    ["stale parity", { supabaseParity: { fresh: false } }, "parity"],
  ])("keeps Supabase writes paused for %s", async (_label, options, blocker) => {
    const databases = setDatabases(options);
    expect((await POST(request({ payload: cutoverPayload() }))).status).toBe(200);

    const response = await POST(request({
      payload: cutoverPayload({ writesPaused: false }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "TOURNEY_RESUME_NOT_READY",
      blockers: expect.arrayContaining([blocker]),
    });
    expect(databases.legacy.state.writes_paused).toBe(true);
    expect(databases.supabase.state.writes_paused).toBe(true);
  });

  test("validates both databases before the first dual-target write", async () => {
    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      primaryBackend: "supabase",
      generation: 1,
      writesPaused: true,
    });
    const firstUpdate = events.findIndex((event) => event.includes(":update:"));
    expect(firstUpdate).toBeGreaterThan(events.indexOf("legacy:probe"));
    expect(firstUpdate).toBeGreaterThan(events.indexOf("supabase:probe"));
    expect(firstUpdate).toBeGreaterThan(events.indexOf("legacy:read-control"));
    expect(firstUpdate).toBeGreaterThan(events.indexOf("supabase:read-control"));
  });

  test("compensates the first control row and recovers on retry", async () => {
    const databases = setDatabases({ failSupabaseUpdate: true });
    const response = await POST(request({ payload: cutoverPayload() }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "Tourney shadow migration failed.",
      code: "TOURNEY_CUTOVER_SECOND_TARGET_FAILED_COMPENSATED",
    });
    expect(databases.legacy.updates).toEqual([
      {
        primaryBackend: "supabase",
        generation: 1,
        writesPaused: true,
        actor: "manual-cutover",
      },
      {
        primaryBackend: "legacy",
        generation: 0,
        writesPaused: true,
        actor: "manual-cutover-compensation",
      },
    ]);
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "legacy",
      generation: 0,
      writes_paused: true,
    });
    expect(JSON.stringify(body)).not.toContain("fixture update failed");

    const retry = await POST(request({ payload: cutoverPayload() }));
    expect(retry.status).toBe(200);
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
    });
    expect(databases.supabase.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
    });
  });

  test("continues after a committed first-target transport error", async () => {
    const databases = setDatabases({
      failLegacyUpdate: true,
      failLegacyUpdateAfterApply: true,
      legacyUpdateErrorCode: "ECONNRESET",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(200);
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
    });
    expect(databases.supabase.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
    });
  });

  test("treats a committed second-target update as success after a transport error", async () => {
    const databases = setDatabases({
      failSupabaseUpdate: true,
      failSupabaseUpdateAfterApply: true,
      supabaseUpdateErrorCode: "ECONNRESET",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(200);
    expect(databases.legacy.updates).toHaveLength(1);
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
    });
    expect(databases.supabase.state).toMatchObject({
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
    });
  });

  test("reports an unverified first-target transport outcome as recoverable", async () => {
    const databases = setDatabases({
      failLegacyUpdate: true,
      legacyUpdateErrorCode: "ECONNRESET",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe(
      "TOURNEY_CUTOVER_RECOVERY_REQUIRED"
    );
    expect(databases.legacy.state.primary_backend).toBe("legacy");
    expect(databases.supabase.updates).toEqual([]);

    const retry = await POST(request({ payload: cutoverPayload() }));
    expect(retry.status).toBe(200);
    expect(databases.legacy.state.primary_backend).toBe("supabase");
    expect(databases.supabase.state.primary_backend).toBe("supabase");
  });

  test("compensates but keeps an unverified second-target outcome recoverable", async () => {
    const databases = setDatabases({
      failSupabaseUpdate: true,
      supabaseUpdateErrorCode: "ECONNRESET",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe(
      "TOURNEY_CUTOVER_RECOVERY_REQUIRED"
    );
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "legacy",
      generation: 0,
      writes_paused: true,
    });
    expect(mockLogSafeError).toHaveBeenCalledWith(
      "Tourney cutover second-target outcome remained ambiguous",
      expect.any(Error)
    );

    const retry = await POST(request({ payload: cutoverPayload() }));
    expect(retry.status).toBe(200);
    expect(databases.legacy.state.primary_backend).toBe("supabase");
    expect(databases.supabase.state.primary_backend).toBe("supabase");
  });

  test("fails closed when the two control rows already disagree", async () => {
    const databases = setDatabases({ failSupabaseUpdate: true });
    Object.assign(databases.legacy.state, {
      primary_backend: "supabase",
      generation: 1,
      writes_paused: true,
      updated_by: "interrupted-cutover",
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(
      "TOURNEY_CUTOVER_CONTROL_MISMATCH"
    );
    expect(databases.supabase.state.primary_backend).toBe("legacy");
    expect(databases.legacy.updates).toEqual([]);
    expect(databases.supabase.updates).toEqual([]);
  });

  test("does not compensate over a newer concurrent control update", async () => {
    const databases = setDatabases({
      failSupabaseUpdate: true,
      beforeSupabaseFailure: (legacy) => {
        Object.assign(legacy.state, {
          primary_backend: "supabase",
          generation: 9,
          writes_paused: true,
          updated_by: "concurrent-cutover",
          row_version: String(Number(legacy.state.row_version) + 1),
        });
      },
    });

    const response = await POST(request({ payload: cutoverPayload() }));

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe(
      "TOURNEY_CUTOVER_RECOVERY_REQUIRED"
    );
    expect(databases.legacy.state).toMatchObject({
      primary_backend: "supabase",
      generation: 9,
      writes_paused: true,
      updated_by: "concurrent-cutover",
    });
    expect(mockLogSafeError).toHaveBeenCalledWith(
      "Tourney cutover compensation failed",
      expect.any(Error)
    );
  });
});

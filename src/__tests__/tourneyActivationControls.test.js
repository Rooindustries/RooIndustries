const mockGetBackendSql = jest.fn();
const mockResolvePolicy = jest.fn();
const mockCheckManualFailoverReadiness = jest.fn();
const mockComputeFingerprints = jest.fn();
const legacyFingerprint = "a".repeat(64);
const supabaseFingerprint = "b".repeat(64);

jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/supabase/migrationTargetSafety.cjs", () => ({
  computeMigrationTargetFingerprints: (...args) => mockComputeFingerprints(...args),
}));
jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
}));
jest.mock("../server/tourney/store", () => ({
  checkTourneyManualFailoverReadiness: (...args) =>
    mockCheckManualFailoverReadiness(...args),
  resolveTourneyStorePolicy: (...args) => mockResolvePolicy(...args),
}));

const {
  readTourneyDualDatabaseCutoverState,
  setTourneyDualDatabaseWritesPausedV4,
} = require("../server/tourney/cutoverControl.js");

const env = {
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "0",
  TOURNEY_FAILOVER_GENERATION: "1",
  SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT: legacyFingerprint,
  SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT: supabaseFingerprint,
};
const operationId = "pause-20260715t000000z";
const actor = `schema-v4-pause:${operationId}`;
const row = ({
  lastPauseOperationId = null,
  lastResumeOperationId = null,
  paused,
  updatedBy = "previous",
  version,
}) => ({
  primary_backend: "supabase",
  generation: 1,
  writes_paused: paused,
  updated_by: updatedBy,
  last_pause_operation_id: lastPauseOperationId,
  last_resume_operation_id: lastResumeOperationId,
  row_version: version,
});
const sqlMock = (...results) => {
  let resultIndex = 0;
  let nextOperationInsertError = null;
  const ledger = new Map();
  const sql = jest.fn((first, ...values) => {
    if (typeof first === "string") return first;
    const text = first.join(" ").replace(/\s+/g, " ").trim();
    if (text.includes("set_config('roo.tourney_cutover_compensation'")) {
      return Promise.resolve([{ set_config: "1" }]);
    }
    if (text.startsWith("select operation_kind") && text.includes("target_writes_paused")) {
      const [, kind, id] = values;
      const record = ledger.get(`${kind}:${id}`);
      return Promise.resolve(record ? [record] : []);
    }
    if (text.startsWith("insert into") && text.includes("operation_kind")) {
      if (nextOperationInsertError) {
        const error = nextOperationInsertError;
        nextOperationInsertError = null;
        return Promise.reject(error);
      }
      const [, kind, id, primaryBackend, generation, writesPaused] = values;
      const key = `${kind}:${id}`;
      if (ledger.has(key)) {
        return Promise.reject(Object.assign(new Error("duplicate operation"), {
          code: "23505",
        }));
      }
      const record = {
        operation_kind: kind,
        operation_id: id,
        primary_backend: primaryBackend,
        generation,
        target_writes_paused: writesPaused,
      };
      ledger.set(key, record);
      return Promise.resolve([record]);
    }
    if (text.startsWith("delete from") && text.includes("operation_kind")) {
      const [, kind, id] = values;
      const removed = ledger.delete(`${kind}:${id}`);
      return Promise.resolve(removed ? [{ operation_id: id }] : []);
    }
    const result = results[resultIndex++];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  sql.begin = jest.fn(async (callback) => {
    const snapshot = new Map(ledger);
    try {
      return await callback(sql);
    } catch (error) {
      ledger.clear();
      for (const [key, value] of snapshot) ledger.set(key, value);
      throw error;
    }
  });
  sql.seedOperation = (record) => {
    ledger.set(`${record.operation_kind}:${record.operation_id}`, record);
  };
  sql.failNextOperationInsert = (error) => {
    nextOperationInsertError = error;
  };
  sql.hasOperation = ({ kind, id }) => ledger.has(`${kind}:${id}`);
  return sql;
};
const operationRow = ({
  id = operationId,
  kind = "pause",
  paused = true,
} = {}) => ({
  operation_kind: kind,
  operation_id: id,
  primary_backend: "supabase",
  generation: 1,
  target_writes_paused: paused,
});
const templateCalls = (sql) => sql.mock.calls.filter(([first]) =>
  typeof first !== "string"
);
const callsContaining = (sql, fragment) => templateCalls(sql).filter(([first]) =>
  first.join(" ").includes(fragment)
);
const request = (overrides = {}) => ({
  env,
  expectedPrimaryBackend: "supabase",
  expectedGeneration: 1,
  expectedWritesPaused: false,
  legacyTargetFingerprint: legacyFingerprint,
  operationId,
  supabaseTargetFingerprint: supabaseFingerprint,
  writesPaused: true,
  ...overrides,
});

describe("Tourney dual-database activation controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComputeFingerprints.mockReturnValue({
      legacy: legacyFingerprint,
      supabase: supabaseFingerprint,
    });
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      mirrorEnabled: true,
      writesPaused: false,
      generation: 1,
    });
    mockCheckManualFailoverReadiness.mockResolvedValue({ ready: true, blockers: [] });
  });

  test("updates and verifies both controls with compare-and-set", async () => {
    const legacySql = sqlMock(
      [row({ paused: false, version: "10" })],
      [row({
        paused: true,
        updatedBy: actor,
        lastPauseOperationId: operationId,
        version: "11",
      })],
      [row({
        paused: true,
        updatedBy: actor,
        lastPauseOperationId: operationId,
        version: "11",
      })]
    );
    const supabaseSql = sqlMock(
      [row({ paused: false, version: "20" })],
      [row({
        paused: true,
        updatedBy: actor,
        lastPauseOperationId: operationId,
        version: "21",
      })],
      [row({
        paused: true,
        updatedBy: actor,
        lastPauseOperationId: operationId,
        version: "21",
      })]
    );
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).resolves.toEqual({
      changed: true,
      replayed: false,
      superseded: false,
      controls: {
        legacy: {
          primaryBackend: "supabase",
          generation: 1,
          writesPaused: true,
          lastPauseOperationId: operationId,
          lastResumeOperationId: null,
        },
        supabase: {
          primaryBackend: "supabase",
          generation: 1,
          writesPaused: true,
          lastPauseOperationId: operationId,
          lastResumeOperationId: null,
        },
      },
      fingerprints: { legacy: legacyFingerprint, supabase: supabaseFingerprint },
    });
    expect(callsContaining(legacySql, "xmin =")).toHaveLength(1);
    expect(callsContaining(supabaseSql, "xmin =")).toHaveLength(1);
    expect(legacySql.begin).toHaveBeenCalledTimes(1);
    expect(supabaseSql.begin).toHaveBeenCalledTimes(1);
  });

  test("accepts only an operation-bound idempotent replay", async () => {
    const applied = row({
      paused: true,
      updatedBy: actor,
      lastPauseOperationId: operationId,
      version: "11",
    });
    const legacySql = sqlMock([applied]);
    const supabaseSql = sqlMock([applied]);
    legacySql.seedOperation(operationRow());
    supabaseSql.seedOperation(operationRow());
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).resolves.toMatchObject({
      changed: false,
      replayed: true,
    });
    expect(templateCalls(legacySql)).toHaveLength(2);
    expect(templateCalls(supabaseSql)).toHaveLength(2);
    expect(legacySql.begin).not.toHaveBeenCalled();
    expect(supabaseSql.begin).not.toHaveBeenCalled();
  });

  test("does not re-pause a delayed pause after multiple inverse cycles", async () => {
    const resumed = row({
      paused: false,
      lastPauseOperationId: "pause-20260715t030000z",
      lastResumeOperationId: "resume-20260715t040000z",
      updatedBy: "schema-v4-resume:resume-20260715t040000z",
      version: "14",
    });
    const legacySql = sqlMock([resumed]);
    const supabaseSql = sqlMock([resumed]);
    legacySql.seedOperation(operationRow());
    supabaseSql.seedOperation(operationRow());
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).resolves.toMatchObject({
      changed: false,
      replayed: true,
      superseded: true,
      controls: {
        legacy: {
          writesPaused: false,
          lastPauseOperationId: "pause-20260715t030000z",
          lastResumeOperationId: "resume-20260715t040000z",
        },
      },
    });
    expect(templateCalls(legacySql)).toHaveLength(2);
    expect(templateCalls(supabaseSql)).toHaveLength(2);
    expect(legacySql.begin).not.toHaveBeenCalled();
    expect(supabaseSql.begin).not.toHaveBeenCalled();
  });

  test("serves concurrent duplicate replays from the immutable ledger", async () => {
    const applied = row({
      paused: true,
      updatedBy: actor,
      lastPauseOperationId: operationId,
      version: "11",
    });
    const legacySql = sqlMock([applied], [applied]);
    const supabaseSql = sqlMock([applied], [applied]);
    legacySql.seedOperation(operationRow());
    supabaseSql.seedOperation(operationRow());
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    const results = await Promise.all([
      setTourneyDualDatabaseWritesPausedV4(request()),
      setTourneyDualDatabaseWritesPausedV4(request()),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ changed: false, replayed: true, superseded: false }),
      expect.objectContaining({ changed: false, replayed: true, superseded: false }),
    ]);
    expect(legacySql.begin).not.toHaveBeenCalled();
    expect(supabaseSql.begin).not.toHaveBeenCalled();
  });

  test("fails closed when only one backend records an operation", async () => {
    const current = row({ paused: false, version: "10" });
    const legacySql = sqlMock([current]);
    const supabaseSql = sqlMock([current]);
    legacySql.seedOperation(operationRow());
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_RECOVERY_REQUIRED",
      status: 503,
    });
    expect(legacySql.begin).not.toHaveBeenCalled();
    expect(supabaseSql.begin).not.toHaveBeenCalled();
  });

  test("fails closed when backend ledgers disagree on an operation target", async () => {
    const current = row({ paused: false, version: "10" });
    const legacySql = sqlMock([current]);
    const supabaseSql = sqlMock([current]);
    legacySql.seedOperation(operationRow());
    supabaseSql.seedOperation(operationRow({ paused: false }));
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_RECOVERY_REQUIRED",
      status: 503,
    });
    expect(legacySql.begin).not.toHaveBeenCalled();
    expect(supabaseSql.begin).not.toHaveBeenCalled();
  });

  test("rolls back a control CAS when its ledger insert fails", async () => {
    const expected = row({ paused: false, version: "10" });
    const changed = row({
      paused: true,
      updatedBy: actor,
      lastPauseOperationId: operationId,
      version: "11",
    });
    const legacySql = sqlMock([expected], [changed], [expected]);
    const supabaseSql = sqlMock([{ ...expected, row_version: "20" }]);
    legacySql.failNextOperationInsert(Object.assign(new Error("ledger rejected"), {
      code: "23514",
    }));
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "23514",
    });
    expect(legacySql.begin).toHaveBeenCalledTimes(1);
    expect(supabaseSql.begin).not.toHaveBeenCalled();
    expect(legacySql.hasOperation({ kind: "pause", id: operationId })).toBe(false);
  });

  test("rejects a stale expected state before either write", async () => {
    const current = row({ paused: true, updatedBy: "another-operation", version: "11" });
    const legacySql = sqlMock([current]);
    const supabaseSql = sqlMock([current]);
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_EXPECTATION_MISMATCH",
      status: 409,
    });
    expect(templateCalls(legacySql)).toHaveLength(2);
    expect(templateCalls(supabaseSql)).toHaveLength(2);
  });

  test("compensates a verified second-target failure", async () => {
    const expectedLegacy = row({ paused: false, version: "10" });
    const expectedSupabase = row({ paused: false, version: "20" });
    const changedLegacy = row({
      paused: true,
      updatedBy: actor,
      lastPauseOperationId: operationId,
      version: "11",
    });
    const restoredLegacy = row({ paused: false, updatedBy: `${actor}:compensated`, version: "12" });
    const legacySql = sqlMock(
      [expectedLegacy],
      [changedLegacy],
      [changedLegacy],
      [restoredLegacy],
      [restoredLegacy]
    );
    const supabaseSql = sqlMock(
      [expectedSupabase],
      Object.assign(new Error("constraint rejected"), { code: "23514" }),
      [expectedSupabase],
      [expectedSupabase]
    );
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_SECOND_TARGET_FAILED_COMPENSATED",
      status: 503,
    });
    expect(legacySql.begin).toHaveBeenCalledTimes(2);
    expect(supabaseSql.begin).toHaveBeenCalledTimes(1);
    expect(callsContaining(legacySql, "roo.tourney_cutover_compensation")).toHaveLength(1);
    expect(callsContaining(legacySql, "delete from")).toHaveLength(1);
    expect(legacySql.hasOperation({ kind: "pause", id: operationId })).toBe(false);
  });

  test("requires recovery when a partial outcome cannot be observed", async () => {
    const expected = row({ paused: false, version: "10" });
    const changed = row({
      paused: true,
      updatedBy: actor,
      lastPauseOperationId: operationId,
      version: "11",
    });
    const legacySql = sqlMock(
      [expected],
      [changed],
      new Error("legacy unreadable")
    );
    const supabaseSql = sqlMock(
      [{ ...expected, row_version: "20" }],
      new Error("Supabase timeout")
    );
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_RECOVERY_REQUIRED",
      status: 503,
    });
  });

  test("requires the deployment to stay paused before database resume", async () => {
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      mirrorEnabled: true,
      writesPaused: false,
      generation: 1,
    });

    await expect(setTourneyDualDatabaseWritesPausedV4(request({
      operationId: "resume-20260715t010000z",
      expectedWritesPaused: true,
      writesPaused: false,
    }))).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_DEPLOYMENT_MISMATCH",
      status: 409,
    });
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects a loosely typed expected generation before database access", async () => {
    await expect(setTourneyDualDatabaseWritesPausedV4(request({
      expectedGeneration: "1",
    }))).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_CONTROL_REQUEST_INVALID",
      status: 400,
    });
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("rejects unpinned or unacknowledged runtime targets before database access", async () => {
    mockComputeFingerprints.mockReturnValueOnce({
      legacy: "c".repeat(64),
      supabase: supabaseFingerprint,
    });
    await expect(setTourneyDualDatabaseWritesPausedV4(request())).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_TARGET_FINGERPRINT_MISMATCH",
      status: 409,
    });
    expect(mockGetBackendSql).not.toHaveBeenCalled();

    await expect(setTourneyDualDatabaseWritesPausedV4(request({
      legacyTargetFingerprint: undefined,
    }))).rejects.toMatchObject({
      code: "TOURNEY_CUTOVER_TARGET_FINGERPRINT_REQUIRED",
      status: 400,
    });
    expect(mockGetBackendSql).not.toHaveBeenCalled();
  });

  test("returns normalized cutover state and credential-free fingerprints", async () => {
    const control = row({
      paused: true,
      lastPauseOperationId: operationId,
      version: "11",
    });
    const legacySql = sqlMock([control]);
    const supabaseSql = sqlMock([control]);
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(readTourneyDualDatabaseCutoverState({ env })).resolves.toEqual({
      controls: {
        legacy: {
          primaryBackend: "supabase",
          generation: 1,
          writesPaused: true,
          lastPauseOperationId: operationId,
          lastResumeOperationId: null,
        },
        supabase: {
          primaryBackend: "supabase",
          generation: 1,
          writesPaused: true,
          lastPauseOperationId: operationId,
          lastResumeOperationId: null,
        },
      },
      fingerprints: { legacy: legacyFingerprint, supabase: supabaseFingerprint },
    });
  });
});

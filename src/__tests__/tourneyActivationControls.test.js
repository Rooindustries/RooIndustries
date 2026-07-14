const mockGetBackendSql = jest.fn();
const mockResolvePolicy = jest.fn();
const mockCheckManualFailoverReadiness = jest.fn();

jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySqlForBackend: (...args) => mockGetBackendSql(...args),
}));
jest.mock("../server/tourney/store", () => ({
  checkTourneyManualFailoverReadiness: (...args) =>
    mockCheckManualFailoverReadiness(...args),
  resolveTourneyStorePolicy: (...args) => mockResolvePolicy(...args),
}));

const {
  setTourneyDualDatabaseWritesPausedV4,
} = require("../server/tourney/cutoverControl.js");

const env = {
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "0",
  TOURNEY_FAILOVER_GENERATION: "1",
};
const operationId = "pause-20260715t000000z";
const actor = `schema-v4-pause:${operationId}`;
const row = ({ paused, updatedBy = "previous", version }) => ({
  primary_backend: "supabase",
  generation: 1,
  writes_paused: paused,
  updated_by: updatedBy,
  row_version: version,
});
const sqlMock = (...results) => {
  let resultIndex = 0;
  return jest.fn((first) => {
    if (typeof first === "string") return first;
    const result = results[resultIndex++];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
};
const templateCalls = (sql) => sql.mock.calls.filter(([first]) =>
  typeof first !== "string"
);
const request = (overrides = {}) => ({
  env,
  expectedPrimaryBackend: "supabase",
  expectedGeneration: 1,
  expectedWritesPaused: false,
  operationId,
  writesPaused: true,
  ...overrides,
});

describe("Tourney dual-database activation controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      [row({ paused: true, updatedBy: actor, version: "11" })],
      [row({ paused: true, updatedBy: actor, version: "11" })]
    );
    const supabaseSql = sqlMock(
      [row({ paused: false, version: "20" })],
      [row({ paused: true, updatedBy: actor, version: "21" })],
      [row({ paused: true, updatedBy: actor, version: "21" })]
    );
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).resolves.toEqual({
      changed: true,
      replayed: false,
      controls: {
        legacy: { primaryBackend: "supabase", generation: 1, writesPaused: true },
        supabase: { primaryBackend: "supabase", generation: 1, writesPaused: true },
      },
    });
    expect(templateCalls(legacySql)[1][0].join(" ")).toContain("xmin =");
    expect(templateCalls(supabaseSql)[1][0].join(" ")).toContain("xmin =");
  });

  test("accepts only an operation-bound idempotent replay", async () => {
    const applied = row({ paused: true, updatedBy: actor, version: "11" });
    const legacySql = sqlMock([applied]);
    const supabaseSql = sqlMock([applied]);
    mockGetBackendSql.mockImplementation(({ backend }) =>
      Promise.resolve(backend === "legacy" ? legacySql : supabaseSql)
    );

    await expect(setTourneyDualDatabaseWritesPausedV4(request())).resolves.toMatchObject({
      changed: false,
      replayed: true,
    });
    expect(templateCalls(legacySql)).toHaveLength(1);
    expect(templateCalls(supabaseSql)).toHaveLength(1);
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
    expect(templateCalls(legacySql)).toHaveLength(1);
    expect(templateCalls(supabaseSql)).toHaveLength(1);
  });

  test("compensates a verified second-target failure", async () => {
    const expectedLegacy = row({ paused: false, version: "10" });
    const expectedSupabase = row({ paused: false, version: "20" });
    const changedLegacy = row({ paused: true, updatedBy: actor, version: "11" });
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
  });

  test("requires recovery when a partial outcome cannot be observed", async () => {
    const expected = row({ paused: false, version: "10" });
    const changed = row({ paused: true, updatedBy: actor, version: "11" });
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
});

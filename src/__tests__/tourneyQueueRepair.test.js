const mockResolveTourneyStorePolicy = jest.fn((env = {}) => ({
  primaryBackend: env.TOURNEY_DATABASE_MODE === "legacy" ? "legacy" : "supabase",
  mirrorEnabled: env.TOURNEY_MIRROR_ENABLED === "1",
  writesPaused: env.TOURNEY_WRITES_PAUSED === "1",
  generation: Number(env.TOURNEY_FAILOVER_GENERATION || 1),
}));
const mockRunTourneyTransaction = jest.fn();

jest.mock("../server/tourney/sqlClient.js", () => ({
  getTourneySql: jest.fn(),
  runTourneyTransaction: (...args) => mockRunTourneyTransaction(...args),
}));
jest.mock("../server/tourney/store.js", () => ({
  resolveTourneyStorePolicy: (...args) => mockResolveTourneyStorePolicy(...args),
}));
jest.mock("../server/tourney/email.js", () => ({
  sendTourneyAppealAdminEmail: jest.fn(),
  sendTourneyAppealConfirmationEmail: jest.fn(),
  sendTourneyDiscordInviteEmail: jest.fn(),
  sendTourneyPayoutNotificationEmail: jest.fn(),
  sendTourneyPlayerApprovedEmail: jest.fn(),
  sendTourneyRegistrationApprovalEmails: jest.fn(),
  sendTourneyResetEmail: jest.fn(),
}));

const {
  rearmTourneyExternalOperation,
  repairTourneyExternalOperation,
} = require("../server/tourney/externalOperations.js");
const {
  repairTourneyEmailDispatch,
} = require("../server/tourney/emailDispatch.js");

const ENV = Object.freeze({
  NODE_ENV: "production",
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_FAILOVER_GENERATION: "1",
  TOURNEY_HARDENING_V4_ENABLED: "1",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "1",
});
const CONTROL = Object.freeze({
  primary_backend: "supabase",
  generation: 1,
  writes_paused: true,
  hardened_active: true,
});
const OPERATION_KEY = "command-00000001:discord_role_reconcile:player:1";
const DISPATCH_ID = "123e4567-e89b-42d3-a456-426614174000";

const createSql = ({
  control = CONTROL,
  dispatch = null,
  operation = null,
} = {}) => {
  const calls = [];
  const sql = (strings, ...values) => {
    if (typeof strings === "string") return strings;
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    calls.push({ query, values });
    if (query.includes("select primary_backend, generation, writes_paused")) {
      return Promise.resolve(control ? [control] : []);
    }
    if (query.includes("select operation_key, operation_kind, status")) {
      return Promise.resolve(operation ? [operation] : []);
    }
    if (query.includes("select id, dispatch_kind, status")) {
      return Promise.resolve(dispatch ? [dispatch] : []);
    }
    if (query.includes("returning operation_key")) {
      return Promise.resolve(operation ? [{ operation_key: operation.operation_key }] : []);
    }
    if (query.includes("returning id")) {
      return Promise.resolve(dispatch ? [{ id: dispatch.id }] : []);
    }
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.json = jest.fn((value) => value);
  return sql;
};

const useSql = (sql) => {
  mockRunTourneyTransaction.mockImplementation(({ callback }) => callback(sql));
};

describe("audited Tourney queue repair", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("requires both runtime and active database pause controls", async () => {
    await expect(repairTourneyExternalOperation({
      actor: "ops_console",
      env: { ...ENV, TOURNEY_WRITES_PAUSED: "0" },
      operationKey: OPERATION_KEY,
      reason: "verified_provider_recovery",
    })).rejects.toMatchObject({
      code: "TOURNEY_REPAIR_WRITES_NOT_PAUSED",
      status: 409,
    });
    expect(mockRunTourneyTransaction).not.toHaveBeenCalled();

    const sql = createSql({
      control: { ...CONTROL, hardened_active: false },
      operation: {
        operation_key: OPERATION_KEY,
        operation_kind: "discord_role_reconcile",
        status: "dead_letter",
      },
    });
    useSql(sql);
    await expect(repairTourneyExternalOperation({
      actor: "ops_console",
      env: ENV,
      operationKey: OPERATION_KEY,
      reason: "verified_provider_recovery",
    })).rejects.toMatchObject({
      code: "TOURNEY_REPAIR_CONTROL_NOT_PAUSED",
      status: 409,
    });
    expect(sql.calls.some(({ query }) => query.includes("returning operation_key")))
      .toBe(false);
  });

  test("rearms and audits a replaceable dead-letter without exposing its raw key", async () => {
    const sql = createSql({
      operation: {
        operation_key: OPERATION_KEY,
        operation_kind: "discord_role_reconcile",
        status: "dead_letter",
        lease_expired: false,
      },
    });
    useSql(sql);
    const result = await repairTourneyExternalOperation({
      actor: "ops_console",
      env: ENV,
      operationKey: OPERATION_KEY,
      reason: "verified_provider_recovery",
    });

    expect(result).toMatchObject({
      operationKind: "discord_role_reconcile",
      previousStatus: "dead_letter",
      status: "pending",
      targetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(sql.calls.some(({ query }) =>
      query.includes("status = 'pending'") && query.includes("returning operation_key")
    )).toBe(true);
    expect(sql.calls.some(({ query }) =>
      query.includes("clean_since = null") && query.includes("first_zero_drift_at = null")
    )).toBe(true);
    const evidence = sql.json.mock.calls.at(-1)[0];
    expect(evidence).toEqual(expect.objectContaining({
      operationKind: "discord_role_reconcile",
      previousStatus: "dead_letter",
      reason: "verified_provider_recovery",
      status: "pending",
      targetHash: result.targetHash,
    }));
    expect(JSON.stringify(evidence)).not.toContain(OPERATION_KEY);
    expect(sql.calls.some(({ query, values }) =>
      query.includes("event_kind, generation, actor, evidence") &&
      query.includes("'clock_reset'") &&
      values.includes("ops_console")
    )).toBe(true);
  });

  test("allows only an expired processing lease and never generic identity unlink", async () => {
    const activeSql = createSql({
      operation: {
        operation_key: OPERATION_KEY,
        operation_kind: "supabase_player_auth",
        status: "processing",
        lease_expired: false,
      },
    });
    useSql(activeSql);
    await expect(repairTourneyExternalOperation({
      actor: "ops_console",
      env: ENV,
      operationKey: OPERATION_KEY,
      reason: "expired_worker_lease",
    })).rejects.toMatchObject({ code: "TOURNEY_EXTERNAL_OPERATION_NOT_REPAIRABLE" });

    const expiredSql = createSql({
      operation: {
        operation_key: OPERATION_KEY,
        operation_kind: "supabase_player_auth",
        status: "processing",
        lease_expired: true,
      },
    });
    useSql(expiredSql);
    await expect(repairTourneyExternalOperation({
      actor: "ops_console",
      env: ENV,
      operationKey: OPERATION_KEY,
      reason: "expired_worker_lease",
    })).resolves.toMatchObject({ status: "pending" });

    const identitySql = createSql({
      operation: {
        operation_key: OPERATION_KEY,
        operation_kind: "supabase_identity_unlink",
        status: "dead_letter",
        lease_expired: false,
      },
    });
    useSql(identitySql);
    await expect(repairTourneyExternalOperation({
      actor: "ops_console",
      env: ENV,
      operationKey: OPERATION_KEY,
      reason: "identity_inventory_reviewed",
    })).rejects.toMatchObject({
      code: "TOURNEY_EXTERNAL_OPERATION_REPAIR_FORBIDDEN",
    });
    expect(identitySql.calls.some(({ query }) =>
      query.includes("event_kind, generation, actor, evidence")
    )).toBe(false);

    jest.clearAllMocks();
    await expect(rearmTourneyExternalOperation({
      commandId: "command-00000001",
      entityId: "player-1",
      entityType: "player",
      env: ENV,
      operationKind: "supabase_identity_unlink",
    })).rejects.toMatchObject({
      code: "TOURNEY_EXTERNAL_OPERATION_REPAIR_FORBIDDEN",
    });
    expect(mockRunTourneyTransaction).not.toHaveBeenCalled();
  });

  test.each(["dead_letter", "failed"])(
    "rearms and audits an email in %s state",
    async (status) => {
      const sql = createSql({
        dispatch: { id: DISPATCH_ID, dispatch_kind: "appeal", status },
      });
      useSql(sql);
      const result = await repairTourneyEmailDispatch({
        actor: "ops_console",
        dispatchId: DISPATCH_ID,
        env: ENV,
        reason: "provider_delivery_verified",
      });

      expect(result).toMatchObject({ previousStatus: status, status: "pending" });
      expect(sql.json.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
        dispatchKind: "appeal",
        historicalOverride: false,
        previousStatus: status,
        reason: "provider_delivery_verified",
      }));
    }
  );

  test("requires an explicit audited override for historical email", async () => {
    const dispatch = {
      id: DISPATCH_ID,
      dispatch_kind: "registration",
      status: "historical_unknown",
    };
    const deniedSql = createSql({ dispatch });
    useSql(deniedSql);
    await expect(repairTourneyEmailDispatch({
      actor: "ops_console",
      dispatchId: DISPATCH_ID,
      env: ENV,
      reason: "historical_delivery_authorized",
    })).rejects.toMatchObject({
      code: "TOURNEY_EMAIL_HISTORICAL_OVERRIDE_REQUIRED",
    });
    expect(deniedSql.calls.some(({ query }) => query.includes("returning id"))).toBe(false);

    const allowedSql = createSql({ dispatch });
    useSql(allowedSql);
    await expect(repairTourneyEmailDispatch({
      actor: "ops_console",
      dispatchId: DISPATCH_ID,
      env: ENV,
      historicalOverride: true,
      reason: "historical_delivery_authorized",
    })).resolves.toMatchObject({
      historicalOverride: true,
      previousStatus: "historical_unknown",
      status: "pending",
    });
    const update = allowedSql.calls.find(({ query }) => query.includes("returning id"));
    expect(update.values).toEqual(expect.arrayContaining([
      "ops_console",
      "historical_delivery_authorized",
      true,
    ]));
  });

  test.each(["sent", "expired", "pending", "sending"])(
    "never rearms an email in %s state",
    async (status) => {
      const sql = createSql({
        dispatch: { id: DISPATCH_ID, dispatch_kind: "approval", status },
      });
      useSql(sql);
      await expect(repairTourneyEmailDispatch({
        actor: "ops_console",
        dispatchId: DISPATCH_ID,
        env: ENV,
        historicalOverride: true,
        reason: "manual_repair_reviewed",
      })).rejects.toMatchObject({ code: "TOURNEY_EMAIL_DISPATCH_NOT_REPAIRABLE" });
      expect(sql.calls.some(({ query }) =>
        query.includes("event_kind, generation, actor, evidence")
      )).toBe(false);
    }
  );
});

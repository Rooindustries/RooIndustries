import { logSafeError } from "../safeErrorLog.js";
import migrationTargetSafety from "../supabase/migrationTargetSafety.cjs";
import { getTourneySqlForBackend } from "./sqlClient.js";
import {
  checkTourneyManualFailoverReadiness,
  resolveTourneyStorePolicy,
} from "./store.js";

const { computeMigrationTargetFingerprints } = migrationTargetSafety;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

const cutoverRelation = (backend) => backend === "supabase"
  ? "tourney.cutover_metadata"
  : "tourney_cutover_metadata";

const cutoverOperationRelation = (backend) => backend === "supabase"
  ? "tourney.cutover_control_operations"
  : "tourney_cutover_control_operations";

const normalizeCutoverState = (control) => ({
  primaryBackend: String(control.primary_backend || "").toLowerCase(),
  generation: Number(control.generation),
  writesPaused: control.writes_paused === true,
  rowVersion: String(control.row_version || ""),
  updatedBy: String(control.updated_by || ""),
  lastPauseOperationId: String(control.last_pause_operation_id || ""),
  lastResumeOperationId: String(control.last_resume_operation_id || ""),
});

const sameCutoverState = (left, right) =>
  left.primaryBackend === right.primaryBackend &&
  left.generation === right.generation &&
  left.writesPaused === right.writesPaused;

const sameCutoverMarkers = (left, right) =>
  left.lastPauseOperationId === right.lastPauseOperationId &&
  left.lastResumeOperationId === right.lastResumeOperationId;

const sameCutoverRecord = (left, right) =>
  sameCutoverState(left, right) && sameCutoverMarkers(left, right);

const readCutoverControl = async ({ sql, backend }) => {
  const rows = await sql`
    select primary_backend, generation, writes_paused, updated_by,
      last_pause_operation_id, last_resume_operation_id,
      xmin::text as row_version
    from ${sql(cutoverRelation(backend))}
    where id = 'tourney'
  `;
  if (rows.length !== 1) {
    throw Object.assign(new Error("Tourney cutover control row is missing."), {
      code: "TOURNEY_CUTOVER_CONTROL_MISSING",
    });
  }
  return rows[0];
};

const readNormalizedCutoverControl = async ({ sql, backend }) =>
  normalizeCutoverState(await readCutoverControl({ sql, backend }));

const normalizeCutoverOperation = (row) => row ? ({
  operationKind: String(row.operation_kind || ""),
  operationId: String(row.operation_id || ""),
  primaryBackend: String(row.primary_backend || "").toLowerCase(),
  generation: Number(row.generation),
  writesPaused: row.target_writes_paused === true,
}) : null;

const readCutoverOperation = async ({ sql, backend, operation }) => {
  const rows = await sql`
    select operation_kind, operation_id, primary_backend, generation,
      target_writes_paused
    from ${sql(cutoverOperationRelation(backend))}
    where operation_kind = ${operation.kind} and operation_id = ${operation.id}
  `;
  if (rows.length > 1) {
    throw cutoverFailure("TOURNEY_CUTOVER_OPERATION_LEDGER_INVALID");
  }
  return normalizeCutoverOperation(rows[0]);
};

const sameCutoverOperation = (left, right) => Boolean(left && right) &&
  left.operationKind === right.operationKind &&
  left.operationId === right.operationId &&
  left.primaryBackend === right.primaryBackend &&
  left.generation === right.generation &&
  left.writesPaused === right.writesPaused;

const operationMatchesTarget = (record, operation, state) => Boolean(record) &&
  record.operationKind === operation.kind &&
  record.operationId === operation.id &&
  record.primaryBackend === state.primaryBackend &&
  record.generation === state.generation &&
  record.writesPaused === state.writesPaused;

const writeCutoverControl = async ({
  sql,
  backend,
  state,
  expected,
  actor,
}) => {
  const rows = await sql`
    update ${sql(cutoverRelation(backend))}
    set primary_backend = ${state.primaryBackend}, generation = ${state.generation},
        writes_paused = ${state.writesPaused}, updated_at = now(),
        updated_by = ${actor},
        last_pause_operation_id = ${state.lastPauseOperationId || null},
        last_resume_operation_id = ${state.lastResumeOperationId || null}
    where id = 'tourney' and xmin = ${expected.rowVersion}::xid
    returning primary_backend, generation, writes_paused, updated_by,
      last_pause_operation_id, last_resume_operation_id,
      xmin::text as row_version
  `;
  if (rows.length !== 1) {
    throw Object.assign(new Error("Tourney cutover control update failed."), {
      code: "TOURNEY_CUTOVER_CONTROL_UPDATE_FAILED",
    });
  }
  return normalizeCutoverState(rows[0]);
};

const cutoverFailure = (code, cause, status = 503) => Object.assign(
  new Error("Tourney cutover control requires recovery."),
  { code, cause, status }
);

const insertCutoverOperation = async ({ sql, backend, operation, state, actor }) => {
  const rows = await sql`
    insert into ${sql(cutoverOperationRelation(backend))} (
      operation_kind, operation_id, primary_backend, generation,
      target_writes_paused, actor
    ) values (
      ${operation.kind}, ${operation.id}, ${state.primaryBackend},
      ${state.generation}, ${state.writesPaused}, ${actor}
    )
    returning operation_kind, operation_id, primary_backend, generation,
      target_writes_paused
  `;
  if (rows.length !== 1) {
    throw cutoverFailure("TOURNEY_CUTOVER_OPERATION_INSERT_FAILED");
  }
  return normalizeCutoverOperation(rows[0]);
};

const deleteCutoverOperation = async ({ sql, backend, operation }) => {
  const rows = await sql`
    delete from ${sql(cutoverOperationRelation(backend))}
    where operation_kind = ${operation.kind} and operation_id = ${operation.id}
    returning operation_id
  `;
  if (rows.length !== 1) {
    throw cutoverFailure("TOURNEY_CUTOVER_OPERATION_DELETE_FAILED");
  }
};

const writeCutoverControlAndOperation = async ({
  sql,
  backend,
  state,
  expected,
  actor,
  operation,
}) => sql.begin(async (transaction) => {
  const control = await writeCutoverControl({
    sql: transaction,
    backend,
    state,
    expected,
    actor,
  });
  await insertCutoverOperation({
    sql: transaction,
    backend,
    operation,
    state,
    actor,
  });
  return control;
});

const restoreCutoverControlAndOperation = async ({
  sql,
  backend,
  state,
  expected,
  actor,
  operation,
}) => sql.begin(async (transaction) => {
  await transaction`
    select set_config('roo.tourney_cutover_compensation', '1', true)
  `;
  const control = await writeCutoverControl({
    sql: transaction,
    backend,
    state,
    expected,
    actor,
  });
  await deleteCutoverOperation({ sql: transaction, backend, operation });
  return control;
});

const DEFINITE_CUTOVER_FAILURE_CODES = new Set([
  "TOURNEY_CUTOVER_CONTROL_UPDATE_FAILED",
  "TOURNEY_CUTOVER_OPERATION_INSERT_FAILED",
  "TOURNEY_CUTOVER_OPERATION_DELETE_FAILED",
]);
const AMBIGUOUS_SQLSTATE_CODES = new Set([
  "40003",
  "57P01",
  "57P02",
  "57P03",
  "57P04",
]);
const cutoverWriteDefinitelyFailed = (error) => {
  const code = String(error?.code || "").toUpperCase();
  if (DEFINITE_CUTOVER_FAILURE_CODES.has(code)) return true;
  return /^[0-9A-Z]{5}$/.test(code) &&
    !code.startsWith("08") &&
    !AMBIGUOUS_SQLSTATE_CODES.has(code);
};

const operationMarker = (operation) => operation?.kind === "pause"
  ? "lastPauseOperationId"
  : "lastResumeOperationId";

const applyOperationMarker = (state, operation) => operation
  ? { ...state, [operationMarker(operation)]: operation.id }
  : state;

const inspectCutoverState = async ({
  sql,
  backend,
  expected,
  operation,
  expectOperation = true,
  logLabel,
}) => {
  try {
    const [state, recorded] = await Promise.all([
      readNormalizedCutoverControl({ sql, backend }),
      operation ? readCutoverOperation({ sql, backend, operation }) : null,
    ]);
    const matches = sameCutoverRecord(state, expected) &&
      (!operation || (
        expectOperation
          ? operationMatchesTarget(recorded, operation, expected)
          : recorded === null
      ));
    return { matches, readable: true, recorded, state };
  } catch (error) {
    logSafeError(logLabel, error);
    return { matches: false, readable: false, recorded: null, state: null };
  }
};

const hasCutoverState = async (options) =>
  (await inspectCutoverState(options)).matches;

const previousControlsRestored = async ({ databases, previous, operation }) => {
  const [legacyRestored, supabaseRestored] = await Promise.all([
    hasCutoverState({
      sql: databases.legacy,
      backend: "legacy",
      expected: previous.legacy,
      operation,
      expectOperation: false,
      logLabel: "Tourney cutover legacy compensation verification failed",
    }),
    hasCutoverState({
      sql: databases.supabase,
      backend: "supabase",
      expected: previous.supabase,
      operation,
      expectOperation: false,
      logLabel: "Tourney cutover Supabase compensation verification failed",
    }),
  ]);
  return legacyRestored && supabaseRestored &&
    sameCutoverRecord(previous.legacy, previous.supabase);
};

const compensateFirstCutover = async ({
  databases,
  previous,
  firstBackend,
  appliedFirst,
  secondTargetError,
  secondTargetOutcomeAmbiguous,
  compensationActor,
  operation,
}) => {
  let compensationError = null;
  try {
    const restore = operation
      ? restoreCutoverControlAndOperation
      : writeCutoverControl;
    await restore({
      sql: databases[firstBackend],
      backend: firstBackend,
      state: previous[firstBackend],
      expected: appliedFirst,
      actor: compensationActor,
      operation,
    });
  } catch (error) {
    compensationError = error;
  }
  const restored = await previousControlsRestored({
    databases,
    previous,
    operation,
  });
  if (!restored || secondTargetOutcomeAmbiguous) {
    logSafeError(
      restored
        ? "Tourney cutover second-target outcome remained ambiguous"
        : "Tourney cutover compensation failed",
      compensationError || secondTargetError
    );
    throw cutoverFailure(
      "TOURNEY_CUTOVER_RECOVERY_REQUIRED",
      secondTargetError
    );
  }
  throw cutoverFailure(
    "TOURNEY_CUTOVER_SECOND_TARGET_FAILED_COMPENSATED",
    secondTargetError
  );
};

const recoverSecondTargetFailure = async ({
  databases,
  firstBackend,
  secondBackend,
  next,
  previous,
  appliedFirst,
  error,
  compensationActor,
  operation,
}) => {
  const appliedSecond = await hasCutoverState({
    sql: databases[secondBackend],
    backend: secondBackend,
    expected: next,
    operation,
    logLabel: "Tourney cutover second-target verification failed",
  });
  if (appliedSecond) return next;
  return compensateFirstCutover({
    databases,
    previous,
    firstBackend,
    appliedFirst,
    secondTargetError: error,
    secondTargetOutcomeAmbiguous: !cutoverWriteDefinitelyFailed(error),
    compensationActor,
    operation,
  });
};

const writeFirstCutoverControl = async ({
  backend,
  databases,
  next,
  previous,
  actor,
  operation,
}) => {
  try {
    const write = operation
      ? writeCutoverControlAndOperation
      : writeCutoverControl;
    return await write({
      sql: databases[backend],
      backend,
      state: next,
      expected: previous,
      actor,
      operation,
    });
  } catch (error) {
    const verification = await inspectCutoverState({
      sql: databases[backend],
      backend,
      expected: next,
      operation,
      logLabel: "Tourney cutover first-target verification failed",
    });
    if (verification.matches) return verification.state;
    if (!verification.readable || !cutoverWriteDefinitelyFailed(error)) {
      throw cutoverFailure("TOURNEY_CUTOVER_RECOVERY_REQUIRED", error);
    }
    throw error;
  }
};

const checkSupabaseResumeReadiness = async ({ databases, generation }) => {
  const [[legacy], [supabase], [parity]] = await Promise.all([
    databases.legacy`
      select
        (select primary_backend from tourney_cutover_metadata where id='tourney') primary_backend,
        (select generation from tourney_cutover_metadata where id='tourney') generation,
        (select writes_paused from tourney_cutover_metadata where id='tourney') writes_paused,
        (select hardened_active from tourney_cutover_metadata where id='tourney') hardened_active,
        (select fallback_read_only from tourney_cutover_metadata where id='tourney') fallback_read_only,
        (select schema_version from tourney_schema_metadata where schema_name='tourney') schema_version,
        (select count(*) from tourney_mirror_outbox where status in ('pending','processing','retry','dead_letter')) mirror,
        (select count(*) from tourney_external_operations where status in ('pending','processing','retry','dead_letter')) external,
        (select count(*) from tourney_email_dispatches where status in ('pending','sending','retry','failed','dead_letter')) email,
        (select count(*) from tourney_command_receipts where status in ('processing','committed','failed')) receipts,
        (select count(*) from tourney_discord_role_assignments where status in ('pending','processing','retry','blocked','blocked_reauth','dead_letter')) discord,
        (select count(*) from tourney_identity_conflicts where resolved_at is null) conflicts,
        (select count(*) from tourney_import_quarantine where resolved_at is null) ambiguous,
        (select count(*) from tourney_players where status='approved' and principal_id is null) player_principals,
        (select count(*) from tourney_account_snapshots) account_snapshots,
        (select count(*) from jsonb_array_elements(coalesce((
          select case
            when jsonb_typeof(accounts_json)='array' then accounts_json
            when jsonb_typeof(accounts_json)='object' then coalesce(accounts_json->'accounts','[]'::jsonb)
            else '[]'::jsonb end
          from tourney_account_snapshots order by version desc limit 1
        ),'[]'::jsonb)) account where coalesce(account->>'principalId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') account_principals
    `,
    databases.supabase`
      select
        (select primary_backend from tourney.cutover_metadata where id='tourney') primary_backend,
        (select generation from tourney.cutover_metadata where id='tourney') generation,
        (select writes_paused from tourney.cutover_metadata where id='tourney') writes_paused,
        (select hardened_active from tourney.cutover_metadata where id='tourney') hardened_active,
        (select fallback_read_only from tourney.cutover_metadata where id='tourney') fallback_read_only,
        (select schema_version from tourney.schema_metadata where schema_name='tourney') schema_version,
        (select count(*) from tourney.mirror_outbox where status in ('pending','processing','retry','dead_letter')) mirror,
        (select count(*) from tourney.external_operations where status in ('pending','processing','retry','dead_letter')) external,
        (select count(*) from tourney.email_dispatches where status in ('pending','sending','retry','failed','dead_letter')) email,
        (select count(*) from tourney.command_receipts where status in ('processing','committed','failed')) receipts,
        (select count(*) from tourney.tourney_player_auth_operations where operation_status in ('pending','processing','auth_applied','retry')) auth,
        (select count(*) from accounts.discord_role_assignments where status in ('pending','processing','retry','blocked','blocked_reauth','dead_letter')) discord,
        (select count(*) from tourney.identity_conflicts where resolved_at is null) conflicts,
        (select count(*) from migration.tourney_import_quarantine where resolved_at is null) ambiguous,
        (select count(*) from tourney.tourney_players where status='approved' and principal_id is null) player_principals,
        (select count(*) from tourney.account_snapshots) account_snapshots,
        (select count(*) from jsonb_array_elements(coalesce((
          select case
            when jsonb_typeof(accounts_json)='array' then accounts_json
            when jsonb_typeof(accounts_json)='object' then coalesce(accounts_json->'accounts','[]'::jsonb)
            else '[]'::jsonb end
          from tourney.account_snapshots order by version desc limit 1
        ),'[]'::jsonb)) account where coalesce(account->>'principalId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') account_principals
    `,
    databases.supabase`
      select status, created_at,
        created_at >= now()-interval '5 minutes' fresh,
        created_at >= coalesce((
          select max(applied_at) from tourney.mirror_outbox
          where source_backend='supabase' and generation=${generation}
        ),'-infinity'::timestamptz) after_latest_mirror
      from tourney.parity_runs
      where source_backend='supabase' and target_backend='legacy'
        and generation=${generation}
      order by created_at desc limit 1
    `,
  ]);
  const blockers = [];
  for (const [backend, state] of [["legacy", legacy], ["supabase", supabase]]) {
    if (
      state?.primary_backend !== "supabase" ||
      Number(state?.generation) !== generation ||
      state?.writes_paused !== true
    ) {
      blockers.push(`${backend}_control`);
    }
    if (state?.hardened_active !== true || Number(state?.schema_version || 0) < 4) {
      blockers.push(`${backend}_schema_v4`);
    }
    if (backend === "legacy" && state?.fallback_read_only === true) {
      blockers.push("legacy_read_only");
    }
    for (const field of [
      "mirror", "external", "email", "receipts", "discord", "conflicts",
      "ambiguous", "player_principals", "account_principals",
    ]) {
      if (Number(state?.[field] || 0) > 0) blockers.push(`${backend}_${field}`);
    }
    if (Number(state?.account_snapshots || 0) < 1) {
      blockers.push(`${backend}_account_snapshot`);
    }
  }
  if (Number(supabase?.auth || 0) > 0) blockers.push("supabase_auth");
  if (!parity || parity.status !== "clean" || !parity.fresh || !parity.after_latest_mirror) {
    blockers.push("parity");
  }
  return [...new Set(blockers)];
};

const verifyCompletedCutover = async ({
  databases,
  next,
  operation,
}) => {
  const [legacy, supabase, legacyOperation, supabaseOperation] = await Promise.all([
    readNormalizedCutoverControl({ sql: databases.legacy, backend: "legacy" }),
    readNormalizedCutoverControl({ sql: databases.supabase, backend: "supabase" }),
    readCutoverOperation({ sql: databases.legacy, backend: "legacy", operation }),
    readCutoverOperation({ sql: databases.supabase, backend: "supabase", operation }),
  ]);
  if (
    !sameCutoverRecord(legacy, next) ||
    !sameCutoverRecord(supabase, next) ||
    !sameCutoverOperation(legacyOperation, supabaseOperation) ||
    !operationMatchesTarget(legacyOperation, operation, next)
  ) {
    throw cutoverFailure("TOURNEY_CUTOVER_RECOVERY_REQUIRED");
  }
};

export const applyTourneyCutoverControl = async ({
  payload,
  databases,
  routeEnv,
  actor = "manual-cutover",
  compensationActor = "manual-cutover-compensation",
  expectedCurrent = null,
  operation = null,
  verifyCompletion = false,
}) => {
  const next = {
    primaryBackend: String(payload.primaryBackend || "").toLowerCase(),
    generation: payload.generation,
    writesPaused: payload.writesPaused,
  };
  if (
    !["legacy", "supabase"].includes(next.primaryBackend) ||
    !Number.isSafeInteger(next.generation) ||
    next.generation < 0 ||
    next.generation > 100 ||
    typeof next.writesPaused !== "boolean"
  ) {
    return { error: "Invalid cutover control state." };
  }

  const [legacy, supabase, legacyOperation, supabaseOperation] = await Promise.all([
    readNormalizedCutoverControl({ sql: databases.legacy, backend: "legacy" }),
    readNormalizedCutoverControl({ sql: databases.supabase, backend: "supabase" }),
    operation
      ? readCutoverOperation({ sql: databases.legacy, backend: "legacy", operation })
      : null,
    operation
      ? readCutoverOperation({ sql: databases.supabase, backend: "supabase", operation })
      : null,
  ]);
  const current = { legacy, supabase };
  if (!sameCutoverRecord(legacy, supabase)) {
    return {
      error: "Tourney cutover controls disagree and require recovery.",
      code: "TOURNEY_CUTOVER_CONTROL_MISMATCH",
      status: 409,
    };
  }
  if (operation && Boolean(legacyOperation) !== Boolean(supabaseOperation)) {
    return {
      error: "Tourney cutover operation ledgers disagree and require recovery.",
      code: "TOURNEY_CUTOVER_RECOVERY_REQUIRED",
      status: 503,
    };
  }
  if (operation && legacyOperation && (
    !sameCutoverOperation(legacyOperation, supabaseOperation) ||
    !operationMatchesTarget(legacyOperation, operation, next)
  )) {
    return {
      error: "Tourney cutover operation ledger record is inconsistent.",
      code: "TOURNEY_CUTOVER_RECOVERY_REQUIRED",
      status: 503,
    };
  }
  if (operation && legacyOperation) {
    return {
      ...legacy,
      changed: false,
      replayed: true,
      superseded: !sameCutoverState(legacy, next),
    };
  }
  if (!operation && sameCutoverState(legacy, next)) return next;
  if (expectedCurrent && !sameCutoverState(legacy, expectedCurrent)) {
    return {
      error: "Tourney cutover controls do not match the expected state.",
      code: "TOURNEY_CUTOVER_EXPECTATION_MISMATCH",
      status: 409,
    };
  }
  if (operation && sameCutoverState(legacy, next)) {
    return {
      error: "Tourney cutover state was applied by another operation.",
      code: "TOURNEY_CUTOVER_EXPECTATION_MISMATCH",
      status: 409,
    };
  }
  const target = applyOperationMarker({
    ...next,
    lastPauseOperationId: legacy.lastPauseOperationId,
    lastResumeOperationId: legacy.lastResumeOperationId,
  }, operation);
  const backendChanged = legacy.primaryBackend !== next.primaryBackend;
  const generationChanged = legacy.generation !== next.generation;
  if (backendChanged && next.generation !== legacy.generation + 1) {
    return {
      error: "Backend authority changes must advance exactly one generation.",
      code: "TOURNEY_CUTOVER_GENERATION_INVALID",
      status: 409,
    };
  }
  if (!backendChanged && generationChanged) {
    return {
      error: "Generation can change only with a backend authority change.",
      code: "TOURNEY_CUTOVER_GENERATION_INVALID",
      status: 409,
    };
  }
  if (backendChanged && (!legacy.writesPaused || !supabase.writesPaused)) {
    return {
      error: "Pause both Tourney controls before changing backend authority.",
      code: "TOURNEY_CUTOVER_PAUSE_REQUIRED",
      status: 409,
    };
  }
  if (!next.writesPaused && (
    !sameCutoverState(legacy, supabase) ||
    !legacy.writesPaused ||
    legacy.primaryBackend !== next.primaryBackend ||
    legacy.generation !== next.generation
  )) {
    return {
      error: "Backend authority and write resumption must be separate control changes.",
      code: "TOURNEY_CUTOVER_SEPARATE_UNPAUSE_REQUIRED",
      status: 409,
    };
  }

  if (backendChanged && next.primaryBackend === "legacy") {
    const readiness = await checkTourneyManualFailoverReadiness({
      env: {
        ...routeEnv,
        TOURNEY_DATABASE_MODE: "legacy",
        TOURNEY_WRITES_PAUSED: "1",
        TOURNEY_FAILOVER_GENERATION: String(next.generation),
      },
      expectedControlPrimaryBackend: legacy.primaryBackend,
      expectedControlGeneration: legacy.generation,
    });
    if (!readiness.ready) {
      return {
        error: "Legacy fallback is not current enough to select safely.",
        code: "TOURNEY_FAILOVER_NOT_READY",
        status: 409,
        blockers: readiness.blockers,
      };
    }
  }
  if (!next.writesPaused && next.primaryBackend === "legacy") {
    const readiness = await checkTourneyManualFailoverReadiness({
      env: {
        ...routeEnv,
        TOURNEY_DATABASE_MODE: "legacy",
        TOURNEY_WRITES_PAUSED: "1",
        TOURNEY_FAILOVER_GENERATION: String(next.generation),
      },
    });
    if (!readiness.ready) {
      return {
        error: "Legacy fallback is not ready to accept writes.",
        code: "TOURNEY_FAILOVER_NOT_READY",
        status: 409,
        blockers: readiness.blockers,
      };
    }
  }
  if (!next.writesPaused && next.primaryBackend === "supabase") {
    const blockers = await checkSupabaseResumeReadiness({
      databases,
      generation: next.generation,
    });
    if (blockers.length > 0) {
      return {
        error: "Supabase primary is not ready to resume writes.",
        code: "TOURNEY_RESUME_NOT_READY",
        status: 409,
        blockers,
      };
    }
  }

  const previous = current;
  const firstBackend = next.primaryBackend === "supabase" ? "legacy" : "supabase";
  const secondBackend = next.primaryBackend;
  const appliedFirst = await writeFirstCutoverControl({
    backend: firstBackend,
    databases,
    next: target,
    previous: previous[firstBackend],
    actor,
    operation,
  });
  try {
    const writeSecond = operation
      ? writeCutoverControlAndOperation
      : writeCutoverControl;
    await writeSecond({
      sql: databases[secondBackend],
      backend: secondBackend,
      state: target,
      expected: previous[secondBackend],
      actor,
      operation,
    });
  } catch (error) {
    await recoverSecondTargetFailure({
      databases,
      firstBackend,
      secondBackend,
      next: target,
      previous,
      appliedFirst,
      error,
      compensationActor,
      operation,
    });
  }
  if (verifyCompletion) {
    await verifyCompletedCutover({ databases, next: target, operation });
  }
  return operation
    ? { ...target, changed: true, replayed: false, superseded: false }
    : next;
};

const strictCutoverError = (message, code, status = 409, cause) => Object.assign(
  new Error(message),
  { code, status, ...(cause ? { cause } : {}) }
);

const publicCutoverControl = (state) => ({
  primaryBackend: state.primaryBackend,
  generation: state.generation,
  writesPaused: state.writesPaused,
  lastPauseOperationId: state.lastPauseOperationId || null,
  lastResumeOperationId: state.lastResumeOperationId || null,
});

const runtimeTargetFingerprints = ({
  env,
  legacyTargetFingerprint,
  requireRequestFingerprints = false,
  supabaseTargetFingerprint,
}) => {
  let actual;
  try {
    actual = computeMigrationTargetFingerprints({
      ...env,
      SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "production",
    });
  } catch (cause) {
    throw strictCutoverError(
      "The Tourney cutover database targets are invalid.",
      "TOURNEY_CUTOVER_TARGET_INVALID",
      503,
      cause
    );
  }
  const expected = {
    legacy: String(env.SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT || "")
      .trim().toLowerCase(),
    supabase: String(env.SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT || "")
      .trim().toLowerCase(),
  };
  if (
    !FINGERPRINT_PATTERN.test(actual.legacy) ||
    !FINGERPRINT_PATTERN.test(actual.supabase) ||
    !FINGERPRINT_PATTERN.test(expected.legacy) ||
    !FINGERPRINT_PATTERN.test(expected.supabase) ||
    actual.legacy !== expected.legacy ||
    actual.supabase !== expected.supabase
  ) {
    throw strictCutoverError(
      "The Tourney cutover database targets do not match their pinned fingerprints.",
      "TOURNEY_CUTOVER_TARGET_FINGERPRINT_MISMATCH"
    );
  }
  if (!requireRequestFingerprints) return actual;
  const supplied = {
    legacy: String(legacyTargetFingerprint || "").trim().toLowerCase(),
    supabase: String(supabaseTargetFingerprint || "").trim().toLowerCase(),
  };
  if (
    !FINGERPRINT_PATTERN.test(supplied.legacy) ||
    !FINGERPRINT_PATTERN.test(supplied.supabase)
  ) {
    throw strictCutoverError(
      "Exact Tourney cutover target fingerprints are required.",
      "TOURNEY_CUTOVER_TARGET_FINGERPRINT_REQUIRED",
      400
    );
  }
  if (supplied.legacy !== actual.legacy || supplied.supabase !== actual.supabase) {
    throw strictCutoverError(
      "The supplied Tourney cutover target fingerprints do not match.",
      "TOURNEY_CUTOVER_TARGET_FINGERPRINT_MISMATCH"
    );
  }
  return actual;
};

const getCutoverDatabases = async (env) => ({
  legacy: await getTourneySqlForBackend({ backend: "legacy", env }),
  supabase: await getTourneySqlForBackend({ backend: "supabase", env }),
});

const readCutoverPair = async (databases) => {
  const [legacy, supabase] = await Promise.all([
    readNormalizedCutoverControl({ sql: databases.legacy, backend: "legacy" }),
    readNormalizedCutoverControl({ sql: databases.supabase, backend: "supabase" }),
  ]);
  return { legacy, supabase };
};

export const readTourneyDualDatabaseCutoverState = async ({
  env = process.env,
} = {}) => {
  const fingerprints = runtimeTargetFingerprints({ env });
  const controls = await readCutoverPair(await getCutoverDatabases(env));
  return {
    controls: {
      legacy: publicCutoverControl(controls.legacy),
      supabase: publicCutoverControl(controls.supabase),
    },
    fingerprints,
  };
};

const validateStrictWritesPausedRequest = ({
  expectedGeneration,
  expectedPrimaryBackend,
  expectedWritesPaused,
  operationId,
  writesPaused,
}) => {
  const normalizedOperationId = String(operationId || "").trim().toLowerCase();
  const expected = {
    primaryBackend: String(expectedPrimaryBackend || "").trim().toLowerCase(),
    generation: expectedGeneration,
    writesPaused: expectedWritesPaused,
  };
  if (
    !/^[a-z0-9][a-z0-9:_-]{7,127}$/.test(normalizedOperationId) ||
    expected.primaryBackend !== "supabase" ||
    expected.generation !== 1 ||
    typeof expected.writesPaused !== "boolean" ||
    typeof writesPaused !== "boolean" ||
    writesPaused === expected.writesPaused
  ) {
    throw strictCutoverError(
      "An exact Tourney cutover operation and expected state are required.",
      "TOURNEY_CUTOVER_CONTROL_REQUEST_INVALID",
      400
    );
  }
  return { expected, normalizedOperationId };
};

export const setTourneyDualDatabaseWritesPausedV4 = async ({
  env = process.env,
  expectedGeneration,
  expectedPrimaryBackend,
  expectedWritesPaused,
  legacyTargetFingerprint,
  operationId,
  supabaseTargetFingerprint,
  writesPaused,
} = {}) => {
  const { expected, normalizedOperationId } = validateStrictWritesPausedRequest({
    expectedGeneration,
    expectedPrimaryBackend,
    expectedWritesPaused,
    operationId,
    writesPaused,
  });
  const policy = resolveTourneyStorePolicy(env);
  if (
    policy.primaryBackend !== expected.primaryBackend ||
    policy.generation !== expected.generation ||
    !policy.mirrorEnabled ||
    (!writesPaused && !policy.writesPaused)
  ) {
    throw strictCutoverError(
      "The deployment is not ready for this Tourney cutover control change.",
      "TOURNEY_CUTOVER_DEPLOYMENT_MISMATCH"
    );
  }
  const fingerprints = runtimeTargetFingerprints({
    env,
    legacyTargetFingerprint,
    requireRequestFingerprints: true,
    supabaseTargetFingerprint,
  });
  const actor = `schema-v4-${writesPaused ? "pause" : "resume"}:${normalizedOperationId}`;
  const operation = {
    id: normalizedOperationId,
    kind: writesPaused ? "pause" : "resume",
  };
  const databases = await getCutoverDatabases(env);
  const result = await applyTourneyCutoverControl({
    payload: { ...expected, writesPaused },
    databases,
    routeEnv: env,
    actor,
    compensationActor: `${actor}:compensated`,
    expectedCurrent: expected,
    operation,
    verifyCompletion: true,
  });
  if (result.error) {
    throw strictCutoverError(result.error, result.code || "TOURNEY_CUTOVER_CONTROL_FAILED", result.status);
  }
  return {
    changed: result.changed,
    replayed: result.replayed,
    superseded: result.superseded,
    controls: {
      legacy: publicCutoverControl(result),
      supabase: publicCutoverControl(result),
    },
    fingerprints,
  };
};

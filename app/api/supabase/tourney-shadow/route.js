import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import migrationTargetSafety from "../../../../src/server/supabase/migrationTargetSafety.cjs";
import {
  migrateTourneyShadow,
  readTourneySnapshot,
} from "../../../../src/server/supabase/tourneyMigration";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { readPersistedTourneyAccountsJson } from "../../../../src/server/tourney/accountStore";
import { splitPostgresStatements } from "../../../../src/server/tourney/sqlStatements";
import {
  getTourneySql,
  getTourneySqlForBackend,
} from "../../../../src/server/tourney/sqlClient";
import {
  executeTourneyCommand,
  checkTourneyManualFailoverReadiness,
  reconcileTourneyMirror,
  runTourneyParity,
  runTourneyShadowReadSamples,
} from "../../../../src/server/tourney/store";

const {
  authorizeMigrationTargetRequest,
  buildMigrationRouteEnv,
} = migrationTargetSafety;
const LEGACY_SCHEMA_SHA256 =
  "037b8afe6b6b69b7763210c62b842e4977aeee4c6abcef6c4a0d3c73903ba64f";
const ACTIONS = new Set([
  "apply-legacy-schema",
  "backend-health",
  "cutover-control",
  "drain-mirror",
  "email-state-backfill",
  "migrate",
  "mirror-probe",
  "parity",
  "shadow-samples",
  "snapshot",
]);
const READ_ONLY_ACTIONS = new Set(["backend-health"]);
const PRODUCTION_HOSTS = new Set(["rooindustries.com", "www.rooindustries.com"]);
const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const respond = (body, status = 200) =>
  NextResponse.json(body, { status, headers: noStore });

const normalizeHostname = (value) => String(value || "")
  .trim()
  .replace(/:\d+$/, "")
  .replace(/\.$/, "")
  .toLowerCase();

const requestHostnames = (request) => [
  ...String(request.headers.get("x-forwarded-host") || "").split(","),
  request.headers.get("host"),
].map(normalizeHostname).filter(Boolean);

const migrationEndpointEnabled = (request) => {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(process.env.SUPABASE_MIGRATION_ENDPOINT_ENABLED || "")
      .trim()
      .toLowerCase()
  );
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  const productionHosted = requestHostnames(request).some((hostname) =>
    PRODUCTION_HOSTS.has(hostname)
  );
  return enabled && vercelEnv !== "production" && !productionHosted;
};

const authorized = (request) => {
  const adminKey = String(process.env.REF_ADMIN_KEY || "").trim();
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const suppliedAdmin = String(request.headers.get("x-admin-key") || "").trim();
  const bearer = String(request.headers.get("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return (
    (adminKey && safeEqual(adminKey, suppliedAdmin)) ||
    (cronSecret && safeEqual(cronSecret, bearer))
  );
};

const safeDatabaseError = (error) => ({
  name: String(error?.name || "Error").slice(0, 64),
  code: String(error?.code || "unknown").slice(0, 64),
  message: String(error?.message || "Database probe failed.")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url]")
    .slice(0, 240),
});

const validateDatabaseTargets = async (env) => {
  const [legacySql, supabaseSql] = await Promise.all([
    getTourneySqlForBackend({ backend: "legacy", env }),
    getTourneySqlForBackend({ backend: "supabase", env }),
  ]);
  const [legacyProbe, supabaseProbe] = await Promise.all([
    legacySql`select true as ok`,
    supabaseSql`select true as ok`,
  ]);
  if (legacyProbe?.[0]?.ok !== true || supabaseProbe?.[0]?.ok !== true) {
    throw Object.assign(new Error("Migration database target validation failed."), {
      code: "MIGRATION_DATABASE_TARGET_VALIDATION_FAILED",
    });
  }
  return { legacy: legacySql, supabase: supabaseSql };
};

const cutoverRelation = (backend) => backend === "supabase"
  ? "tourney.cutover_metadata"
  : "tourney_cutover_metadata";

const readCutoverControl = async ({ sql, backend }) => {
  const rows = await sql`
    select primary_backend, generation, writes_paused, xmin::text as row_version
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
        updated_by = ${actor}
    where id = 'tourney' and xmin = ${expected.rowVersion}::xid
    returning primary_backend, generation, writes_paused, xmin::text as row_version
  `;
  if (rows.length !== 1) {
    throw Object.assign(new Error("Tourney cutover control update failed."), {
      code: "TOURNEY_CUTOVER_CONTROL_UPDATE_FAILED",
    });
  }
  return normalizeCutoverState(rows[0]);
};

const normalizeCutoverState = (control) => ({
  primaryBackend: String(control.primary_backend || "").toLowerCase(),
  generation: Number(control.generation),
  writesPaused: control.writes_paused === true,
  rowVersion: String(control.row_version || ""),
});

const sameCutoverState = (left, right) =>
  left.primaryBackend === right.primaryBackend &&
  left.generation === right.generation &&
  left.writesPaused === right.writesPaused;

const readNormalizedCutoverControl = async ({ sql, backend }) =>
  normalizeCutoverState(await readCutoverControl({ sql, backend }));

const cutoverFailure = (code, cause) => Object.assign(
  new Error("Tourney cutover control requires recovery."),
  { code, cause }
);

const DEFINITE_CUTOVER_FAILURE_CODES = new Set([
  "TOURNEY_CUTOVER_CONTROL_UPDATE_FAILED",
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

const inspectCutoverState = async ({ sql, backend, expected, logLabel }) => {
  try {
    const state = await readNormalizedCutoverControl({ sql, backend });
    return { matches: sameCutoverState(state, expected), readable: true, state };
  } catch (error) {
    logSafeError(logLabel, error);
    return { matches: false, readable: false, state: null };
  }
};

const hasCutoverState = async (options) =>
  (await inspectCutoverState(options)).matches;

const previousControlsRestored = async ({ databases, previous }) => {
  const [legacyRestored, supabaseRestored] = await Promise.all([
    hasCutoverState({
      sql: databases.legacy,
      backend: "legacy",
      expected: previous.legacy,
      logLabel: "Tourney cutover legacy compensation verification failed",
    }),
    hasCutoverState({
      sql: databases.supabase,
      backend: "supabase",
      expected: previous.supabase,
      logLabel: "Tourney cutover Supabase compensation verification failed",
    }),
  ]);
  return legacyRestored && supabaseRestored &&
    sameCutoverState(previous.legacy, previous.supabase);
};

const compensateFirstCutover = async ({
  databases,
  previous,
  firstBackend,
  appliedFirst,
  secondTargetError,
  secondTargetOutcomeAmbiguous,
}) => {
  let compensationError = null;
  try {
    await writeCutoverControl({
      sql: databases[firstBackend],
      backend: firstBackend,
      state: previous[firstBackend],
      expected: appliedFirst,
      actor: "manual-cutover-compensation",
    });
  } catch (error) {
    compensationError = error;
  }
  const restored = await previousControlsRestored({ databases, previous });
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
}) => {
  const appliedSupabase = await hasCutoverState({
    sql: databases[secondBackend],
    backend: secondBackend,
    expected: next,
    logLabel: "Tourney cutover second-target verification failed",
  });
  if (appliedSupabase) return next;
  return compensateFirstCutover({
    databases,
    previous,
    firstBackend,
    appliedFirst,
    secondTargetError: error,
    secondTargetOutcomeAmbiguous: !cutoverWriteDefinitelyFailed(error),
  });
};

const writeFirstCutoverControl = async ({
  backend,
  databases,
  next,
  previous,
}) => {
  try {
    return await writeCutoverControl({
      sql: databases[backend],
      backend,
      state: next,
      expected: previous,
      actor: "manual-cutover",
    });
  } catch (error) {
    const verification = await inspectCutoverState({
      sql: databases[backend],
      backend,
      expected: next,
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

const applyCutoverControl = async ({ payload, databases, routeEnv }) => {
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

  const [legacy, supabase] = await Promise.all([
    readNormalizedCutoverControl({ sql: databases.legacy, backend: "legacy" }),
    readNormalizedCutoverControl({ sql: databases.supabase, backend: "supabase" }),
  ]);
  if (sameCutoverState(legacy, next) && sameCutoverState(supabase, next)) {
    return next;
  }
  if (!sameCutoverState(legacy, supabase)) {
    return {
      error: "Tourney cutover controls disagree and require recovery.",
      code: "TOURNEY_CUTOVER_CONTROL_MISMATCH",
      status: 409,
    };
  }
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
  const authorityChanged = backendChanged;
  if (authorityChanged && (!legacy.writesPaused || !supabase.writesPaused)) {
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

  const previous = { legacy, supabase };
  const firstBackend = next.primaryBackend === "supabase" ? "legacy" : "supabase";
  const secondBackend = next.primaryBackend;
  const appliedFirst = await writeFirstCutoverControl({
    backend: firstBackend,
    databases,
    next,
    previous: previous[firstBackend],
  });
  try {
    await writeCutoverControl({
      sql: databases[secondBackend],
      backend: secondBackend,
      state: next,
      expected: previous[secondBackend],
      actor: "manual-cutover",
    });
    return next;
  } catch (error) {
    return recoverSecondTargetFailure({
      databases,
      firstBackend,
      secondBackend,
      next,
      previous,
      appliedFirst,
      error,
    });
  }
};

const targetValidationResponse = (error) => {
  logSafeError("Tourney migration target rejected", error);
  return respond({
    ok: false,
    error: "Migration target validation failed.",
    code: String(error?.code || "MIGRATION_TARGET_VALIDATION_FAILED").slice(0, 64),
  }, Number(error?.status || 409));
};

const handleBackendHealth = async (routeEnv) => {
  const result = {};
  for (const backend of ["legacy", "supabase"]) {
    try {
      const sql = await getTourneySqlForBackend({ backend, env: routeEnv });
      const relation = backend === "supabase"
        ? "tourney.tourney_players"
        : "tourney_players";
      const rows = await sql`select count(*)::integer as count from ${sql(relation)}`;
      result[backend] = { ok: true, count: Number(rows[0]?.count || 0) };
    } catch (error) {
      result[backend] = { ok: false, ...safeDatabaseError(error) };
    }
  }
  return respond({
    ok: Object.values(result).every((item) => item.ok),
    backends: result,
  });
};

const handleLegacySchema = async ({ payload, routeEnv }) => {
  const schemaSql = String(payload.schemaSql || "");
  const suppliedHash = crypto.createHash("sha256").update(schemaSql).digest("hex");
  if (suppliedHash !== LEGACY_SCHEMA_SHA256) {
    return respond({ ok: false, error: "Legacy schema payload rejected." }, 400);
  }
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(routeEnv.TOURNEY_DATABASE_URL);
    const statements = splitPostgresStatements(schemaSql);
    await sql.transaction(statements.map((statement) => sql.query(statement)));
  } catch (error) {
    return respond({
      ok: false,
      error: "Legacy schema application failed.",
      code: String(error?.code || "LEGACY_SCHEMA_FAILED").slice(0, 64),
      position: Number(error?.position || 0),
      routine: String(error?.routine || "").slice(0, 128),
    }, 500);
  }
  return respond({ ok: true, schemaHash: suppliedHash });
};

const handleSnapshot = async (routeEnv) => {
  const [{ snapshot, sourceHash }, accountsJson] = await Promise.all([
    readTourneySnapshot({ env: routeEnv }),
    readPersistedTourneyAccountsJson(routeEnv),
  ]);
  const captured = await createSupabaseAdminClient({ env: routeEnv }).rpc(
    "roo_capture_tourney_pre_cutover_snapshot",
    {
      p_legacy_snapshot: snapshot,
      p_sanity_account: { accountsJson },
    }
  );
  if (captured.error) throw captured.error;
  return respond({ ok: true, sourceHash, snapshot: captured.data });
};

const mirrorResponse = ({ mirror, parity }) => respond({
  ok: mirror.failed === 0 && parity.status === "clean",
  mirror,
  parity,
});

const handleMirrorProbe = async (routeEnv) => {
  const env = {
    ...routeEnv,
    TOURNEY_DATABASE_MODE: "legacy",
    TOURNEY_MIRROR_ENABLED: "1",
    TOURNEY_WRITES_PAUSED: "0",
    TOURNEY_FAILOVER_GENERATION: "0",
  };
  await executeTourneyCommand({
    commandId: `cutover:mirror-probe:${crypto.randomUUID()}`,
    purpose: "registration:mirror-probe",
    requestPayload: { noBusinessChange: true },
    env,
    callback: async () => {
      const sql = await getTourneySql(env);
      await sql`
        update tourney_registration_config
        set team_count = team_count
        where id = 'legacy-series-2026'
      `;
      return { body: { ok: true } };
    },
  });
  const mirror = await reconcileTourneyMirror({ env, limit: 10 });
  const parity = await runTourneyParity({ env });
  return mirrorResponse({ mirror, parity });
};

const handleEmailBackfill = async (routeEnv) => {
  const env = {
    ...routeEnv,
    TOURNEY_DATABASE_MODE: "legacy",
    TOURNEY_MIRROR_ENABLED: "1",
    TOURNEY_WRITES_PAUSED: "0",
    TOURNEY_FAILOVER_GENERATION: "0",
  };
  await executeTourneyCommand({
    commandId: `cutover:email-state:${crypto.randomUUID()}`,
    purpose: "email:state-backfill",
    requestPayload: { noDelivery: true },
    env,
    callback: async () => {
      const sql = await getTourneySql(env);
      await sql`update tourney_email_dispatches set updated_at = updated_at`;
      return { body: { ok: true } };
    },
  });
  const mirror = await reconcileTourneyMirror({ env, limit: 50 });
  const parity = await runTourneyParity({ env });
  return mirrorResponse({ mirror, parity });
};

const handleDrainMirror = async ({ payload, routeEnv }) => {
  const env = {
    ...routeEnv,
    TOURNEY_DATABASE_MODE: String(payload.primaryBackend || "legacy"),
    TOURNEY_MIRROR_ENABLED: "1",
    TOURNEY_WRITES_PAUSED: "0",
    TOURNEY_FAILOVER_GENERATION: String(payload.generation ?? 0),
  };
  const mirror = await reconcileTourneyMirror({ env, limit: 250 });
  const parity = await runTourneyParity({ env });
  return mirrorResponse({ mirror, parity });
};

const dispatchMutation = async ({ action, payload, routeEnv, databases }) => {
  if (action === "apply-legacy-schema") {
    return handleLegacySchema({ payload, routeEnv });
  }
  if (action === "snapshot") return handleSnapshot(routeEnv);
  if (action === "parity") {
    return respond({ ok: true, ...(await runTourneyParity({ env: routeEnv })) });
  }
  if (action === "shadow-samples") {
    return respond({
      ok: true,
      ...(await runTourneyShadowReadSamples({ env: routeEnv, rounds: 30 })),
    });
  }
  if (action === "mirror-probe") return handleMirrorProbe(routeEnv);
  if (action === "email-state-backfill") return handleEmailBackfill(routeEnv);
  if (action === "drain-mirror") {
    return handleDrainMirror({ payload, routeEnv });
  }
  if (action === "cutover-control") {
    const result = await applyCutoverControl({ payload, databases, routeEnv });
    return result.error
      ? respond({
          ok: false,
          error: result.error,
          ...(result.code ? { code: result.code } : {}),
          ...(result.blockers ? { blockers: result.blockers } : {}),
        }, result.status || 400)
      : respond({ ok: true, ...result });
  }
  const client = createSupabaseAdminClient({ env: routeEnv });
  const result = await migrateTourneyShadow({ env: routeEnv, client });
  return respond({ ok: true, ...result });
};

export async function POST(request) {
  if (!migrationEndpointEnabled(request) || !authorized(request)) {
    return respond({ ok: false, error: "Not found." }, 404);
  }

  let payload;
  try {
    payload = await readBoundedJson(request, { maxBytes: 64 * 1024 });
  } catch (error) {
    return respond({
      ok: false,
      error: error?.message || "Invalid migration request.",
    }, Number(error?.status || 400));
  }
  const action = String(payload.action || "migrate").trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    return respond({ ok: false, error: "Invalid migration action." }, 400);
  }

  let inspection;
  try {
    inspection = authorizeMigrationTargetRequest({
      env: process.env,
      payload,
      action,
      mutating: !READ_ONLY_ACTIONS.has(action),
    });
  } catch (error) {
    return targetValidationResponse(error);
  }
  const routeEnv = buildMigrationRouteEnv({ env: process.env, inspection });

  try {
    if (action === "backend-health") return handleBackendHealth(routeEnv);
    const databases = await validateDatabaseTargets(routeEnv);
    return await dispatchMutation({ action, payload, routeEnv, databases });
  } catch (error) {
    logSafeError("Tourney shadow migration failed", error);
    const code = String(error?.code || "").slice(0, 64);
    return respond({
      ok: false,
      error: "Tourney shadow migration failed.",
      ...(code.startsWith("TOURNEY_CUTOVER_") ? { code } : {}),
    }, 500);
  }
}

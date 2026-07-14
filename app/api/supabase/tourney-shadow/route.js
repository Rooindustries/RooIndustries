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
import { applyTourneyCutoverControl } from "../../../../src/server/tourney/cutoverControl";
import { splitPostgresStatements } from "../../../../src/server/tourney/sqlStatements";
import {
  getTourneySql,
  getTourneySqlForBackend,
} from "../../../../src/server/tourney/sqlClient";
import {
  executeTourneyCommand,
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
    const result = await applyTourneyCutoverControl({ payload, databases, routeEnv });
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

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
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
  reconcileTourneyMirror,
  runTourneyParity,
  runTourneyShadowReadSamples,
} from "../../../../src/server/tourney/store";

const LEGACY_SCHEMA_SHA256 =
  "037b8afe6b6b69b7763210c62b842e4977aeee4c6abcef6c4a0d3c73903ba64f";

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

const migrationEndpointEnabled = () =>
  ["1", "true", "yes", "on"].includes(
    String(process.env.SUPABASE_MIGRATION_ENDPOINT_ENABLED || "")
      .trim()
      .toLowerCase()
  ) && String(process.env.VERCEL_ENV || "").trim().toLowerCase() !== "production";

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

export async function POST(request) {
  if (!migrationEndpointEnabled()) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  try {
    const payload = await request.json().catch(() => ({}));
    if (String(payload.action || "").toLowerCase() === "apply-legacy-schema") {
      const schemaSql = String(payload.schemaSql || "");
      const suppliedHash = crypto.createHash("sha256").update(schemaSql).digest("hex");
      if (suppliedHash !== LEGACY_SCHEMA_SHA256) {
        return NextResponse.json(
          { ok: false, error: "Legacy schema payload rejected." },
          { status: 400, headers: { "Cache-Control": "private, no-store" } }
        );
      }
      const { neon } = await import("@neondatabase/serverless");
      const databaseUrl = String(
        process.env.TOURNEY_DATABASE_URL || process.env.POSTGRES_URL || ""
      ).trim();
      if (!databaseUrl) throw new Error("Legacy Tourney database is not configured.");
      try {
        const sql = neon(databaseUrl);
        const statements = splitPostgresStatements(schemaSql);
        await sql.transaction(statements.map((statement) => sql.query(statement)));
      } catch (error) {
        return NextResponse.json(
          {
            ok: false,
            error: "Legacy schema application failed.",
            code: String(error?.code || "LEGACY_SCHEMA_FAILED").slice(0, 64),
            position: Number(error?.position || 0),
            routine: String(error?.routine || "").slice(0, 128),
          },
          { status: 500, headers: { "Cache-Control": "private, no-store" } }
        );
      }
      return NextResponse.json(
        { ok: true, schemaHash: suppliedHash },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (String(payload.action || "migrate").toLowerCase() === "snapshot") {
      const [{ snapshot, sourceHash }, accountsJson] = await Promise.all([
        readTourneySnapshot(),
        readPersistedTourneyAccountsJson(),
      ]);
      const captured = await createSupabaseAdminClient().rpc(
        "roo_capture_tourney_pre_cutover_snapshot",
        {
          p_legacy_snapshot: snapshot,
          p_sanity_account: { accountsJson },
        }
      );
      if (captured.error) throw captured.error;
      return NextResponse.json(
        { ok: true, sourceHash, snapshot: captured.data },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (String(payload.action || "").toLowerCase() === "parity") {
      return NextResponse.json(
        { ok: true, ...(await runTourneyParity()) },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (String(payload.action || "").toLowerCase() === "shadow-samples") {
      return NextResponse.json(
        { ok: true, ...(await runTourneyShadowReadSamples({ rounds: 30 })) },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (String(payload.action || "").toLowerCase() === "backend-health") {
      const result = {};
      for (const backend of ["legacy", "supabase"]) {
        try {
          const sql = await getTourneySqlForBackend({ backend });
          const relation = backend === "supabase"
            ? "tourney.tourney_players"
            : "tourney_players";
          const rows = await sql`select count(*)::integer as count from ${sql(relation)}`;
          result[backend] = { ok: true, count: Number(rows[0]?.count || 0) };
        } catch (error) {
          result[backend] = { ok: false, ...safeDatabaseError(error) };
        }
      }
      return NextResponse.json(
        { ok: Object.values(result).every((item) => item.ok), backends: result },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (String(payload.action || "").toLowerCase() === "mirror-probe") {
      const probeEnv = {
        ...process.env,
        TOURNEY_DATABASE_MODE: "legacy",
        TOURNEY_MIRROR_ENABLED: "1",
        TOURNEY_WRITES_PAUSED: "0",
        TOURNEY_FAILOVER_GENERATION: "0",
      };
      const commandId = `cutover:mirror-probe:${crypto.randomUUID()}`;
      await executeTourneyCommand({
        commandId,
        purpose: "registration:mirror-probe",
        requestPayload: { noBusinessChange: true },
        env: probeEnv,
        callback: async () => {
          const sql = await getTourneySql(probeEnv);
          await sql`
            update tourney_registration_config
            set team_count = team_count
            where id = 'legacy-series-2026'
          `;
          return { body: { ok: true } };
        },
      });
      const mirror = await reconcileTourneyMirror({ env: probeEnv, limit: 10 });
      const parity = await runTourneyParity({ env: probeEnv });
      return NextResponse.json(
        { ok: mirror.failed === 0 && parity.status === "clean", mirror, parity },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (String(payload.action || "").toLowerCase() === "email-state-backfill") {
      const backfillEnv = {
        ...process.env,
        TOURNEY_DATABASE_MODE: "legacy",
        TOURNEY_MIRROR_ENABLED: "1",
        TOURNEY_WRITES_PAUSED: "0",
        TOURNEY_FAILOVER_GENERATION: "0",
      };
      await executeTourneyCommand({
        commandId: `cutover:email-state:${crypto.randomUUID()}`,
        purpose: "email:state-backfill",
        requestPayload: { noDelivery: true },
        env: backfillEnv,
        callback: async () => {
          const sql = await getTourneySql(backfillEnv);
          await sql`
            update tourney_email_dispatches
            set updated_at = updated_at
          `;
          return { body: { ok: true } };
        },
      });
      const mirror = await reconcileTourneyMirror({ env: backfillEnv, limit: 50 });
      const parity = await runTourneyParity({ env: backfillEnv });
      return NextResponse.json(
        { ok: mirror.failed === 0 && parity.status === "clean", mirror, parity },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const result = await migrateTourneyShadow();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    logSafeError("Tourney shadow migration failed", error);
    return NextResponse.json(
      { ok: false, error: "Tourney shadow migration failed." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}

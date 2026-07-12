import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { getTourneySqlForBackend } from "../../../../src/server/tourney/sqlClient";
import { resolveTourneyStorePolicy } from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const authorized = (request) =>
  safeEqual(process.env.REF_ADMIN_KEY, request.headers.get("x-admin-key"));

const readLegacyReadiness = async (sql) => {
  const [control] = await sql`
    select primary_backend, generation, writes_paused, fallback_read_only,
      clean_since, updated_at
    from tourney_cutover_metadata where id = 'tourney'
  `;
  const playerCounts = await sql`
    select status, count(*)::integer as count
    from tourney_players group by status order by status
  `;
  const [counts] = await sql`
    select
      (select count(*)::integer from tourney_players) as players,
      (select count(*)::integer from tourney_player_tokens) as tokens,
      (select count(*)::integer from tourney_bracket_teams) as teams,
      (select count(*)::integer from tourney_bracket_team_members) as team_members,
      (select count(*)::integer from tourney_appeals) as appeals,
      (select count(*)::integer from tourney_payouts) as payouts
  `;
  const [mirror] = await sql`
    select count(*)::integer as pending, min(occurred_at) as oldest_pending_at,
      count(*) filter (where last_error_at is not null)::integer as failed
    from tourney_mirror_outbox where applied_at is null
  `;
  const [retries] = await sql`
    select count(*)::integer as email_retries
    from tourney_email_dispatches
    where status in ('pending', 'retry', 'sending', 'failed')
  `;
  const [lastParity] = await sql`
    select source_backend, target_backend, generation, status, counts, drift,
      relationships, created_at
    from tourney_parity_runs order by created_at desc limit 1
  `;
  const shadowReads = await sql`
    with ranked as (
      select *, row_number() over (
        partition by route order by observed_at desc, id desc
      ) as sample_rank
      from tourney_shadow_observations
    )
    select route, count(*)::integer as samples,
      count(*) filter (
        where not (shape_match and value_match and ordering_match and error_match)
      )::integer as mismatches,
      max(observed_at) as last_observed_at
    from ranked
    where sample_rank <= 30
    group by route order by route
  `;
  return {
    control,
    player_counts: Object.fromEntries(
      playerCounts.map((row) => [row.status, Number(row.count)])
    ),
    table_counts: counts,
    mirror,
    identity_conflicts: 0,
    email_retries: Number(retries?.email_retries || 0),
    discord_retries: null,
    last_parity: lastParity || null,
    shadow_reads: Object.fromEntries(
      shadowReads.map((row) => [row.route, {
        samples: Number(row.samples),
        mismatches: Number(row.mismatches),
        last_observed_at: row.last_observed_at,
      }])
    ),
  };
};

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Not found." },
      { status: 404, headers: noStore }
    );
  }
  try {
    const policy = resolveTourneyStorePolicy();
    const sql = await getTourneySqlForBackend({
      backend: policy.primaryBackend,
    });
    const readiness = policy.primaryBackend === "supabase"
      ? (await sql`select public.roo_tourney_readiness() as readiness`)[0]?.readiness
      : await readLegacyReadiness(sql);
    const databaseControl = readiness?.control || {};
    return NextResponse.json(
      {
        ok: true,
        primaryBackend: policy.primaryBackend,
        generation: policy.generation,
        mirrorEnabled: policy.mirrorEnabled,
        writesPaused: policy.writesPaused,
        controlMatchesDeployment:
          databaseControl.primary_backend === policy.primaryBackend &&
          Number(databaseControl.generation || 0) === policy.generation &&
          Boolean(databaseControl.writes_paused) === policy.writesPaused,
        readiness,
      },
      { headers: noStore }
    );
  } catch (error) {
    logSafeError("Tourney readiness check failed", error);
    return NextResponse.json(
      { ok: false, error: "Tourney readiness is unavailable." },
      { status: 503, headers: noStore }
    );
  }
}

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
const enabled = (value) => ["1", "true", "yes", "on"].includes(
  String(value || "").trim().toLowerCase()
);

const readLegacyReadiness = async (sql) => {
  const [mirrorTriggerBindings] = await sql`
    select public.tourney_mirror_trigger_binding_status_v4() readiness
  `;
  const [control] = await sql`
    select primary_backend, generation, writes_paused, fallback_read_only,
      clean_since, hardened_active, natural_mutation_verified_at,
      first_zero_drift_at, second_zero_drift_at, clock_last_evaluated_at,
      clock_last_reset_reason, updated_at
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
      (select count(*)::integer from tourney_payouts) as payouts,
      (select count(*)::integer from tourney_account_snapshots) as account_snapshots,
      (select count(*)::integer from tourney_command_receipts) as command_receipts
  `;
  const [mirror] = await sql`
    select jsonb_object_agg(status,count) as counts,
      min(occurred_at) filter(where status in ('pending','retry','processing')) as oldest_pending_at
    from (select status,count(*)::integer count,min(occurred_at) occurred_at
      from tourney_mirror_outbox group by status) states
  `;
  const [external] = await sql`
    select jsonb_object_agg(status,count) as counts,
      min(created_at) filter(where status in ('pending','retry','processing')) as oldest_pending_at
    from (select status,count(*)::integer count,min(created_at) created_at
      from tourney_external_operations group by status) states
  `;
  const emailRows = await sql`select status,count(*)::integer count from tourney_email_dispatches group by status`;
  const discordRows = await sql`select status,count(*)::integer count from tourney_discord_role_assignments group by status`;
  const [lastParity] = await sql`
    select source_backend, target_backend, generation, status, counts, drift,
      relationships, status_counts, canonical_hashes, shadow_results, created_at
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
        where not (
          shape_match and value_match and ordering_match and error_match
          and coalesce(primary_status between 200 and 299, false)
          and coalesce(shadow_status between 200 and 299, false)
        )
      )::integer as mismatches,
      percentile_cont(0.95) within group (
        order by primary_latency_ms
      )::integer as primary_p95_ms,
      percentile_cont(0.95) within group (
        order by shadow_latency_ms
      )::integer as shadow_p95_ms,
      max(observed_at) as last_observed_at
    from ranked
    where sample_rank <= 30
    group by route order by route
  `;
  const discord = Object.fromEntries(
    discordRows.map((row) => [row.status, Number(row.count)])
  );
  const shadow = Object.fromEntries(
    shadowReads.map((row) => [row.route, {
      samples: Number(row.samples),
      mismatches: Number(row.mismatches),
      primary_p95_ms: Number(row.primary_p95_ms || 0),
      shadow_p95_ms: Number(row.shadow_p95_ms || 0),
      last_observed_at: row.last_observed_at,
    }])
  );
  const clockBlockers = new Set(
    control?.clock_last_reset_reason ? [control.clock_last_reset_reason] : []
  );
  if (["blocked", "blocked_reauth", "dead_letter"].some(
    (status) => Number(discord[status] || 0) > 0
  )) {
    clockBlockers.add("discord_blocker");
  }
  if (Object.values(shadow).some((route) => route.mismatches > 0)) {
    clockBlockers.add("shadow_mismatch");
  }
  if (mirrorTriggerBindings?.readiness?.ready !== true) {
    clockBlockers.add("mirror_trigger_binding_drift");
  }
  return {
    control,
    player_counts: Object.fromEntries(
      playerCounts.map((row) => [row.status, Number(row.count)])
    ),
    table_counts: counts,
    mirror,
    external_operations: external,
    auth_operations: {
      counts: {},
      pending: 0,
      oldest_pending_at: null,
      overdue: 0,
      unavailable_on_legacy: true,
    },
    identity_conflicts: Number((await sql`
      select count(*)::integer count from tourney_identity_conflicts
      where resolved_at is null
    `)[0]?.count || 0),
    email: Object.fromEntries(emailRows.map((row) => [row.status, Number(row.count)])),
    discord,
    last_parity: lastParity || null,
    mirror_trigger_bindings: mirrorTriggerBindings?.readiness || { ready: false },
    clock_blockers: [...clockBlockers],
    shadow_reads: shadow,
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
    const hardenedEnabled = enabled(process.env.TOURNEY_HARDENING_V4_ENABLED);
    const activationEnabled = enabled(process.env.TOURNEY_V4_ACTIVATION_ENABLED);
    const controlMatchesDeployment =
      databaseControl.primary_backend === policy.primaryBackend &&
      Number(databaseControl.generation || 0) === policy.generation &&
      Boolean(databaseControl.writes_paused) === policy.writesPaused &&
      Boolean(databaseControl.hardened_active) === hardenedEnabled;
    const clockBlockers = Array.isArray(readiness?.clock_blockers)
      ? readiness.clock_blockers
      : ["readiness_blockers_unavailable"];
    return NextResponse.json(
      {
        ok: true,
        primaryBackend: policy.primaryBackend,
        generation: policy.generation,
        mirrorEnabled: policy.mirrorEnabled,
        writesPaused: policy.writesPaused,
        hardenedEnabled,
        activationEnabled,
        controlMatchesDeployment,
        finalReadiness:
          controlMatchesDeployment &&
          !activationEnabled &&
          readiness?.mirror_trigger_bindings?.ready === true &&
          clockBlockers.length === 0,
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

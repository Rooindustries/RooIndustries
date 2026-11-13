import assert from "node:assert/strict";
import { createSweepPostgresFixture } from "./lib/sweep-postgres-fixture.mjs";
import { installNetworkGuard, localOrigin, refuseEnvFiles } from "./lib/test-target-safety.mjs";
import { portFromEnv } from "./lib/free-tcp-port.mjs";

refuseEnvFiles();
const requested = portFromEnv("COMMERCE_READINESS_SCALE_TEST_PORT");
const results = [];
let fixture;
let restoreNetwork;

const scenario = async (name, run) => {
  try {
    const detail = await run();
    results.push({ name, passed: true, ...(detail || {}) });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
};

try {
  const ports = requested ? { postgres: requested, rest: requested + 1, proxy: requested + 2 } : {};
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true, ports });
  restoreNetwork = installNetworkGuard([fixture.postgrestUrl, fixture.origin].map(localOrigin));
  const { sql } = fixture;
  const seed = async (count, offset, direction, mode, status, verify) => {
    await sql`
      insert into migration.sync_runs (direction, mode, status, started_at, completed_at, counters)
      select ${direction}, ${mode}, ${status}, completed_at - interval '1 minute', completed_at,
        jsonb_build_object('parity', jsonb_build_object('payload', payload)) ||
          case when ${verify} then '{"mode":"verify"}'::jsonb else '{}'::jsonb end
      from generate_series(1, ${count}::int) as runs(n)
      cross join lateral (
        select now() - interval '10 minutes' - (runs.n + ${offset}::int) * interval '5 minutes' as completed_at,
          string_agg(md5(runs.n::text || ':' || ${offset}::text || ':' || part.n::text), '') as payload
        from generate_series(1, 40) as part(n)
      ) data`;
  };
  await seed(35500, 0, "compare", "shadow", "completed", false);
  await seed(6500, 35500, "compare", "shadow", "completed", true);
  await seed(5300, 42000, "compare", "shadow", "failed", true);
  await seed(18, 47300, "sanity_to_supabase", "apply", "completed", false);
  await seed(7, 47318, "sanity_to_supabase", "apply", "failed", false);
  await sql`vacuum analyze migration.sync_runs`;

  await sql`
    insert into migration.commerce_request_metrics
      (route, backend, cutover_generation, duration_ms, status_code, response_bytes)
    values ('checkout', 'supabase', 0, 120, 200, 600), ('checkout', 'supabase', 0, 200, 500, 800),
      ('payment/reconcile', 'supabase', 0, 5000, 500, 9000)`;
  await sql`
    insert into commerce.payment_records
      (provider, status, session_scope, quote_fingerprint, provider_idempotency_key,
       amount_subunits, currency, session_expires_at)
    values ('paypal', 'captured', 'scale-test', 'scale-test', 'scale-test', 100, 'USD', now() + interval '1 hour')`;

  await scenario("the health report does not scan the sync run log", async () => {
    const scans = {};
    for (const name of ["roo_commerce_readiness", "roo_commerce_integrity_readiness",
      "roo_supabase_release_readiness"]) {
      scans[name] = await sql.begin(async tx => {
        await tx`set local role service_role`;
        const readStats = async () => {
          const [stats] = await tx`
            select seq_scan, idx_scan, seq_tup_read from pg_stat_xact_user_tables
            where schemaname = 'migration' and relname = 'sync_runs'`;
          return stats;
        };
        const before = await readStats();
        await tx.unsafe(`select public.${name}()`);
        const after = await readStats();
        return Object.fromEntries(Object.keys(after).map(key => [key, Number(after[key]) - Number(before[key])]));
      });
    }
    const fullScans = Object.values(scans).filter(stats => stats.seq_scan > 0).length;
    assert.equal(fullScans, 0);
    for (const stats of Object.values(scans)) assert.equal(stats.seq_scan + stats.idx_scan, 0);
    return { fullScans, scans };
  });

  await scenario("the report keeps the same fields", async () => {
    const portKeys = ["capturedWithoutBooking", "creatorProjectionDrift", "credentialRecovery", "discordRetry",
      "duplicatePaymentAliases", "identityDrift", "invalidPaymentAliases", "notifiedRescheduleCases", "oauthIntents",
      "openRescheduleCases", "paymentAliasesTotal", "providerRecoveryCases", "reciprocalLinkMismatches",
      "rescheduleCases", "staleProviderRecovery", "unnotifiedRescheduleCases", "validPaymentAliases"];
    const expected = {
      roo_commerce_readiness: ["captured_without_booking", "coupon_mismatches", "duplicate_active_slots",
        "email_oldest_retry_at", "email_retries", "recent_metrics", "referral_ambiguous"],
      roo_commerce_integrity_readiness: ["command_conflicts", "control", "full_projector_calls_in_commands",
        "orphan_claimed_proofs", "orphan_free_proofs"],
      roo_supabase_release_readiness: [...portKeys, "referralFallbackAuthority"].sort(),
      roo_supabase_port_readiness: portKeys,
    };
    for (const [name, keys] of Object.entries(expected)) {
      const [row] = await sql.unsafe(`select public.${name}() as value`);
      assert.deepEqual(Object.keys(row.value).sort(), keys);
      if (name === "roo_commerce_readiness") {
        assert.equal(row.value.captured_without_booking, 1);
        assert.deepEqual(row.value.recent_metrics,
          { sample_count: 2, p95_ms: 196, error_rate: 50, max_response_bytes: 800 });
      }
    }
  });

  await scenario("the health report answers through the REST API", async () => {
    const names = ["roo_commerce_readiness", "roo_commerce_integrity_readiness", "roo_supabase_release_readiness",
      "roo_referral_email_readiness", "roo_cms_publish_readiness"];
    const responses = await Promise.all(names.map(name => fixture.client.rpc(name)));
    for (const { data, error } of responses) {
      assert.equal(error, null, error?.message);
      assert.ok(data && typeof data === "object" && !Array.isArray(data));
    }
  });
  console.log(JSON.stringify({ ok: results.every(result => result.passed), results }));
  assert.ok(results.every(result => result.passed), "one or more scenarios failed");
} finally {
  await fixture?.stop();
  restoreNetwork?.();
}

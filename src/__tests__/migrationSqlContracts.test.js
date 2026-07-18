import fs from "node:fs";
import path from "node:path";
import {
  hasBoundedMigrationPrefix,
  hasBrowserDataGrant,
  hasServiceRoleOnlyGrant,
} from "../../scripts/lib/migration-sql-contracts.mjs";

describe("migration SQL release contracts", () => {
  test("requires timeout statements before every other statement", () => {
    expect(hasBoundedMigrationPrefix(
      "set lock_timeout = '5s';\nset statement_timeout = '120s';\nselect 1;"
    )).toBe(true);
    expect(hasBoundedMigrationPrefix(
      "select 1;\nset lock_timeout = '5s';\nset statement_timeout = '120s';\n"
    )).toBe(false);
  });

  test("detects browser roles anywhere in a data grant recipient list", () => {
    expect(hasBrowserDataGrant(
      "grant select on accounts.private_rows to service_role, authenticated;"
    )).toBe(true);
    expect(hasBrowserDataGrant(
      "grant execute on function public.private_rpc() to authenticated;"
    )).toBe(false);
  });

  test("requires one statement-specific service-role-only grant", () => {
    const target = /^grant\s+execute\s+on\s+function\s+public\.private_rpc\s*\(/i;
    expect(hasServiceRoleOnlyGrant(
      "grant execute on function public.private_rpc() to service_role;",
      target
    )).toBe(true);
    expect(hasServiceRoleOnlyGrant(
      "grant execute on function public.private_rpc() to service_role, anon;",
      target
    )).toBe(false);
    expect(hasServiceRoleOnlyGrant(
      "grant execute on function public.private_rpc() to anon;\n" +
        "grant execute on function public.other_rpc() to service_role;",
      target
    )).toBe(false);
  });

  test("expires Supabase holds through the fenced canonical mutation pipeline", () => {
    const migration = fs.readFileSync(
      path.resolve(
        "supabase/migrations/20260716025151_expire_supabase_owned_holds_canonically.sql"
      ),
      "utf8"
    );
    const canonicalMutation = fs.readFileSync(
      path.resolve(
        "supabase/migrations/20260712031331_harden_commerce_integrity_and_recovery.sql"
      ),
      "utf8"
    );

    for (const required of [
      "migration.assert_commerce_write_fence(p_cutover_generation)",
      "for update of source skip locked",
      "public.roo_apply_commerce_document_mutations(",
      "'phase', 'expired'",
      "'holdNonce', gen_random_uuid()::text",
      "from public, anon, authenticated, service_role",
      "to service_role",
    ]) {
      expect(migration).toContain(required);
    }
    for (const required of [
      "migration.project_commerce_document_ids(v_changed_ids)",
      "migration.cleanup_commerce_document_ids(v_changed_ids)",
      "insert into migration.commerce_mirror_outbox",
    ]) {
      expect(canonicalMutation).toContain(required);
    }
  });

  test("serializes holds and bookings through authoritative slot claims", () => {
    const migration = fs.readFileSync(
      path.resolve(
        "supabase/migrations/20260718010000_serialize_commerce_slot_claims.sql"
      ),
      "utf8"
    );

    for (const required of [
      "project_commerce_document_ids_unserialized",
      "migration.reconcile_slot_claims_for_times(v_affected)",
      "pg_catalog.pg_advisory_xact_lock",
      "v_booking_count + v_hold_count > 1",
      "payment start requires an owned slot claim",
      "deferrable initially deferred",
      "commerce.slot_holds",
      "commerce.booking_slots",
      "commerce.slot_claims",
    ]) {
      expect(migration).toContain(required);
    }
  });

  test("bounds commerce mutations before the original RPC acquires locks", () => {
    const migration = fs.readFileSync(
      path.resolve(
        "supabase/migrations/20260718011000_bound_commerce_mutations.sql"
      ),
      "utf8"
    );

    for (const required of [
      "jsonb_array_length(p_mutations) > 100",
      "pg_catalog.octet_length(p_mutations::text) > 1048576",
      "pg_catalog.octet_length(v_document::text) > 262144",
      "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$",
      "position('..' in v_id) > 0",
      "migration.roo_apply_commerce_document_mutations_unbounded(",
      "notify pgrst, 'reload schema'",
    ]) {
      expect(migration).toContain(required);
    }
  });

  test("requires active licensing principals and revokes inactive sessions", () => {
    const migration = fs.readFileSync(
      path.resolve(
        "supabase/migrations/20260718012000_require_active_licensing_principals.sql"
      ),
      "utf8"
    );

    for (const required of [
      "accounts.require_active_principal_for_user",
      "principal.status = 'active'",
      "public.roo_claim_entitlement(",
      "public.roo_activate_device(",
      "public.roo_revoke_device(",
      "public.roo_entitlement_status(",
      "banned_until = 'infinity'::timestamptz",
      "delete from auth.refresh_tokens",
      "delete from auth.sessions",
      "principals_revoke_sessions_on_inactive",
    ]) {
      expect(migration).toContain(required);
    }
  });

  test("migrates only the current five-route Tourney acceptance contract", () => {
    const migration = fs.readFileSync(
      path.resolve(
        "supabase/migrations/20260718013000_refresh_tourney_shadow_acceptance.sql"
      ),
      "utf8"
    );

    for (const route of [
      "public_roster",
      "public_bracket",
      "admin_players",
      "appeals",
      "payouts",
    ]) {
      expect(migration).toContain(`'${route}'`);
    }
    expect(migration).toContain("coalesce(summary.samples, 0) < 30");
    expect(migration).toContain("coalesce(summary.mismatches, 0) > 0");
    expect(migration).toContain("baseline.primary_p95_ms * 1.2");
    expect(migration).toContain(
      "metadata.clock_last_reset_reason = 'shadow_acceptance_gate_failed'"
    );
  });
});

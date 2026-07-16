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
});

import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260712180401_close_tourney_cutover_gaps.sql"
  ),
  "utf8"
);
const cutoverCli = fs.readFileSync(
  path.join(process.cwd(), "scripts", "tourney-cutover.mjs"),
  "utf8"
);
const activationV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260712205616_activate_tourney_schema_v4.sql"
  ),
  "utf8"
);

describe("Tourney cutover migration", () => {
  test("keeps the control-plane private and service-only", () => {
    expect(migration).toContain("alter table %s enable row level security");
    expect(migration).toContain("revoke all on table %s from public, anon, authenticated");
    expect(migration).toContain("grant all on table %s to service_role");
    expect(migration).toContain("revoke all on function public.roo_tourney_readiness()");
  });

  test("uses incremental upserts instead of the destructive shadow importer", () => {
    expect(migration).toContain("roo_import_tourney_snapshot_incremental");
    expect(migration).toContain("on conflict (%s) do update set %s");
    expect(migration).not.toMatch(/create or replace function public\.roo_import_tourney_snapshot\(/);
  });

  test("captures encrypted pre-cutover data with a Vault-held key", () => {
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("extensions.pgp_sym_encrypt");
    expect(migration).toContain("migration.tourney_pre_cutover_snapshots");
    expect(cutoverCli).toContain("roo_capture_tourney_hardening_snapshot");
    expect(cutoverCli).toContain("roo_capture_tourney_pre_cutover_snapshot");
    expect(cutoverCli).toContain('hardened.error.code === "PGRST202"');
    expect(cutoverCli).toContain("POSTGRES_URL_NON_POOLING");
    expect(cutoverCli).toContain('PGCONNECT_TIMEOUT: "15"');
  });

  test("records ordered outbox events and guarded target checkpoints", () => {
    expect(migration).toContain("sequence bigint generated always as identity");
    expect(migration).toContain("tourney.mirror_checkpoints");
    expect(migration).toContain("tourney.mirror_tombstones");
  });

  test("bootstraps a missing fallback only under paused Supabase-primary controls", () => {
    expect(activationV4).toContain("roo_enqueue_tourney_fallback_bootstrap");
    expect(activationV4).toContain("v_meta.primary_backend <> 'supabase'");
    expect(activationV4).toContain("not v_meta.writes_paused");
    expect(activationV4).toContain("v_meta.fallback_read_only");
    expect(activationV4).toContain("existing.record_hash = v_hash");
    expect(activationV4).toContain("grant execute on function public.roo_enqueue_tourney_fallback_bootstrap(text)");
  });
});

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
  });

  test("records ordered outbox events and guarded target checkpoints", () => {
    expect(migration).toContain("sequence bigint generated always as identity");
    expect(migration).toContain("tourney.mirror_checkpoints");
    expect(migration).toContain("tourney.mirror_tombstones");
  });
});

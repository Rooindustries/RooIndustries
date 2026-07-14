import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
const activationWorker = fs.readFileSync(
  path.join(process.cwd(), "src", "server", "tourney", "activation.js"),
  "utf8"
);
const migrationWorker = fs.readFileSync(
  path.join(process.cwd(), "src", "server", "supabase", "tourneyMigration.js"),
  "utf8"
);
const inviteScript = fs.readFileSync(
  path.join(process.cwd(), "scripts", "tourney-send-discord-invites.mjs"),
  "utf8"
);
const activationV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260712224034_activate_tourney_schema_v4.sql"
  ),
  "utf8"
);
const expandV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260712224033_expand_tourney_schema_v4.sql"
  ),
  "utf8"
);
const repairV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260714010000_repair_tourney_cutover_safety.sql"
  ),
  "utf8"
);
const baselineRestoreV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260715010000_restore_tourney_shadow_latency_baselines.sql"
  ),
  "utf8"
);
const legacyActivationV4 = fs.readFileSync(
  path.join(process.cwd(), "scripts", "tourney-schema-v4-activate-legacy.sql"),
  "utf8"
);
const legacyRepairV4 = fs.readFileSync(
  path.join(process.cwd(), "scripts", "tourney-schema-v4-repair-legacy.sql"),
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

  test("captures and locally verifies a complete fail-closed cutover snapshot", () => {
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("extensions.pgp_sym_encrypt");
    expect(migration).toContain("migration.tourney_pre_cutover_snapshots");
    expect(expandV4).toContain("vault.decrypted_secrets");
    expect(expandV4).toContain("hosted_roundtrip_verified',true");
    expect(expandV4).toContain("'auth.identities'");
    expect(expandV4).toContain("'tourney.external_operation_secrets'");
    expect(expandV4).toContain("'migration.tourney_import_preflights'");
    expect(expandV4).toContain("where intent.flow='tourney'");
    expect(expandV4).toContain("Legacy Tourney snapshot is incomplete or malformed");
    expect(expandV4).toContain("Sanity Tourney account snapshot is missing or malformed");
    expect(expandV4).toContain("Exact legacy Tourney snapshot text is required");
    expect(expandV4).toContain("p_legacy_snapshot_text::jsonb");
    expect(cutoverCli).toContain("roo_capture_tourney_hardening_snapshot");
    expect(cutoverCli).toContain("p_legacy_snapshot_text: legacyPayloadText");
    expect(cutoverCli).not.toContain("roo_capture_tourney_pre_cutover_snapshot");
    expect(cutoverCli).not.toContain("POSTGRES_URL_NON_POOLING");
    expect(cutoverCli).toContain("process.env.TOURNEY_DATABASE_URL");
    expect(cutoverCli).toContain('PGCONNECT_TIMEOUT: "15"');
    expect(cutoverCli).toContain("PGDATABASE: databaseUrl");
    expect(cutoverCli).toContain("normalize(process.env.TOURNEY_SNAPSHOT_KEY)");
    expect(cutoverCli).not.toMatch(/TOURNEY_SNAPSHOT_KEY\s*\|\|/);
    expect(cutoverCli).toContain("plaintextSha256");
    expect(cutoverCli).toContain('fs.openSync(output, "wx", 0o600)');
    expect(cutoverCli).toContain("fs.fsyncSync(descriptor)");
    expect(cutoverCli).toContain('--verify-snapshot <path>');
    expect(cutoverCli).toContain(
      '"--output <path> is required when HOME is unavailable."'
    );
    expect(cutoverCli).toContain("TOURNEY_LEGACY_SNAPSHOT_INCOMPLETE");
    expect(cutoverCli).toContain("TOURNEY_ACTIVATION_ENVIRONMENT_MISMATCH");
    expect(cutoverCli).toContain("payloadText: hosted.data?.payload_text");
    expect(activationWorker).toContain(
      "player.principal_id is distinct from account.principal_id"
    );
  });

  test("round-trips encrypted snapshots and rejects ciphertext tampering", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "tourney-cutover.mjs")
    ).href;
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        import { decryptSnapshot, encryptSnapshot, stableJson } from ${JSON.stringify(moduleUrl)};
        const secret = "snapshot-unit-test-key-32-bytes-long";
        const snapshot = { version: 2, nested: { z: 1, a: [true, "value"] } };
        const encrypted = encryptSnapshot({ snapshot, secret });
        const roundTrip = decryptSnapshot({ encrypted, secret });
        const envelope = JSON.parse(encrypted.toString("utf8"));
        const bytes = Buffer.from(envelope.ciphertext, "base64");
        bytes[0] ^= 1;
        envelope.ciphertext = bytes.toString("base64");
        let tamperRejected = false;
        try {
          decryptSnapshot({ encrypted: Buffer.from(JSON.stringify(envelope)), secret });
        } catch {
          tamperRejected = true;
        }
        process.stdout.write(JSON.stringify({
          roundTrip: stableJson(roundTrip) === stableJson(snapshot),
          tamperRejected,
        }));
      `,
    ], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ roundTrip: true, tamperRejected: true });
  });

  test("uses complete legacy keys and unique intentional invite replays", () => {
    expect(cutoverCli).toContain("--inventory-activation-v4");
    const legacySchema = fs.readFileSync(
      path.join(process.cwd(), "scripts", "tourney-cutover-legacy.sql"),
      "utf8"
    );
    expect(legacySchema).toContain("when 'tourney_bracket_counters'");
    expect(legacySchema).toContain("'entity_type', v_row->>'entity_type'");
    expect(inviteScript).toContain("discord-invite:sample:${crypto.randomUUID()}");
    expect(inviteScript).toContain("const forceRunId = force ? crypto.randomUUID() : \"\"");
  });

  test("records ordered outbox events and guarded target checkpoints", () => {
    expect(migration).toContain("sequence bigint generated always as identity");
    expect(migration).toContain("tourney.mirror_checkpoints");
    expect(migration).toContain("tourney.mirror_tombstones");
  });

  test("bootstraps complete fallback state under paused Supabase controls", () => {
    expect(repairV4).toContain("roo_enqueue_tourney_fallback_bootstrap");
    expect(repairV4).toContain("p_fallback_snapshot jsonb");
    expect(repairV4).toContain("v_meta.primary_backend <> 'supabase'");
    expect(repairV4).toContain("not v_meta.writes_paused");
    expect(repairV4).toContain("v_meta.fallback_read_only");
    expect(repairV4).toContain("v_deletes_queued := v_deletes_queued + 1");
    expect(repairV4).toContain(
      "coalesce(jsonb_typeof(p_fallback_snapshot), '') <> 'object'"
    );
    expect(repairV4).toContain("existing.status in ('pending', 'retry', 'processing')");
    expect(repairV4).toContain(
      "grant execute on function public.roo_enqueue_tourney_fallback_bootstrap(text, jsonb)"
    );
    expect(cutoverCli).toContain("p_fallback_snapshot: fallbackSnapshot");
    expect(cutoverCli).toContain("--inventory-fallback-v4");
    expect(cutoverCli).toContain("--expected-legacy-hash");
    expect(cutoverCli).toContain("TOURNEY_FALLBACK_BOOTSTRAP_HASH_MISMATCH");
    expect(cutoverCli).toContain('rpc("roo_tourney_readiness")');
    expect(cutoverCli).not.toContain("getTourneySqlForBackend");
  });

  test("installs Supabase DDL additively and activates only through an explicit guarded function", () => {
    const supabaseDdl = activationV4.indexOf("create index if not exists");
    const supabaseActivation = activationV4.indexOf(
      "create or replace function public.roo_activate_tourney_schema_v4"
    );
    const legacyGuard = legacyActivationV4.indexOf("Legacy Tourney activation safety preconditions");
    const legacyDdl = legacyActivationV4.indexOf("create index if not exists");
    expect(supabaseDdl).toBeGreaterThan(0);
    expect(supabaseActivation).toBeGreaterThan(supabaseDdl);
    expect(legacyGuard).toBeGreaterThan(0);
    expect(legacyGuard).toBeLessThan(legacyDdl);
    expect(activationV4).toContain("v_meta.primary_backend <> 'supabase'");
    expect(activationV4).toContain("not v_meta.writes_paused");
    expect(activationV4).toContain("v_meta.generation <> 1");
    expect(activationV4).toContain("v_meta.fallback_read_only");
    expect(activationV4).toContain("revoke all on function public.roo_activate_tourney_schema_v4(text)");
    expect(activationV4.slice(0, supabaseActivation)).not.toContain(
      "set hardened_active = true"
    );
    expect(legacyActivationV4).toContain("v_primary_backend <> 'supabase'");
    expect(legacyActivationV4).toContain(
      "to_regprocedure('public.digest(bytea,text)') is null"
    );
    expect(legacyActivationV4).toContain("for share;");
  });

  test("keeps the Supabase forward repair install-only while legacy repair stays guarded", () => {
    const repairDdl = repairV4.indexOf("create or replace function");
    expect(repairDdl).toBeGreaterThan(0);
    expect(repairV4).toContain(
      "activation remains gated by public.roo_activate_tourney_schema_v4(text)"
    );
    expect(repairV4).not.toContain("Supabase Tourney repair safety preconditions");
    expect(legacyRepairV4).toContain("for share;");
  });

  test("repairs a recorded schema-v4 install missing the latency baseline table", () => {
    expect(baselineRestoreV4).toContain(
      "create table if not exists tourney.shadow_latency_baselines"
    );
    expect(baselineRestoreV4).toContain(
      "alter table tourney.shadow_latency_baselines enable row level security"
    );
    expect(baselineRestoreV4).toContain(
      "revoke all on table tourney.shadow_latency_baselines"
    );
    expect(repairV4).not.toContain(
      "create table if not exists tourney.shadow_latency_baselines"
    );
  });

  test("repairs legacy empty-search-path mirror calls in a forward script", () => {
    for (const sql of [legacyActivationV4, legacyRepairV4]) {
      expect(sql).toContain("public.tourney_mirror_record_key");
      expect(sql).toContain("public.digest");
      expect(sql).toContain("pg_catalog.convert_to");
    }
    expect(cutoverCli).toContain("--repair-legacy-v4");
  });

  test("normalizes import hashes and prunes only under tombstone controls", () => {
    expect(repairV4).toContain("tourney.delete_snapshot_missing_rows");
    expect(repairV4).toContain("jsonb_populate_recordset(null::tourney.%I, $1)");
    expect(repairV4).toContain("coalesce(jsonb_typeof(p_snapshot), '') <> 'object'");
    expect(repairV4).toContain("coalesce(jsonb_typeof(p_rows), '') <> 'array'");
    expect(repairV4).toContain("'deleted_counts', v_deleted_counts");
    expect(repairV4).toContain("Tourney reconciliation requires a complete snapshot");
  });

  test("preflights Auth before importing and queues projection work durably", () => {
    const authPreflight = migrationWorker.indexOf("await preflightPlayerAuth");
    const targetPreflight = migrationWorker.indexOf(
      'await client.rpc("roo_preflight_tourney_snapshot_v4"'
    );
    const snapshotImport = migrationWorker.indexOf(
      'await client.rpc("roo_import_tourney_snapshot_v4"'
    );
    expect(authPreflight).toBeGreaterThan(0);
    expect(targetPreflight).toBeGreaterThan(authPreflight);
    expect(snapshotImport).toBeGreaterThan(targetPreflight);
    expect(migrationWorker).toContain("p_preflight_id: preflight.preflight_id");
    expect(migrationWorker).toContain('operationKind: "supabase_player_auth"');
    expect(migrationWorker).toContain("maintenanceWhilePaused: true");
    expect(migrationWorker).toContain("attemptExternalWork: false");
    expect(migrationWorker).not.toContain("auth.admin.createUser");
    expect(migrationWorker).not.toContain("auth.admin.updateUserById");
  });

  test("treats non-2xx observations and blocked reauthentication as blockers", () => {
    expect(repairV4).toContain("coalesce(primary_status between 200 and 299, false)");
    expect(repairV4).toContain("coalesce(shadow_status between 200 and 299, false)");
    expect(repairV4).toContain("'dead_letter','blocked','blocked_reauth'");
  });
});

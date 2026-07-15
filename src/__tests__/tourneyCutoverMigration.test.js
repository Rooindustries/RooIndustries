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
const postgresConnectionEnv = fs.readFileSync(
  path.join(process.cwd(), "scripts", "lib", "postgres-connection-env.mjs"),
  "utf8"
);
const postgresConnectionTarget = fs.readFileSync(
  path.join(process.cwd(), "scripts", "lib", "postgres-connection-target.cjs"),
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
const snapshotRpcRepairV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260715020000_repair_tourney_hardening_snapshot_rpc.sql"
  ),
  "utf8"
);
const baselineRecoveryV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260715030000_allow_paused_tourney_baseline_recovery.sql"
  ),
  "utf8"
);
const baselineClockResetV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260715040000_reset_tourney_hardening_clock_for_baseline_recovery.sql"
  ),
  "utf8"
);
const compactSnapshotPayloadV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260715070000_return_compact_tourney_snapshot_payload.sql"
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
const triggerBindingRepairV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260715060000_repair_tourney_mirror_trigger_bindings.sql"
  ),
  "utf8"
);
const legacyTriggerBindingRepairV4 = fs.readFileSync(
  path.join(
    process.cwd(),
    "scripts",
    "tourney-schema-v4-trigger-binding-repair-legacy.sql"
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
    expect(cutoverCli).toContain("normalize(process.env.SUPABASE_DATABASE_URL)");
    expect(cutoverCli).toContain('const { default: postgres } = await import("postgres")');
    expect(cutoverCli).toContain("${legacyPayloadText}::text");
    expect(cutoverCli).toContain("touchesSupabaseDatabase: true");
    expect(cutoverCli).toContain('application_name: "roo-industries-tourney-snapshot"');
    expect(cutoverCli).toContain("TOURNEY_SUPABASE_DATABASE_CONNECTION_REQUIRED");
    expect(cutoverCli).not.toContain("p_legacy_snapshot_text: legacyPayloadText");
    expect(cutoverCli).not.toContain("roo_capture_tourney_pre_cutover_snapshot");
    expect(cutoverCli).not.toContain("POSTGRES_URL_NON_POOLING");
    expect(cutoverCli).toContain("process.env.TOURNEY_DATABASE_URL");
    expect(cutoverCli).toContain("const env = buildPostgresConnectionEnv(databaseUrl)");
    expect(postgresConnectionEnv).toContain(
      "connectionTarget.buildPostgresConnectionEnv"
    );
    expect(postgresConnectionEnv).toContain(
      "connectionTarget.buildPostgresConnectionOptions"
    );
    expect(postgresConnectionEnv).toContain(
      "connectionTarget.buildPostgresSessionArgs"
    );
    expect(postgresConnectionTarget).toContain('env.PGCONNECT_TIMEOUT = "15"');
    expect(postgresConnectionTarget).toContain("env.PGHOST");
    expect(postgresConnectionTarget).toContain("env.PGPORT");
    expect(postgresConnectionTarget).toContain("env.PGUSER");
    expect(postgresConnectionTarget).toContain("env.PGPASSWORD");
    expect(postgresConnectionTarget).toContain("env.PGDATABASE");
    expect(postgresConnectionTarget).toContain("buildPostgresSessionArgs");
    expect(cutoverCli).toContain('execFileAsync("psql", buildPostgresSessionArgs(args)');
    expect(postgresConnectionTarget).toContain("set search_path=pg_catalog,public");
    expect(postgresConnectionTarget).toContain("set statement_timeout='120s'");
    expect(postgresConnectionTarget).toContain("set lock_timeout='5s'");
    expect(cutoverCli).not.toContain('[databaseUrl, ...args]');
    expect(cutoverCli).toContain("normalize(process.env.TOURNEY_SNAPSHOT_KEY)");
    expect(cutoverCli).not.toMatch(/TOURNEY_SNAPSHOT_KEY\s*\|\|/);
    expect(cutoverCli).toContain("plaintextSha256");
    expect(cutoverCli).toContain('fs.openSync(canonicalOutput, "wx", 0o600)');
    expect(cutoverCli).toContain("TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT");
    expect(cutoverCli).toContain("fs.fsyncSync(reservation.descriptor)");
    expect(cutoverCli).toContain('--verify-snapshot <path>');
    expect(cutoverCli).toContain('"Tourney Cutover"');
    expect(cutoverCli).toContain("approved snapshot directory");
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

  test("validates a hosted snapshot from exact payload text without a duplicate payload", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "tourney-cutover.mjs")
    ).href;
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        import crypto from "node:crypto";
        import {
          HOSTED_SNAPSHOT_RELATIONS,
          stableJson,
          validateHostedSnapshot,
        } from ${JSON.stringify(moduleUrl)};
        const legacyData = { tourney_players: [] };
        const sanityAccount = { _id: "tourneyAuthStore" };
        const payload = Object.fromEntries(
          HOSTED_SNAPSHOT_RELATIONS.map((relation) => [relation, []])
        );
        payload.legacy = legacyData;
        payload.sanity_account = sanityAccount;
        const payloadText = JSON.stringify(payload);
        const payloadSha256 = crypto.createHash("sha256").update(payloadText).digest("hex");
        const tableCounts = Object.fromEntries(
          HOSTED_SNAPSHOT_RELATIONS.map((relation) => [relation, 0])
        );
        const proof = validateHostedSnapshot({
          data: {
            snapshot_id: "10000000-0000-4000-8000-000000000001",
            payload_sha256: payloadSha256,
            table_counts: tableCounts,
            payload_text: payloadText,
            hosted_roundtrip_verified: true,
          },
          legacyData,
          sanityAccount,
        });
        if (stableJson(proof.payload) !== stableJson(payload)) process.exit(1);
        if (proof.payloadTextSha256 !== payloadSha256) process.exit(2);
        try {
          validateHostedSnapshot({
            data: {
              snapshot_id: "10000000-0000-4000-8000-000000000001",
              payload_sha256: payloadSha256,
              table_counts: tableCounts,
              payload: { incorrect: true },
              payload_text: payloadText,
              hosted_roundtrip_verified: true,
            },
            legacyData,
            sanityAccount,
          });
          process.exit(3);
        } catch (error) {
          if (error.code !== "TOURNEY_HOSTED_SNAPSHOT_PROOF_INVALID") process.exit(4);
        }
        process.stdout.write("ok");
      `,
    ], { encoding: "utf8" });
    expect(output).toBe("ok");
  });

  test("converts PostgreSQL URLs into isolated libpq environment fields", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "lib", "postgres-connection-env.mjs")
    ).href;
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        import {
          buildPostgresConnectionEnv,
          buildPostgresConnectionOptions,
        } from ${JSON.stringify(moduleUrl)};
        const env = buildPostgresConnectionEnv(
          "postgresql://user%40tenant:p%3A%40ss@[2001:db8::1]:6543/tourney%20fallback?sslmode=require&channel_binding=prefer&target_session_attrs=read-write",
          { PATH: "/bin", PGHOST: "stale", PGPASSWORD: "stale", pgservice: "stale" }
        );
        const defaults = buildPostgresConnectionEnv(
          "postgres://user:secret@database.example/roo?sslmode=require",
          { PATH: "/bin" }
        );
        const rejected = [];
        let requiredChannelBinding;
        try {
          buildPostgresConnectionOptions(
            "postgres://user:secret@database.example/roo?sslmode=require&channel_binding=require"
          );
        } catch (error) {
          requiredChannelBinding = error.message;
        }
        for (const value of [
          "https://database.example/roo",
          "postgres:///roo",
          "postgres://database.example/roo",
          "postgres://user@database.example/roo",
          "postgres://user@database.example/",
          "postgres://bad%ZZ@database.example/roo",
          "postgres://user:secret@database.example/roo?options=-c%20search_path%3Dpublic",
          "postgres://user:secret@database.example/roo?sslmode=require&sslmode=prefer",
          "postgres://user:secret@database.example/roo?sslmode=invalid",
          "postgres://user:secret@database.example/roo?channel_binding=invalid",
          "postgres://user:secret@database.example/roo?target_session_attrs=invalid",
          "postgres://user:secret@database.example/roo?host=other.example",
          "postgresql://user:secret@%2Fvar%2Frun%2Fpostgresql/roo",
          "postgres://user:secret@database.example/roo#fragment",
          "postgres://user:secret@database.example/roo",
          "postgres://user:secret@database.example/roo?sslmode=disable",
          "postgres://user:secret@database.example/roo?sslmode=allow",
          "postgres://user:secret@database.example/roo?sslmode=prefer",
        ]) {
          try {
            buildPostgresConnectionEnv(value, {});
          } catch (error) {
            rejected.push(error.message);
          }
        }
        process.stdout.write(JSON.stringify({ env, defaults, rejected, requiredChannelBinding }));
      `,
    ], { encoding: "utf8" });
    const result = JSON.parse(output);
    expect(result.env).toEqual({
      PATH: "/bin",
      PGHOST: "2001:db8::1",
      PGPORT: "6543",
      PGUSER: "user@tenant",
      PGDATABASE: "tourney fallback",
      PGCONNECT_TIMEOUT: "15",
      PGPASSWORD: "p:@ss",
      PGCHANNELBINDING: "prefer",
      PGSSLMODE: "require",
      PGTARGETSESSIONATTRS: "read-write",
    });
    expect(result.defaults).toEqual({
      PATH: "/bin",
      PGHOST: "database.example",
      PGPORT: "5432",
      PGUSER: "user",
      PGPASSWORD: "secret",
      PGDATABASE: "roo",
      PGCONNECT_TIMEOUT: "15",
      PGSSLMODE: "require",
    });
    expect(result.rejected).toHaveLength(18);
    expect(result.rejected.join(" ")).not.toContain("bad%ZZ");
    expect(result.requiredChannelBinding).toBe(
      "The PostgreSQL connection URL has an invalid parameter value."
    );
  });

  test("fails closed on unsafe CLI arguments, paths, environments, and timeouts", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "tourney-cutover.mjs")
    ).href;
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        import fs from "node:fs";
        import os from "node:os";
        import path from "node:path";
        import {
          loadEnvironment,
          main,
          parseCliAction,
          printTargetFingerprints,
          reserveSnapshotOutput,
          resolveSnapshotInput,
          runPsql,
        } from ${JSON.stringify(moduleUrl)};
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tourney-cli-test-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tourney-cli-outside-"));
        const capture = async (operation) => {
          try {
            await operation();
            return "accepted";
          } catch (error) {
            return { code: error.code || "", message: error.message };
          }
        };
        try {
          const validEnv = path.join(root, "valid.env");
          const insecureEnv = path.join(root, "insecure.env");
          const memoryDatabaseEnv = path.join(root, "memory-database.env");
          const memoryAccountEnv = path.join(root, "memory-account.env");
          const missingDatabaseModeEnv = path.join(root, "missing-database-mode.env");
          const typoDatabaseModeEnv = path.join(root, "typo-database-mode.env");
          fs.writeFileSync(validEnv, "CUTOVER_TEST_MARKER=loaded\\nTOURNEY_DATABASE_MODE=supabase\\n", { mode: 0o600 });
          fs.writeFileSync(insecureEnv, "CUTOVER_TEST_MARKER=insecure\\n", { mode: 0o600 });
          fs.writeFileSync(memoryDatabaseEnv, "NODE_ENV=production\\nTOURNEY_DATABASE_MODE=memory\\n", { mode: 0o600 });
          fs.writeFileSync(memoryAccountEnv, "NODE_ENV=production\\nTOURNEY_DATABASE_MODE=supabase\\nTOURNEY_ACCOUNT_STORE_MODE=memory\\n", { mode: 0o600 });
          fs.writeFileSync(missingDatabaseModeEnv, "NODE_ENV=production\\n", { mode: 0o600 });
          fs.writeFileSync(typoDatabaseModeEnv, "NODE_ENV=production\\nTOURNEY_DATABASE_MODE=legcay\\n", { mode: 0o600 });
          fs.chmodSync(insecureEnv, 0o644);
          process.argv = ["node", "test", "--env", "--snapshot"];
          const missingEnvValue = await capture(() => loadEnvironment());
          process.argv = ["node", "test", "--env", path.join(root, "missing.env")];
          const missingEnv = await capture(() => loadEnvironment());
          process.argv = ["node", "test", "--env", insecureEnv];
          const insecure = await capture(() => loadEnvironment());
          process.env.CUTOVER_TEST_MARKER = "ambient";
          process.env.SUPABASE_URL = "https://ambient.invalid";
          process.env.SANITY_PROJECT_ID = "ambient-project";
          process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "ambient-public-project";
          process.env.TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT = "a".repeat(64);
          process.argv = ["node", "test", "--env", validEnv];
          loadEnvironment();
          const environmentLoaded = process.env.CUTOVER_TEST_MARKER;
          const ambientSupabaseCleared = process.env.SUPABASE_URL === undefined;
          const ambientSanityCleared = process.env.SANITY_PROJECT_ID === undefined &&
            process.env.NEXT_PUBLIC_SANITY_PROJECT_ID === undefined &&
            process.env.TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT === undefined;

          process.argv = ["node", "test", "--output", "relative.enc"];
          const relativeOutput = await capture(() => reserveSnapshotOutput("2026-07-15T00:00:00.000Z", { allowedRoot: root }));
          process.argv = ["node", "test", "--output", path.join(process.cwd(), "blocked.enc")];
          const repositoryOutput = await capture(() => reserveSnapshotOutput("2026-07-15T00:00:00.000Z", { allowedRoot: root }));
          const linkedParent = path.join(root, "linked-parent");
          fs.symlinkSync(process.cwd(), linkedParent, "dir");
          process.argv = ["node", "test", "--output", path.join(linkedParent, "blocked.enc")];
          const linkedOutput = await capture(() => reserveSnapshotOutput("2026-07-15T00:00:00.000Z", { allowedRoot: root }));
          const nestedLink = path.join(root, "nested-link");
          fs.symlinkSync(outside, nestedLink, "dir");
          process.argv = ["node", "test", "--output", path.join(nestedLink, "new", "blocked.enc")];
          const linkedNestedOutput = await capture(() => reserveSnapshotOutput("2026-07-15T00:00:00.000Z", { allowedRoot: root }));
          const linkedNestedCreatedOutside = fs.existsSync(path.join(outside, "new"));
          const rootAlias = path.join(outside, "root-alias");
          fs.symlinkSync(root, rootAlias, "dir");
          process.argv = ["node", "test", "--output", path.join(rootAlias, "blocked.enc")];
          const linkedRootOutput = await capture(() => reserveSnapshotOutput("2026-07-15T00:00:00.000Z", { allowedRoot: rootAlias }));
          const externalOutput = path.join(root, "snapshot.enc");
          process.argv = ["node", "test", "--output", externalOutput];
          const reservation = reserveSnapshotOutput("2026-07-15T00:00:00.000Z", { allowedRoot: root });
          const outputMode = (fs.fstatSync(reservation.descriptor).mode & 0o777).toString(8);
          fs.closeSync(reservation.descriptor);

          process.argv = ["node", "test", "--verify-snapshot", externalOutput];
          const resolvedInput = resolveSnapshotInput({ allowedRoot: root }) === fs.realpathSync(externalOutput);
          process.argv = ["node", "test", "--verify-snapshot", "relative.enc"];
          const relativeInput = await capture(() => resolveSnapshotInput({ allowedRoot: root }));
          process.argv = ["node", "test", "--snapshot", "--parity"];
          const ambiguousAction = await capture(() => main());
          process.argv = ["node", "test", "--snapshot"];
          const snapshotTouchesSanity = parseCliAction().touchesSanity === true;
          process.argv = ["node", "test", "--parity"];
          const parityAction = parseCliAction();
          const parityTouchesSanity = parityAction.touchesSanity === true;
          const parityTouchesSupabaseDatabase = parityAction.touchesSupabaseDatabase === true;
          process.argv = ["node", "test", "--migrate"];
          const migrateTouchesSupabaseDatabase =
            parseCliAction().touchesSupabaseDatabase === true;
          process.argv = ["node", "test", "--inventory-activation-v4"];
          const activationInventoryTargets = parseCliAction();
          const inventoryTouchesSanity = activationInventoryTargets.touchesSanity === true;
          const inventoryTouchesDiscord = activationInventoryTargets.touchesDiscord === true;
          const actionArguments = {
            "--print-target-fingerprints": [],
            "--snapshot": [],
            "--verify-snapshot": [externalOutput],
            "--apply-legacy-schema": [],
            "--expand-legacy-v4": [],
            "--activate-legacy-v4": [],
            "--activate-supabase-v4": [],
            "--repair-legacy-v4": [],
            "--repair-legacy-trigger-bindings-v4": [],
            "--inventory-activation-v4": [],
            "--capture-latency-baseline-v4": [],
            "--apply-activation-v4": ["--inventory-hash", "a".repeat(64)],
            "--inventory-fallback-v4": [],
            "--bootstrap-fallback-v4": ["--expected-legacy-hash", "b".repeat(64)],
            "--check-manual-failover-v4": [],
            "--migrate": [],
            "--parity": [],
          };
          const actionTargets = {};
          for (const [flag, values] of Object.entries(actionArguments)) {
            process.argv = ["node", "test", flag, ...values];
            const action = parseCliAction();
            actionTargets[flag] = [
              action.touchesLegacy,
              action.touchesSupabase,
              action.touchesSupabaseDatabase,
              action.touchesSanity,
              action.touchesDiscord,
            ].map(Boolean);
          }
          process.argv = ["node", "test", "--apply-legacy-schema"];
          const explicitEnvironmentRequired = await capture(() => main());
          process.argv = ["node", "test", "--print-target-fingerprints"];
          const fingerprintEnvironmentRequired = await capture(() => main());
          process.env.NODE_ENV = "test";
          process.argv = ["node", "test", "--apply-legacy-schema", "--env", validEnv];
          const testRuntimeRejected = await capture(() => main());
          process.argv = ["node", "test", "--apply-legacy-schema", "--env", memoryDatabaseEnv];
          const memoryDatabaseRejected = await capture(() => main());
          process.argv = ["node", "test", "--apply-legacy-schema", "--env", memoryAccountEnv];
          const memoryAccountRejected = await capture(() => main());
          process.argv = ["node", "test", "--apply-legacy-schema", "--env", missingDatabaseModeEnv];
          const missingDatabaseModeRejected = await capture(() => main());
          process.argv = ["node", "test", "--apply-legacy-schema", "--env", typoDatabaseModeEnv];
          const typoDatabaseModeRejected = await capture(() => main());
          process.argv = ["node", "test", "--apply-legacy-schema", "accidental"];
          const positionalArgument = await capture(() => parseCliAction());
          process.argv = ["node", "test", "--apply-legacy-schema", "--expected-legacy-hash", "abc"];
          const irrelevantOption = await capture(() => parseCliAction());
          process.argv = ["node", "test", "--apply-legacy-schema", "--env", validEnv, "--env", validEnv];
          const duplicateOption = await capture(() => parseCliAction());
          process.argv = ["node", "test", "--apply-activation-v4"];
          const missingRequiredOption = await capture(() => parseCliAction());

          Object.assign(process.env, {
            TOURNEY_DATABASE_URL: "postgresql://legacy:placeholder@legacy.example.com/tourney",
            SUPABASE_URL: "https://projectref.supabase.co",
            SUPABASE_DATABASE_URL: "postgresql://postgres:placeholder@db.projectref.supabase.co/postgres",
            SANITY_PROJECT_ID: "roo-project",
            SANITY_DATASET: "production",
            DISCORD_GUILD_ID: "111111111111111111",
            DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
            DISCORD_HOST_ROLE_ID: "333333333333333333",
          });
          const generatedFingerprints = printTargetFingerprints();
          const generatedFingerprintKeys = Object.keys(generatedFingerprints).sort();
          const generatedFingerprintsValid = Object.values(generatedFingerprints).every(
            (value) => /^[0-9a-f]{64}$/.test(value)
          );

          const bin = path.join(root, "bin");
          fs.mkdirSync(bin);
          const fakePsql = path.join(bin, "psql");
          fs.writeFileSync(fakePsql, "#!/usr/bin/env node\\nsetTimeout(() => {}, 10000);\\n", { mode: 0o700 });
          process.env.PATH = bin + path.delimiter + process.env.PATH;
          const timeout = await capture(() => runPsql(
            "postgresql://user:password@database.example/roo?sslmode=require&channel_binding=prefer",
            [],
            { timeout: 20 }
          ));
          process.stdout.write(JSON.stringify({
            missingEnvValue,
            missingEnv,
            insecure,
            environmentLoaded,
            ambientSupabaseCleared,
            ambientSanityCleared,
            relativeOutput,
            repositoryOutput,
            linkedOutput,
            linkedNestedOutput,
            linkedNestedCreatedOutside,
            linkedRootOutput,
            outputMode,
            resolvedInput,
            relativeInput,
            ambiguousAction,
            snapshotTouchesSanity,
            parityTouchesSanity,
            parityTouchesSupabaseDatabase,
            migrateTouchesSupabaseDatabase,
            inventoryTouchesSanity,
            inventoryTouchesDiscord,
            actionTargets,
            explicitEnvironmentRequired,
            fingerprintEnvironmentRequired,
            testRuntimeRejected,
            memoryDatabaseRejected,
            memoryAccountRejected,
            missingDatabaseModeRejected,
            typoDatabaseModeRejected,
            positionalArgument,
            irrelevantOption,
            duplicateOption,
            missingRequiredOption,
            generatedFingerprintKeys,
            generatedFingerprintsValid,
            timeout,
          }));
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(outside, { recursive: true, force: true });
        }
      `,
    ], { encoding: "utf8" });
    const result = JSON.parse(output);
    expect(result).toMatchObject({
      missingEnvValue: { code: "TOURNEY_CLI_ARGUMENT_INVALID" },
      missingEnv: { code: "TOURNEY_ENV_FILE_INVALID" },
      insecure: { code: "TOURNEY_ENV_FILE_INVALID" },
      environmentLoaded: "loaded",
      ambientSupabaseCleared: true,
      ambientSanityCleared: true,
      relativeOutput: { message: "--output <path> must be absolute." },
      repositoryOutput: { message: "The Tourney snapshot must be stored in the approved snapshot directory." },
      linkedOutput: { message: "The Tourney snapshot must be stored in the approved snapshot directory." },
      linkedNestedOutput: { message: "The Tourney snapshot must be stored in the approved snapshot directory." },
      linkedNestedCreatedOutside: false,
      linkedRootOutput: { message: "The approved Tourney snapshot directory is invalid." },
      outputMode: "600",
      resolvedInput: true,
      relativeInput: { message: "--verify-snapshot <path> must be absolute." },
      ambiguousAction: { code: "TOURNEY_CLI_ACTION_INVALID" },
      snapshotTouchesSanity: true,
      parityTouchesSanity: false,
      parityTouchesSupabaseDatabase: true,
      migrateTouchesSupabaseDatabase: true,
      inventoryTouchesSanity: true,
      inventoryTouchesDiscord: true,
      actionTargets: {
        "--print-target-fingerprints": [false, false, false, false, false],
        "--snapshot": [true, true, true, true, false],
        "--verify-snapshot": [false, false, false, false, false],
        "--apply-legacy-schema": [true, false, false, false, false],
        "--expand-legacy-v4": [true, false, false, false, false],
        "--activate-legacy-v4": [true, true, false, false, false],
        "--activate-supabase-v4": [true, true, true, false, false],
        "--repair-legacy-v4": [true, false, false, false, false],
        "--repair-legacy-trigger-bindings-v4": [true, true, false, false, false],
        "--inventory-activation-v4": [true, true, true, true, true],
        "--capture-latency-baseline-v4": [false, true, true, false, false],
        "--apply-activation-v4": [true, true, true, true, true],
        "--inventory-fallback-v4": [true, true, false, false, false],
        "--bootstrap-fallback-v4": [true, true, false, false, false],
        "--check-manual-failover-v4": [true, true, true, false, false],
        "--migrate": [true, true, true, false, false],
        "--parity": [true, true, true, false, false],
      },
      explicitEnvironmentRequired: { code: "TOURNEY_ENV_FILE_REQUIRED" },
      fingerprintEnvironmentRequired: { code: "TOURNEY_ENV_FILE_REQUIRED" },
      testRuntimeRejected: { code: "TOURNEY_HOSTED_EXECUTION_ENVIRONMENT_INVALID" },
      memoryDatabaseRejected: { code: "TOURNEY_HOSTED_EXECUTION_ENVIRONMENT_INVALID" },
      memoryAccountRejected: { code: "TOURNEY_HOSTED_EXECUTION_ENVIRONMENT_INVALID" },
      missingDatabaseModeRejected: { code: "TOURNEY_HOSTED_EXECUTION_ENVIRONMENT_INVALID" },
      typoDatabaseModeRejected: { code: "TOURNEY_HOSTED_EXECUTION_ENVIRONMENT_INVALID" },
      positionalArgument: { code: "TOURNEY_CLI_ARGUMENT_INVALID" },
      irrelevantOption: { code: "TOURNEY_CLI_ARGUMENT_INVALID" },
      duplicateOption: { code: "TOURNEY_CLI_ARGUMENT_INVALID" },
      missingRequiredOption: { code: "TOURNEY_CLI_ARGUMENT_INVALID" },
      generatedFingerprintKeys: [
        "TOURNEY_CUTOVER_EXPECTED_DISCORD_FINGERPRINT",
        "TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT",
        "TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT",
        "TOURNEY_CUTOVER_EXPECTED_SUPABASE_API_FINGERPRINT",
        "TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT",
      ],
      generatedFingerprintsValid: true,
      timeout: { code: "TOURNEY_LEGACY_DATABASE_COMMAND_TIMEOUT" },
    });
    expect(JSON.stringify(result)).not.toContain("password");
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

  test("defers every activation backfill side effect to the durable worker", () => {
    for (const marker of [
      "account-snapshot:seed:",
      "principal-seed:",
      "email-history-backfill:g1:v4",
      "discord-state-normalize:g",
      "discord-state-seed",
    ]) {
      const start = activationWorker.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      expect(activationWorker.slice(start, start + 900)).toContain(
        "attemptExternalWork: false"
      );
    }
  });

  test("runs every hosted target gate before action execution", () => {
    const mainSource = cutoverCli.slice(cutoverCli.indexOf("const main = async () =>"));
    const ordered = [
      "loadEnvironment();",
      "assertHostedExecutionEnvironment();",
      "assertSanityConnectionTarget();",
      "assertDiscordConnectionTarget();",
      "checks.push(assertLegacyConnectionTarget())",
      "checks.push(assertSupabaseConnectionTarget())",
      "checks.push(assertSupabaseDatabaseConnectionTarget())",
      "await Promise.all(checks);",
      "return selected.execute();",
    ].map((value) => mainSource.indexOf(value));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
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
    expect(repairV4).not.toContain("set hardened_active = true");
    expect(repairV4).not.toContain("roo_activate_tourney_schema_v4(");
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

  test("repairs the hosted snapshot RPC without retaining the incomplete signature", () => {
    expect(snapshotRpcRepairV4).toContain(
      "drop function if exists public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb)"
    );
    expect(snapshotRpcRepairV4).toContain("p_legacy_snapshot_text text default null");
    expect(snapshotRpcRepairV4).toContain("p_legacy_snapshot_text::jsonb");
    expect(snapshotRpcRepairV4).toMatch(
      /jsonb_typeof\(p_legacy_snapshot\)[\s\S]*?end if;[\s\S]*?jsonb_each\(p_legacy_snapshot\)/
    );
    expect(snapshotRpcRepairV4).toContain("metadata.schema_version");
    expect(snapshotRpcRepairV4).not.toContain("metadata.expanded_version");
    expect(snapshotRpcRepairV4).toContain("'hosted_roundtrip_verified',true");
    expect(snapshotRpcRepairV4).toContain(
      "grant execute on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)"
    );
  });

  test("returns hosted snapshot metadata and exact text without duplicating the payload", () => {
    expect(compactSnapshotPayloadV4).toContain(
      "select proof.result - 'payload'"
    );
    expect(compactSnapshotPayloadV4).toContain("set search_path = ''");
    expect(compactSnapshotPayloadV4).toContain("set statement_timeout = '120s'");
    expect(compactSnapshotPayloadV4).toContain(
      "revoke all on function tourney.capture_tourney_hardening_snapshot_payload_v4"
    );
    expect(compactSnapshotPayloadV4).toContain(
      "grant execute on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)"
    );
  });

  test("allows only an empty paused active baseline set to be recovered", () => {
    expect(baselineRecoveryV4).toContain("v_meta.hardened_active");
    expect(baselineRecoveryV4).toContain(
      "exists(select 1 from tourney.shadow_latency_baselines)"
    );
    expect(baselineRecoveryV4).toContain("schema_version");
    expect(baselineRecoveryV4).toContain("v_meta.clean_since is not null");
    expect(baselineRecoveryV4).toContain("'baseline_recovery',true");
    expect(baselineRecoveryV4).toContain("not v_meta.writes_paused");
    expect(baselineRecoveryV4).toContain("v_meta.fallback_read_only");
    expect(baselineRecoveryV4).toContain(
      "grant execute on function public.roo_capture_tourney_shadow_latency_baseline(text)"
    );
  });

  test("audits and clears only an invalidated pre-recovery clock window", () => {
    expect(baselineClockResetV4).toContain("not v_meta.hardened_active");
    expect(baselineClockResetV4).toContain("v_baselines <> 0");
    expect(baselineClockResetV4).toContain("not v_meta.writes_paused");
    expect(baselineClockResetV4).toContain("v_meta.clean_since is not null");
    expect(baselineClockResetV4).toContain("natural_mutation_verified_at=null");
    expect(baselineClockResetV4).toContain(
      "'baseline_recovery_clock_reset',true"
    );
    expect(baselineClockResetV4).toContain(
      "raise exception 'Tourney baseline recovery clock reset is not safe'"
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

  test("verifies actual fail-closed mirror trigger bodies and OID bindings", () => {
    for (const sql of [triggerBindingRepairV4, legacyTriggerBindingRepairV4]) {
      expect(sql).toContain("mirror_trigger_binding_status_v4");
      expect(sql).toContain("pg_catalog.md5(function.prosrc)");
      expect(sql).toContain("trigger.tgfoid");
      expect(sql).toContain("binding.tgtype = 29");
      expect(sql).toContain("binding.tgenabled = 'O'");
      expect(sql).toContain("summary.enabled_contracts = 17");
      expect(sql).toContain("summary.correctly_bound = summary.enabled_contracts");
      expect(sql).toContain("clock_last_reset_reason = 'mirror_trigger_binding_repaired'");
      expect(sql).toContain("insert into");
      expect(sql).toContain("cutover_gate_events");
      expect(sql).toContain("'clock_reset'");
    }
    expect(triggerBindingRepairV4).toContain("mirror_trigger_binding_drift");
    expect(triggerBindingRepairV4).toContain("shadow_reads_since_natural_mutation");
    expect(triggerBindingRepairV4).toContain(
      "assert_tourney_schema_v4_activation_ready"
    );
    expect(triggerBindingRepairV4).toContain(
      "pg_catalog.to_regprocedure("
    );
    expect(triggerBindingRepairV4).toContain(
      "'validation_only', true"
    );
    expect(triggerBindingRepairV4).toContain(
      "pg_catalog.length(p_actor) > 120"
    );
    expect(triggerBindingRepairV4).toContain(
      "'compatibility_mode', 'trigger-binding-live-schema-compat-v1'"
    );
    expect(triggerBindingRepairV4).toContain(
      "not v_meta.hardened_active"
    );
    expect(triggerBindingRepairV4).toContain("Supabase Tourney activation mirror trigger verification failed");
    expect(legacyTriggerBindingRepairV4).toContain(
      "Legacy Tourney mirror trigger repair verification failed"
    );
    expect(cutoverCli).toContain("--repair-legacy-trigger-bindings-v4");
    expect(activationWorker).toContain("TOURNEY_MIRROR_TRIGGER_BINDING_DRIFT");
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

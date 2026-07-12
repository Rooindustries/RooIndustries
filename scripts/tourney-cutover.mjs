#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient as createSanityClient } from "@sanity/client";
import dotenv from "dotenv";
import { migrateTourneyShadow } from "../src/server/supabase/tourneyMigration.js";
import { createSupabaseAdminClient } from "../src/server/supabase/adminClient.js";
import { runTourneyParity } from "../src/server/tourney/store.js";

const execFileAsync = promisify(execFile);

const envArgument = process.argv.indexOf("--env");
const envPath = envArgument >= 0 ? process.argv[envArgument + 1] : ".env.local";
if (envPath && fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: envArgument >= 0, quiet: true });
}

const hasFlag = (flag) => process.argv.includes(flag);
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};
const normalize = (value) => String(value || "").trim();
const jsonSafe = (value) => JSON.parse(JSON.stringify(value));
const legacyDatabaseUrl = () => normalize(
  process.env.TOURNEY_DATABASE_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL
);
const runPsql = async (args, options = {}) => {
  try {
    return await execFileAsync("psql", args, {
      env: { ...process.env, PGCONNECT_TIMEOUT: "15" },
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    });
  } catch (cause) {
    const detail = String(cause?.stderr || "")
      .trim()
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url-redacted]")
      .slice(0, 1000);
    const error = new Error(
      detail ? `Legacy PostgreSQL command failed: ${detail}` : "Legacy PostgreSQL command failed."
    );
    error.code = "TOURNEY_LEGACY_DATABASE_COMMAND_FAILED";
    throw error;
  }
};
const LEGACY_TABLES = [
  "tourney_players",
  "tourney_player_tokens",
  "tourney_registration_config",
  "tourney_bracket_teams",
  "tourney_bracket_team_members",
  "tourney_bracket_meta",
  "tourney_bracket_entities",
  "tourney_bracket_counters",
  "tourney_bracket_audit",
  "tourney_bracket_lock",
  "tourney_appeals",
  "tourney_payouts",
  "tourney_email_dispatches",
  "tourney_command_receipts",
  "tourney_mirror_outbox",
  "tourney_mirror_checkpoints",
  "tourney_mirror_tombstones",
  "tourney_account_snapshots",
  "tourney_external_operations",
  "tourney_discord_role_assignments",
  "tourney_identity_conflicts",
  "tourney_parity_runs",
  "tourney_cutover_metadata",
];
const readLegacySnapshot = async (databaseUrl) => {
  const tableArray = LEGACY_TABLES.map((table) => `'${table}'`).join(",");
  const { stdout: existingOutput } = await runPsql([
    databaseUrl,
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atq",
    "-c",
    `select coalesce(jsonb_agg(name order by name), '[]'::jsonb)::text
     from unnest(array[${tableArray}]::text[]) name
     where to_regclass(name) is not null`,
  ]);
  const existingTables = new Set(JSON.parse(existingOutput.trim()));
  const snapshotPairs = LEGACY_TABLES.flatMap((table) => [
    `'${table}'`,
    existingTables.has(table)
      ? `coalesce((select jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text) from "${table}" source_row), '[]'::jsonb)`
      : `'[]'::jsonb`,
  ]).join(",\n");
  const query = `
    begin isolation level repeatable read read only;
    select jsonb_build_object(${snapshotPairs})::text;
    commit;
  `;
  const { stdout } = await runPsql(
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", query],
    { maxBuffer: 100 * 1024 * 1024 }
  );
  return jsonSafe(JSON.parse(stdout.trim()));
};

const applyLegacySqlFile = async ({ databaseUrl, fileUrl }) => {
  await runPsql(
    [
      databaseUrl,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-1",
      "-f",
      fileURLToPath(fileUrl),
    ]
  );
};

const readSanityAccountDocument = async () => {
  const projectId = normalize(process.env.SANITY_PRIVATE_PROJECT_ID || process.env.SANITY_PROJECT_ID);
  const dataset = normalize(process.env.SANITY_PRIVATE_DATASET || process.env.SANITY_DATASET) || "production";
  const token = normalize(
    process.env.SANITY_PRIVATE_READ_TOKEN ||
    process.env.SANITY_READ_TOKEN ||
    process.env.SANITY_PRIVATE_WRITE_TOKEN ||
    process.env.SANITY_WRITE_TOKEN
  );
  if (!projectId) throw new Error("Sanity snapshot project is required.");
  const client = createSanityClient({
    projectId,
    dataset,
    token,
    useCdn: false,
    perspective: "raw",
    apiVersion: normalize(process.env.SANITY_API_VERSION) || "2023-10-01",
  });
  return client.fetch(
    `*[_id == "tourneyAuthStore"][0]`,
    {},
    { cache: "no-store" }
  );
};

const encryptSnapshot = ({ snapshot, secret }) => {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(snapshot));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm+scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
};

const decryptSnapshot = ({ encrypted, secret }) => {
  const envelope = JSON.parse(Buffer.from(encrypted).toString("utf8"));
  const key = crypto.scryptSync(secret, Buffer.from(envelope.salt, "base64"), 32);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));
};

const captureHostedSnapshot = async ({ legacyData, sanityAccount }) => {
  const client = createSupabaseAdminClient();
  const parameters = {
    p_legacy_snapshot: legacyData,
    p_sanity_account: sanityAccount,
  };
  const hardened = await client.rpc(
    "roo_capture_tourney_hardening_snapshot",
    parameters
  );
  if (!hardened.error) {
    return {
      data: hardened.data,
      functionName: "public.roo_capture_tourney_hardening_snapshot",
    };
  }
  const missingHardenedFunction =
    hardened.error.code === "PGRST202" ||
    /roo_capture_tourney_hardening_snapshot.*(not found|does not exist)/i.test(
      String(hardened.error.message || "")
    );
  if (!missingHardenedFunction) {
    const error = new Error("Supabase Tourney hardening snapshot failed.");
    error.code = hardened.error.code || "TOURNEY_SNAPSHOT_FAILED";
    throw error;
  }
  const preCutover = await client.rpc(
    "roo_capture_tourney_pre_cutover_snapshot",
    parameters
  );
  if (preCutover.error) {
    const error = new Error("Supabase Tourney pre-cutover snapshot failed.");
    error.code = preCutover.error.code || "TOURNEY_SNAPSHOT_FAILED";
    throw error;
  }
  return {
    data: preCutover.data,
    functionName: "public.roo_capture_tourney_pre_cutover_snapshot",
  };
};

const captureSnapshot = async () => {
  const legacyUrl = legacyDatabaseUrl();
  const encryptionSecret = normalize(
    process.env.TOURNEY_SNAPSHOT_KEY || process.env.REF_ADMIN_KEY || process.env.CRON_SECRET
  );
  if (!legacyUrl || !encryptionSecret) {
    throw new Error("Legacy and snapshot encryption credentials are required.");
  }
  const [legacyData, sanityAccount] = await Promise.all([
      readLegacySnapshot(legacyUrl),
      readSanityAccountDocument(),
  ]);
  {
    const hosted = await captureHostedSnapshot({ legacyData, sanityAccount });
    const snapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      legacy: legacyData,
      supabase: {
        hostedEncryptedSnapshot: true,
        captureFunction: hosted.functionName,
        snapshotId: hosted.data?.snapshot_id || "",
        payloadSha256: hosted.data?.payload_sha256 || "",
      },
      sanityAccount,
    };
    const encrypted = encryptSnapshot({ snapshot, secret: encryptionSecret });
    const decrypted = decryptSnapshot({ encrypted, secret: encryptionSecret });
    if (JSON.stringify(decrypted) !== JSON.stringify(snapshot)) {
      throw new Error("Local Tourney snapshot decrypt verification failed.");
    }
    const output = valueAfter("--output") || path.join(
      process.env.HOME,
      "Documents",
      "Codex",
      "Tourney Cutover",
      "pre-cutover-snapshot.enc"
    );
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, encrypted, { mode: 0o600 });
    fs.chmodSync(output, 0o600);
    return {
      output,
      sha256: crypto.createHash("sha256").update(encrypted).digest("hex"),
      legacyCounts: Object.fromEntries(
        Object.entries(legacyData).map(([table, rows]) => [table, rows.length])
      ),
      supabaseSnapshot: "hosted-encrypted",
      sanityAccountCaptured: Boolean(sanityAccount),
      localDecryptVerified: true,
    };
  }
};

const applyLegacySchema = async () => {
  const databaseUrl = legacyDatabaseUrl();
  if (!databaseUrl) throw new Error("Legacy Tourney database is not configured.");
  await applyLegacySqlFile({
    databaseUrl,
    fileUrl: new URL("./tourney-cutover-legacy.sql", import.meta.url),
  });
  return { applied: true };
};

const applyLegacyV4Phase = async (phase) => {
  const databaseUrl = legacyDatabaseUrl();
  if (!databaseUrl) throw new Error("Legacy Tourney database is not configured.");
  const fileName = phase === "activate"
    ? "tourney-schema-v4-activate-legacy.sql"
    : "tourney-schema-v4-expand-legacy.sql";
  await applyLegacySqlFile({
    databaseUrl,
    fileUrl: new URL(`./${fileName}`, import.meta.url),
  });
  return { applied: true, schemaVersion: 4, phase };
};

const seedAccountSnapshotV4 = async () => {
  const { readEffectiveTourneyAccounts, renderTourneyAccountsJson } =
    await import("../src/server/tourney/auth.js");
  const accounts = await readEffectiveTourneyAccounts();
  if (accounts.length === 0) throw new Error("Tourney account snapshot is missing.");
  const accountsJson = renderTourneyAccountsJson(accounts);
  const commandId = `account-snapshot:seed:${crypto.createHash("sha256").update(accountsJson).digest("hex").slice(0, 32)}`;
  const [{ executeTourneyCommand }, { writePersistedTourneyAccountsJson }] = await Promise.all([
    import("../src/server/tourney/store.js"),
    import("../src/server/tourney/accountStore.js"),
  ]);
  const result = await executeTourneyCommand({
    commandId,
    purpose: "accounts:seed",
    requestPayload: { canonicalHash: commandId.split(":").at(-1) },
    callback: async () => ({
      body: await writePersistedTourneyAccountsJson({
        accountsJson,
        actorUsername: "schema-v4-activation",
      }),
    }),
  });
  return { seeded: true, commandId, syncPending: Boolean(result.syncPending) };
};

const seedPlayerPrincipalsV4 = async () => {
  const [{ executeTourneyCommand }, { getTourneySql }] = await Promise.all([
    import("../src/server/tourney/store.js"),
    import("../src/server/tourney/sqlClient.js"),
  ]);
  const sql = await getTourneySql();
  const mappings = await sql`
    select player.id as player_id, account.principal_id
    from tourney.tourney_players player
    join accounts.tourney_accounts account
      on account.legacy_sanity_id = player.id
    where account.principal_id is not null
    order by player.id
  `;
  for (const mapping of mappings) {
    const commandId = `principal-seed:${mapping.player_id}:${mapping.principal_id}`;
    await executeTourneyCommand({
      commandId,
      purpose: "identity:principal-seed",
      requestPayload: {
        playerId: mapping.player_id,
        principalId: mapping.principal_id,
      },
      callback: async () => {
        const transactionSql = await getTourneySql();
        await transactionSql`
          update tourney.tourney_players
          set principal_id = ${mapping.principal_id}
          where id = ${mapping.player_id}
        `;
        return { body: { ok: true } };
      },
    });
  }
  return { seeded: mappings.length };
};

const backfillDiscordV4 = async () => {
  const config = String(process.env.DISCORD_GUILD_ID || "").trim();
  if (!/^\d{5,30}$/.test(config)) throw new Error("Discord guild id is not configured.");
  const [{ listManageTourneyPlayers }, desired, external, store, { getTourneySql }] = await Promise.all([
    import("../src/server/tourney/playerStore.js"),
    import("../src/server/tourney/discordDesiredState.js"),
    import("../src/server/tourney/externalOperations.js"),
    import("../src/server/tourney/store.js"),
    import("../src/server/tourney/sqlClient.js"),
  ]);
  const players = (await listManageTourneyPlayers()).filter(
    (player) => player.status === "approved" && player.discordUserId
  );
  let queued = 0;
  for (const player of players) {
    const commandId = `discord-backfill:${player.id}:${player.discordUserId}`;
    await store.executeTourneyCommand({
      commandId,
      purpose: "discord:backfill",
      requestPayload: { playerId: player.id, discordUserId: player.discordUserId },
      attemptExternalWork: false,
      callback: async () => {
        const assignment = await desired.recordTourneyDiscordDesiredState({
          player,
          discordUser: { id: player.discordUserId },
          guildId: config,
        });
        await external.enqueueTourneyExternalOperation({
          commandId,
          operationKind: "discord_role_reconcile",
          entityType: "player",
          entityId: player.id,
          desiredState: { assignment: {
            principalId: assignment.principal_id,
            discordUserId: assignment.discord_user_id,
            previousDiscordUserId: assignment.previous_discord_user_id || "",
            desiredRole: assignment.desired_role,
            generation: Number(assignment.generation),
          } },
        });
        return { body: { ok: true } };
      },
    });
    queued += 1;
  }
  const sql = await getTourneySql();
  const existingAssignments = await sql`
    select * from accounts.discord_role_assignments order by principal_id
  `;
  for (const assignment of existingAssignments) {
    const commandId = `discord-state-seed:${assignment.principal_id}:g${assignment.generation}`;
    await store.executeTourneyCommand({
      commandId,
      purpose: "discord:state-seed",
      requestPayload: {
        principalId: assignment.principal_id,
        generation: Number(assignment.generation),
      },
      attemptExternalWork: false,
      callback: async () => {
        const transactionSql = await getTourneySql();
        await transactionSql`
          update accounts.discord_role_assignments
          set updated_at = updated_at
          where principal_id = ${assignment.principal_id}
        `;
        if (!assignment.player_id) {
          await external.enqueueTourneyExternalOperation({
            commandId,
            operationKind: "discord_role_reconcile",
            entityType: "account",
            entityId: assignment.principal_id,
            desiredState: {
              assignment: {
                principalId: assignment.principal_id,
                discordUserId: assignment.discord_user_id,
                previousDiscordUserId: assignment.previous_discord_user_id || "",
                desiredRole: assignment.desired_role,
                generation: Number(assignment.generation),
              },
            },
          });
        }
        return { body: { ok: true } };
      },
    });
  }
  return {
    dryRun: false,
    queued,
    stateRowsSeeded: existingAssignments.length,
    contactedDiscord: false,
  };
};

const bootstrapFallbackV4 = async () => {
  const hosted = await createSupabaseAdminClient().rpc(
    "roo_enqueue_tourney_fallback_bootstrap",
    { p_actor: "schema-v4-activation" }
  );
  if (hosted.error) {
    const error = new Error("Tourney fallback bootstrap enqueue failed.");
    error.code = hosted.error.code || "TOURNEY_FALLBACK_BOOTSTRAP_FAILED";
    throw error;
  }
  return { enqueued: true, ...(hosted.data || {}) };
};

let result;
if (hasFlag("--snapshot")) result = await captureSnapshot();
else if (hasFlag("--apply-legacy-schema")) result = await applyLegacySchema();
else if (hasFlag("--expand-legacy-v4")) result = await applyLegacyV4Phase("expand");
else if (hasFlag("--activate-legacy-v4")) result = await applyLegacyV4Phase("activate");
else if (hasFlag("--seed-account-snapshot-v4")) result = await seedAccountSnapshotV4();
else if (hasFlag("--seed-player-principals-v4")) result = await seedPlayerPrincipalsV4();
else if (hasFlag("--backfill-discord-v4")) result = await backfillDiscordV4();
else if (hasFlag("--bootstrap-fallback-v4")) result = await bootstrapFallbackV4();
else if (hasFlag("--check-manual-failover-v4")) {
  const { checkTourneyManualFailoverReadiness } =
    await import("../src/server/tourney/store.js");
  result = await checkTourneyManualFailoverReadiness();
  if (!result.ready) {
    const error = new Error("Manual Tourney failover readiness failed.");
    error.code = "TOURNEY_MANUAL_FAILOVER_BLOCKED";
    error.blockers = result.blockers;
    throw error;
  }
}
else if (hasFlag("--migrate")) result = await migrateTourneyShadow();
else if (hasFlag("--parity")) result = await runTourneyParity();
else throw new Error(
  "Use --snapshot, --apply-legacy-schema, --expand-legacy-v4, " +
  "--activate-legacy-v4, --seed-account-snapshot-v4, --seed-player-principals-v4, " +
  "--backfill-discord-v4, --bootstrap-fallback-v4, --check-manual-failover-v4, " +
  "--migrate, or --parity."
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient as createSanityClient } from "@sanity/client";
import dotenv from "dotenv";
import {
  buildPostgresConnectionEnv,
  buildPostgresSessionArgs,
} from "./lib/postgres-connection-env.mjs";
import {
  expectedConnectedDatabaseUsername,
  loadSupabaseDatabaseTargetFromStdin,
} from "./lib/supabase-database-target-stdin.mjs";
import { createSupabaseAdminClient } from "../src/server/supabase/adminClient.js";
import migrationTargetSafety from "../src/server/supabase/migrationTargetSafety.cjs";
import { migrateTourneyShadow } from "../src/server/supabase/tourneyMigration.js";
import { TOURNEY_MIRROR_CONTRACT } from "../src/server/tourney/mirrorContract.js";
import { runTourneyParity } from "../src/server/tourney/store.js";

const execFileAsync = promisify(execFile);
const {
  assertTourneyCutoverDiscordTarget,
  assertTourneyCutoverLegacyTarget,
  assertTourneyCutoverSanityTarget,
  assertTourneyCutoverSupabaseApiTarget,
  assertTourneyCutoverSupabaseDatabaseTarget,
  computeTourneyCutoverDiscordTargetFingerprint,
  computeTourneyCutoverLegacyTargetFingerprint,
  computeTourneyCutoverSanityTargetFingerprint,
  computeTourneyCutoverSupabaseApiTargetFingerprint,
  computeTourneyCutoverSupabaseDatabaseTargetFingerprint,
} = migrationTargetSafety;
const snapshotDirectory = path.join(
  os.homedir(),
  "Documents",
  "Codex",
  "Tourney Cutover"
);
const isolatedEnvironmentPrefixes = [
  "DISCORD_",
  "NEXT_PUBLIC_SANITY_",
  "NEXT_PUBLIC_SUPABASE_",
  "POSTGRES_",
  "RESEND_",
  "SANITY_",
  "SUPABASE_",
  "TOURNEY_",
];

const hasFlag = (flag) => process.argv.includes(flag);
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  const value = String(process.argv[index + 1] || "").trim();
  if (!value || value.startsWith("--")) {
    const error = new Error(`A value is required after ${flag}.`);
    error.code = "TOURNEY_CLI_ARGUMENT_INVALID";
    throw error;
  }
  return value;
};

const loadEnvironment = () => {
  if (!hasFlag("--env")) {
    if (fs.existsSync(".env.local")) {
      dotenv.config({ path: ".env.local", quiet: true });
    }
    return;
  }
  const envPath = path.resolve(valueAfter("--env"));
  let stats;
  try {
    stats = fs.statSync(envPath);
  } catch {
    stats = null;
  }
  if (!stats?.isFile() || (stats.mode & 0o077) !== 0) {
    const error = new Error("The explicit environment file is missing, invalid, or not private.");
    error.code = "TOURNEY_ENV_FILE_INVALID";
    throw error;
  }
  for (const key of Object.keys(process.env)) {
    if (
      isolatedEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)) ||
      ["DATABASE_URL", "FROM_EMAIL"].includes(key)
    ) {
      delete process.env[key];
    }
  }
  const loaded = dotenv.config({ path: envPath, override: true, quiet: true });
  if (loaded.error) throw loaded.error;
};

const normalize = (value) => String(value || "").trim();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalizeJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])])
  );
};
const stableJson = (value) => JSON.stringify(canonicalizeJson(value));
const isEnabled = (value) => ["1", "true", "yes", "on"].includes(
  normalize(value).toLowerCase()
);
const assertStagedActivationEnvironment = () => {
  if (
    normalize(process.env.TOURNEY_DATABASE_MODE).toLowerCase() !== "supabase" ||
    !isEnabled(process.env.TOURNEY_MIRROR_ENABLED) ||
    !isEnabled(process.env.TOURNEY_WRITES_PAUSED) ||
    normalize(process.env.TOURNEY_FAILOVER_GENERATION) !== "1" ||
    !isEnabled(process.env.TOURNEY_V4_ACTIVATION_ENABLED) ||
    isEnabled(process.env.TOURNEY_HARDENING_V4_ENABLED)
  ) {
    const error = new Error("The staged Tourney schema-v4 activation environment is not loaded.");
    error.code = "TOURNEY_ACTIVATION_ENVIRONMENT_MISMATCH";
    throw error;
  }
};
const assertSnapshotEnvironment = (env = process.env) => {
  const hardenedActive = isEnabled(env.TOURNEY_HARDENING_V4_ENABLED);
  const stagedActivation = isEnabled(env.TOURNEY_V4_ACTIVATION_ENABLED) && !hardenedActive;
  if (
    normalize(env.TOURNEY_DATABASE_MODE).toLowerCase() !== "supabase" ||
    !isEnabled(env.TOURNEY_MIRROR_ENABLED) ||
    !isEnabled(env.TOURNEY_WRITES_PAUSED) ||
    normalize(env.TOURNEY_FAILOVER_GENERATION) !== "1" ||
    (!stagedActivation && !hardenedActive)
  ) {
    const error = new Error("The Tourney snapshot environment is not safely paused.");
    error.code = "TOURNEY_SNAPSHOT_ENVIRONMENT_MISMATCH";
    throw error;
  }
};
const assertHostedExecutionEnvironment = () => {
  const databaseMode = normalize(process.env.TOURNEY_DATABASE_MODE).toLowerCase();
  if (
    normalize(process.env.NODE_ENV).toLowerCase() === "test" ||
    !["legacy", "supabase"].includes(databaseMode) ||
    normalize(process.env.TOURNEY_ACCOUNT_STORE_MODE).toLowerCase() === "memory"
  ) {
    const error = new Error("The hosted Tourney cutover environment is invalid.");
    error.code = "TOURNEY_HOSTED_EXECUTION_ENVIRONMENT_INVALID";
    throw error;
  }
};
const legacyDatabaseUrl = () => {
  const databaseUrl = normalize(process.env.TOURNEY_DATABASE_URL);
  return databaseUrl;
};
const runPsql = async (databaseUrl, args, options = {}) => {
  const env = buildPostgresConnectionEnv(databaseUrl);
  try {
    return await execFileAsync("psql", buildPostgresSessionArgs(args), {
      env,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
      timeout: options.timeout || 150000,
      killSignal: "SIGTERM",
    });
  } catch (cause) {
    if (cause?.killed || cause?.signal === "SIGTERM") {
      const error = new Error("Legacy PostgreSQL command timed out.");
      error.code = "TOURNEY_LEGACY_DATABASE_COMMAND_TIMEOUT";
      throw error;
    }
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
const assertLegacyConnectionTarget = async () => {
  const databaseUrl = legacyDatabaseUrl();
  if (!databaseUrl) throw new Error("Legacy Tourney database is not configured.");
  const identity = assertTourneyCutoverLegacyTarget({
    databaseUrl,
    expectedFingerprint: process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT,
  });
  const { stdout } = await runPsql(databaseUrl, [
    "-X",
    "-Atq",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "select pg_catalog.jsonb_build_object('database',pg_catalog.current_database(),'username',current_user)::text",
  ]);
  let connected;
  try {
    connected = JSON.parse(stdout.trim());
  } catch {
    connected = null;
  }
  if (
    connected?.database !== identity.database ||
    connected?.username !== identity.username
  ) {
    const error = new Error("The legacy PostgreSQL connection identity is invalid.");
    error.code = "TOURNEY_LEGACY_CONNECTION_IDENTITY_INVALID";
    throw error;
  }
  return identity.fingerprint;
};
const assertSupabaseConnectionTarget = async () => {
  const supabaseUrl = normalize(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  const identity = assertTourneyCutoverSupabaseApiTarget({
    supabaseUrl,
    expectedFingerprint: process.env.TOURNEY_CUTOVER_EXPECTED_SUPABASE_API_FINGERPRINT,
  });
  const readiness = await createSupabaseAdminClient().rpc("roo_tourney_readiness");
  if (readiness.error || !readiness.data?.control) {
    const error = new Error("The Supabase Tourney connection identity is invalid.");
    error.code = "TOURNEY_SUPABASE_CONNECTION_IDENTITY_INVALID";
    throw error;
  }
  return identity.fingerprint;
};
const supabaseApiUrl = () => normalize(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
);
const assertSupabaseDatabaseConnectionTarget = async () => {
  const databaseUrl = normalize(process.env.SUPABASE_DATABASE_URL);
  const identity = assertTourneyCutoverSupabaseDatabaseTarget({
    databaseUrl,
    supabaseUrl: supabaseApiUrl(),
    expectedFingerprint:
      process.env.TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT,
  });
  const { stdout } = await runPsql(databaseUrl, [
    "-Atq",
    "-c",
    "select pg_catalog.jsonb_build_object('database',pg_catalog.current_database(),'username',current_user)::text",
  ]);
  let connected;
  try {
    connected = JSON.parse(stdout.trim());
  } catch {
    connected = null;
  }
  if (
    connected?.database !== identity.database ||
    connected?.username !== expectedConnectedDatabaseUsername(identity)
  ) {
    const error = new Error("The Supabase PostgreSQL connection identity is invalid.");
    error.code = "TOURNEY_SUPABASE_DATABASE_CONNECTION_IDENTITY_INVALID";
    throw error;
  }
  return identity.fingerprint;
};
const sanitySnapshotTarget = () => ({
  projectId: normalize(
    process.env.SANITY_PRIVATE_PROJECT_ID || process.env.SANITY_PROJECT_ID
  ),
  dataset: normalize(
    process.env.SANITY_PRIVATE_DATASET || process.env.SANITY_DATASET
  ) || "production",
});
const assertSanityConnectionTarget = () => {
  const identity = assertTourneyCutoverSanityTarget({
    ...sanitySnapshotTarget(),
    expectedFingerprint: process.env.TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT,
  });
  return identity.fingerprint;
};
const discordTarget = () => ({
  apiBaseUrl: normalize(process.env.DISCORD_API_BASE_URL) || "https://discord.com/api/v10",
  guildId: process.env.DISCORD_GUILD_ID,
  participantRoleId: process.env.DISCORD_PARTICIPANT_ROLE_ID,
  hostRoleId: process.env.DISCORD_HOST_ROLE_ID,
});
const assertDiscordConnectionTarget = () => {
  const identity = assertTourneyCutoverDiscordTarget({
    ...discordTarget(),
    expectedFingerprint: process.env.TOURNEY_CUTOVER_EXPECTED_DISCORD_FINGERPRINT,
  });
  return identity.fingerprint;
};

const printTargetFingerprints = () => {
  const result = {
    TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT:
      computeTourneyCutoverLegacyTargetFingerprint(legacyDatabaseUrl()),
    TOURNEY_CUTOVER_EXPECTED_SUPABASE_API_FINGERPRINT:
      computeTourneyCutoverSupabaseApiTargetFingerprint(supabaseApiUrl()),
    TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT:
      computeTourneyCutoverSanityTargetFingerprint(sanitySnapshotTarget()),
  };
  if (normalize(process.env.SUPABASE_DATABASE_URL)) {
    result.TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT =
      computeTourneyCutoverSupabaseDatabaseTargetFingerprint({
        databaseUrl: process.env.SUPABASE_DATABASE_URL,
        supabaseUrl: supabaseApiUrl(),
      });
  }
  if (normalize(process.env.DISCORD_GUILD_ID)) {
    result.TOURNEY_CUTOVER_EXPECTED_DISCORD_FINGERPRINT =
      computeTourneyCutoverDiscordTargetFingerprint(discordTarget());
  }
  return result;
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
  "tourney_schema_metadata",
  "tourney_mirror_contracts",
  "tourney_cutover_gate_events",
  "tourney_import_quarantine",
  "tourney_shadow_observations",
  "tourney_shadow_latency_baselines",
];
const readLegacySnapshot = async (databaseUrl) => {
  const tableArray = LEGACY_TABLES.map((table) => `'${table}'`).join(",");
  const { stdout: missingOutput } = await runPsql(databaseUrl, [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atq",
    "-c",
    `select coalesce(jsonb_agg(name order by name), '[]'::jsonb)::text
     from unnest(array[${tableArray}]::text[]) name
     where to_regclass(name) is null`,
  ]);
  const missingTables = JSON.parse(missingOutput.trim());
  if (missingTables.length > 0) {
    const error = new Error(
      `Legacy Tourney snapshot is incomplete; missing schema-v4 tables: ${missingTables.join(", ")}.`
    );
    error.code = "TOURNEY_LEGACY_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  const snapshotPairs = LEGACY_TABLES.flatMap((table) => [
    `'${table}'`,
    `coalesce((select jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text) from "${table}" source_row), '[]'::jsonb)`,
  ]).join(",\n");
  const query = `
    begin isolation level repeatable read read only;
    select jsonb_build_object(${snapshotPairs})::text;
    commit;
  `;
  const { stdout } = await runPsql(
    databaseUrl,
    ["-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", query],
    { maxBuffer: 100 * 1024 * 1024 }
  );
  const payloadText = stdout.trim();
  return { data: JSON.parse(payloadText), payloadText };
};

const applyLegacySqlFile = async ({ databaseUrl, fileUrl }) => {
  await runPsql(
    databaseUrl,
    [
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
  const { projectId, dataset } = sanitySnapshotTarget();
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
  const plaintext = Buffer.from(stableJson(snapshot));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: 2,
    algorithm: "aes-256-gcm+scrypt",
    plaintextSha256: sha256(plaintext),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
};

const decryptSnapshot = ({ encrypted, secret }) => {
  const envelope = JSON.parse(Buffer.from(encrypted).toString("utf8"));
  if (
    envelope?.version !== 2 ||
    envelope?.algorithm !== "aes-256-gcm+scrypt" ||
    !/^[0-9a-f]{64}$/.test(String(envelope?.plaintextSha256 || ""))
  ) {
    const error = new Error("Tourney snapshot envelope is unsupported or incomplete.");
    error.code = "TOURNEY_SNAPSHOT_ENVELOPE_INVALID";
    throw error;
  }
  const key = crypto.scryptSync(secret, Buffer.from(envelope.salt, "base64"), 32);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (sha256(plaintext) !== envelope.plaintextSha256) {
    const error = new Error("Tourney snapshot plaintext hash verification failed.");
    error.code = "TOURNEY_SNAPSHOT_HASH_MISMATCH";
    throw error;
  }
  return JSON.parse(plaintext.toString("utf8"));
};

const HOSTED_SNAPSHOT_RELATIONS = [
  ...Object.keys(TOURNEY_MIRROR_CONTRACT),
  "accounts.tourney_accounts",
  "accounts.principals",
  "accounts.login_aliases",
  "accounts.identity_links",
  "accounts.principal_auth_users",
  "auth.users",
  "auth.identities",
  "tourney.mirror_outbox",
  "tourney.mirror_checkpoints",
  "tourney.mirror_tombstones",
  "tourney.schema_metadata",
  "tourney.tourney_player_auth_operations",
  "tourney.external_operation_secrets",
  "tourney.mirror_contracts",
  "tourney.parity_runs",
  "tourney.cutover_metadata",
  "tourney.identity_conflicts",
  "tourney.shadow_observations",
  "tourney.shadow_latency_baselines",
  "tourney.cutover_gate_events",
  "migration.tourney_sync_runs",
  "migration.tourney_import_quarantine",
  "migration.tourney_import_preflights",
  "accounts.oauth_intents",
];

const validateHostedSnapshot = ({ data, legacyData, sanityAccount }) => {
  const payloadText = typeof data?.payload_text === "string" ? data.payload_text : "";
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payloadText);
  } catch {
    parsedPayload = null;
  }
  const validMetadata =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(data?.snapshot_id || "")
    ) &&
    /^[0-9a-f]{64}$/.test(String(data?.payload_sha256 || "")) &&
    data?.hosted_roundtrip_verified === true &&
    data?.table_counts && typeof data.table_counts === "object" &&
    parsedPayload && sha256(payloadText) === data.payload_sha256 &&
    (data?.payload === undefined || (
      data.payload && typeof data.payload === "object" &&
      stableJson(parsedPayload) === stableJson(data.payload)
    ));
  if (!validMetadata) {
    const error = new Error("Supabase Tourney snapshot proof is missing or invalid.");
    error.code = "TOURNEY_HOSTED_SNAPSHOT_PROOF_INVALID";
    throw error;
  }
  const missingRelations = HOSTED_SNAPSHOT_RELATIONS.filter(
    (relation) => !Array.isArray(parsedPayload[relation])
  );
  const wrongCounts = HOSTED_SNAPSHOT_RELATIONS.filter(
    (relation) => Number(data.table_counts[relation]) !== parsedPayload[relation]?.length
  );
  if (
    missingRelations.length > 0 ||
    wrongCounts.length > 0 ||
    stableJson(parsedPayload.legacy) !== stableJson(legacyData) ||
    stableJson(parsedPayload.sanity_account) !== stableJson(sanityAccount)
  ) {
    const error = new Error("Supabase Tourney snapshot payload is incomplete or inconsistent.");
    error.code = "TOURNEY_HOSTED_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  return { payload: parsedPayload, payloadTextSha256: sha256(payloadText) };
};

const captureHostedSnapshot = async ({ legacyPayloadText, sanityAccount }) => {
  const databaseUrl = normalize(process.env.SUPABASE_DATABASE_URL);
  if (!databaseUrl) {
    const error = new Error("The Supabase snapshot database connection is not configured.");
    error.code = "TOURNEY_SUPABASE_DATABASE_CONNECTION_REQUIRED";
    throw error;
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
    connection: {
      application_name: "roo-industries-tourney-snapshot",
      statement_timeout: 120000,
      lock_timeout: 5000,
    },
  });
  let data;
  try {
    const [row] = await sql`
      select public.roo_capture_tourney_hardening_snapshot(
        null::jsonb,
        ${sql.json(sanityAccount)}::jsonb,
        ${legacyPayloadText}::text
      ) data
    `;
    data = row?.data;
  } catch (cause) {
    const error = new Error(
      "Supabase Tourney hardening snapshot failed; no incomplete fallback is permitted."
    );
    error.code = cause?.code || "TOURNEY_SNAPSHOT_FAILED";
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return {
    data,
    functionName: "public.roo_capture_tourney_hardening_snapshot",
  };
};

const isInsideDirectory = (candidate, directory) =>
  candidate === directory || candidate.startsWith(`${directory}${path.sep}`);

const resolveSnapshotRoot = (allowedRoot, { create = false } = {}) => {
  const configuredRoot = path.resolve(allowedRoot);
  let stats;
  try {
    stats = fs.lstatSync(configuredRoot);
  } catch {
    stats = null;
  }
  if (!stats && create) {
    const parent = fs.realpathSync(path.dirname(configuredRoot));
    fs.mkdirSync(path.join(parent, path.basename(configuredRoot)), { mode: 0o700 });
    stats = fs.lstatSync(configuredRoot);
  }
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The approved Tourney snapshot directory is invalid.");
  }
  return { configuredRoot, realRoot: fs.realpathSync(configuredRoot) };
};

const reserveSnapshotOutput = (capturedAt, { allowedRoot = snapshotDirectory } = {}) => {
  const requestedOutput = valueAfter("--output");
  if (requestedOutput && !path.isAbsolute(requestedOutput)) {
    throw new Error("--output <path> must be absolute.");
  }
  const timestamp = capturedAt.replace(/[-:.]/g, "");
  const { configuredRoot, realRoot } = resolveSnapshotRoot(allowedRoot, { create: true });
  const output = path.resolve(requestedOutput || path.join(
    configuredRoot,
    `pre-cutover-${timestamp}.enc`
  ));
  if (path.dirname(output) !== configuredRoot) {
    throw new Error("The Tourney snapshot must be stored in the approved snapshot directory.");
  }
  const canonicalOutput = path.join(realRoot, path.basename(output));
  return { output: canonicalOutput, descriptor: fs.openSync(canonicalOutput, "wx", 0o600) };
};

const resolveSnapshotInput = ({ allowedRoot = snapshotDirectory } = {}) => {
  const value = valueAfter("--verify-snapshot");
  if (!path.isAbsolute(value)) {
    throw new Error("--verify-snapshot <path> must be absolute.");
  }
  let input;
  let stats;
  try {
    input = fs.realpathSync(value);
    stats = fs.statSync(input);
  } catch {
    input = "";
    stats = null;
  }
  let root;
  try {
    root = resolveSnapshotRoot(allowedRoot);
  } catch {
    root = null;
  }
  if (!input || !stats?.isFile() || !root || !isInsideDirectory(input, root.realRoot)) {
    throw new Error("The Tourney snapshot input is invalid.");
  }
  return input;
};

const captureSnapshot = async () => {
  const legacyUrl = legacyDatabaseUrl();
  const encryptionSecret = normalize(process.env.TOURNEY_SNAPSHOT_KEY);
  if (!legacyUrl || Buffer.byteLength(encryptionSecret) < 32) {
    throw new Error(
      "TOURNEY_DATABASE_URL and a TOURNEY_SNAPSHOT_KEY of at least 32 bytes are required."
    );
  }
  const capturedAt = new Date().toISOString();
  const reservation = reserveSnapshotOutput(capturedAt);
  let completed = false;
  try {
    const [legacyCapture, sanityAccount] = await Promise.all([
      readLegacySnapshot(legacyUrl),
      readSanityAccountDocument(),
    ]);
    const legacyData = legacyCapture.data;
    if (
      !sanityAccount ||
      typeof sanityAccount !== "object" ||
      sanityAccount._id !== "tourneyAuthStore"
    ) {
      const error = new Error("Sanity Tourney account snapshot is missing.");
      error.code = "TOURNEY_SANITY_SNAPSHOT_MISSING";
      throw error;
    }
    assertSnapshotEnvironment();
    const hosted = await captureHostedSnapshot({
      legacyPayloadText: legacyCapture.payloadText,
      sanityAccount,
    });
    const hostedProof = validateHostedSnapshot({
      data: hosted.data,
      legacyData,
      sanityAccount,
    });
    const snapshot = {
      version: 2,
      capturedAt,
      legacy: legacyData,
      legacyPayloadText: legacyCapture.payloadText,
      legacyPayloadSha256: sha256(legacyCapture.payloadText),
      supabase: {
        hostedEncryptedSnapshot: true,
        captureFunction: hosted.functionName,
        snapshotId: hosted.data?.snapshot_id || "",
        payloadSha256: hosted.data?.payload_sha256 || "",
        tableCounts: hosted.data?.table_counts || {},
        payload: hostedProof.payload,
        payloadText: hosted.data?.payload_text || "",
        payloadTextSha256Verified: hostedProof.payloadTextSha256,
        hostedRoundtripVerified: true,
      },
      sanityAccount,
    };
    const encrypted = encryptSnapshot({ snapshot, secret: encryptionSecret });
    const decrypted = decryptSnapshot({ encrypted, secret: encryptionSecret });
    if (stableJson(decrypted) !== stableJson(snapshot)) {
      throw new Error("Local Tourney snapshot decrypt verification failed.");
    }
    fs.writeFileSync(reservation.descriptor, encrypted);
    fs.fsyncSync(reservation.descriptor);
    completed = true;
    return {
      output: reservation.output,
      sha256: crypto.createHash("sha256").update(encrypted).digest("hex"),
      legacyCounts: Object.fromEntries(
        Object.entries(legacyData).map(([table, rows]) => [table, rows.length])
      ),
      supabaseSnapshot: "hosted-encrypted",
      sanityAccountCaptured: Boolean(sanityAccount),
      localDecryptVerified: true,
      hostedPayloadHashVerified: true,
    };
  } finally {
    fs.closeSync(reservation.descriptor);
    if (!completed) {
      try {
        fs.unlinkSync(reservation.output);
      } catch {}
    }
  }
};

const verifySnapshot = async () => {
  const input = resolveSnapshotInput();
  const secret = normalize(process.env.TOURNEY_SNAPSHOT_KEY);
  if (Buffer.byteLength(secret) < 32) {
    throw new Error(
      "--verify-snapshot <path> and a TOURNEY_SNAPSHOT_KEY of at least 32 bytes are required."
    );
  }
  const encrypted = fs.readFileSync(input);
  const snapshot = decryptSnapshot({ encrypted, secret });
  validateHostedSnapshot({
    data: {
      snapshot_id: snapshot?.supabase?.snapshotId,
      payload_sha256: snapshot?.supabase?.payloadSha256,
      table_counts: snapshot?.supabase?.tableCounts,
      payload: snapshot?.supabase?.payload,
      payload_text: snapshot?.supabase?.payloadText,
      hosted_roundtrip_verified: snapshot?.supabase?.hostedRoundtripVerified,
    },
    legacyData: snapshot?.legacy,
    sanityAccount: snapshot?.sanityAccount,
  });
  if (
    snapshot?.version !== 2 ||
    snapshot?.supabase?.hostedRoundtripVerified !== true ||
    snapshot?.supabase?.payloadTextSha256Verified !== snapshot?.supabase?.payloadSha256 ||
    sha256(String(snapshot?.legacyPayloadText || "")) !== snapshot?.legacyPayloadSha256 ||
    stableJson(JSON.parse(snapshot?.legacyPayloadText || "null")) !== stableJson(snapshot?.legacy) ||
    stableJson(snapshot?.supabase?.payload?.legacy) !== stableJson(snapshot?.legacy) ||
    stableJson(snapshot?.supabase?.payload?.sanity_account) !== stableJson(snapshot?.sanityAccount)
  ) {
    const error = new Error("Tourney snapshot contents failed verification.");
    error.code = "TOURNEY_SNAPSHOT_CONTENT_INVALID";
    throw error;
  }
  return {
    input: path.resolve(input),
    encryptedSha256: sha256(encrypted),
    capturedAt: snapshot.capturedAt,
    supabaseSnapshotId: snapshot.supabase.snapshotId,
    supabasePayloadSha256: snapshot.supabase.payloadSha256,
    legacyCounts: Object.fromEntries(
      Object.entries(snapshot.legacy).map(([table, rows]) => [table, rows.length])
    ),
    sanityAccountCaptured: true,
    localDecryptVerified: true,
    hostedPayloadHashVerified: true,
  };
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

const assertSupabaseLegacyActivationControls = async ({
  requireHardened = false,
  requireMirrorBindings = false,
} = {}) => {
  const readiness = await createSupabaseAdminClient().rpc("roo_tourney_readiness");
  if (readiness.error) {
    const failure = new Error("Supabase Tourney activation preflight failed.");
    failure.code = readiness.error.code || "TOURNEY_SUPABASE_ACTIVATION_PREFLIGHT_FAILED";
    throw failure;
  }
  const data = readiness.data?.control;
  if (
    data?.primary_backend !== "supabase" ||
    Number(data?.generation) !== 1 ||
    data?.writes_paused !== true ||
    data?.fallback_read_only === true ||
    (requireHardened && data?.hardened_active !== true) ||
    (requireMirrorBindings && readiness.data?.mirror_trigger_bindings?.ready !== true)
  ) {
    const failure = new Error(
      "Supabase Tourney controls are not safe for legacy schema-v4 activation."
    );
    failure.code = "TOURNEY_SUPABASE_ACTIVATION_PREFLIGHT_FAILED";
    throw failure;
  }
};

const applyLegacyV4Phase = async (phase) => {
  const databaseUrl = legacyDatabaseUrl();
  if (!databaseUrl) throw new Error("Legacy Tourney database is not configured.");
  const fileName = {
    activate: "tourney-schema-v4-activate-legacy.sql",
    expand: "tourney-schema-v4-expand-legacy.sql",
    repair: "tourney-schema-v4-repair-legacy.sql",
    triggerBindings: "tourney-schema-v4-trigger-binding-repair-legacy.sql",
  }[phase];
  if (!fileName) throw new Error("Unsupported legacy schema-v4 phase.");
  if (phase === "activate") {
    assertStagedActivationEnvironment();
    await assertSupabaseLegacyActivationControls();
  }
  if (phase === "triggerBindings") {
    assertStagedActivationEnvironment();
    await assertSupabaseLegacyActivationControls({
      requireHardened: true,
      requireMirrorBindings: true,
    });
  }
  await applyLegacySqlFile({
    databaseUrl,
    fileUrl: new URL(`./${fileName}`, import.meta.url),
  });
  const { stdout } = await runPsql(databaseUrl, [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atq",
    "-c",
    `select jsonb_build_object(
      'schemaVersion',schema_version,
      'expandedVersion',expanded_version,
      'hardenedActive',coalesce((
        select hardened_active from tourney_cutover_metadata where id='tourney'
      ),false)
    )::text from tourney_schema_metadata where schema_name='tourney'`,
  ]);
  const metadata = JSON.parse(stdout.trim());
  if (phase === "triggerBindings") {
    const { stdout: bindingStdout } = await runPsql(databaseUrl, [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atq",
      "-c",
      "select public.tourney_mirror_trigger_binding_status_v4()::text",
    ]);
    const mirrorTriggerBindings = JSON.parse(bindingStdout.trim());
    if (mirrorTriggerBindings?.ready !== true) {
      const error = new Error("Legacy Tourney mirror trigger repair did not verify.");
      error.code = "TOURNEY_LEGACY_TRIGGER_BINDING_REPAIR_FAILED";
      throw error;
    }
    return { applied: true, phase, ...metadata, mirrorTriggerBindings };
  }
  return { applied: true, phase, ...metadata };
};

const activationV4 = () => import("../src/server/tourney/activation.js");
const activateSupabaseSchemaV4 = async () =>
  (await activationV4()).activateTourneySchemaV4();
const inventoryActivationV4 = async () =>
  (await activationV4()).inventoryTourneyV4Activation();
const captureLatencyBaselineV4 = async () =>
  (await activationV4()).captureTourneyLatencyBaselineV4();
const applyActivationV4 = async () =>
  (await activationV4()).applyTourneyV4Activation({
    inventoryHash: valueAfter("--inventory-hash"),
  });

const buildFallbackSnapshot = (legacyData) => Object.fromEntries(
  Object.entries(TOURNEY_MIRROR_CONTRACT).map(([logicalTable, contract]) => [
    logicalTable,
    legacyData[contract.relations.legacy],
  ])
);

const assertLegacyFallbackControls = (legacyData) => {
  const control = legacyData.tourney_cutover_metadata?.find((row) => row.id === "tourney");
  const schema = legacyData.tourney_schema_metadata?.find(
    (row) => row.schema_name === "tourney"
  );
  if (
    control?.primary_backend !== "supabase" ||
    Number(control?.generation) !== 1 ||
    control?.writes_paused !== true ||
    control?.fallback_read_only === true ||
    control?.hardened_active !== true ||
    Number(schema?.schema_version || 0) < 4
  ) {
    const error = new Error("Legacy Tourney fallback controls are not safe for bootstrap.");
    error.code = "TOURNEY_FALLBACK_BOOTSTRAP_PREFLIGHT_FAILED";
    throw error;
  }
};

const inventoryFallbackV4 = async () => {
  const databaseUrl = legacyDatabaseUrl();
  if (!databaseUrl) throw new Error("TOURNEY_DATABASE_URL is required.");
  const { data: legacyData } = await readLegacySnapshot(databaseUrl);
  assertLegacyFallbackControls(legacyData);
  assertStagedActivationEnvironment();
  await assertSupabaseLegacyActivationControls({ requireHardened: true });
  const fallbackSnapshot = buildFallbackSnapshot(legacyData);
  return {
    ready: true,
    legacySnapshotHash: sha256(stableJson(fallbackSnapshot)),
    counts: Object.fromEntries(
      Object.entries(fallbackSnapshot).map(([table, rows]) => [table, rows.length])
    ),
    contactedExternalProviders: false,
    mutated: false,
  };
};

const bootstrapFallbackV4 = async () => {
  const databaseUrl = legacyDatabaseUrl();
  if (!databaseUrl) throw new Error("TOURNEY_DATABASE_URL is required.");
  const { data: legacyData } = await readLegacySnapshot(databaseUrl);
  assertLegacyFallbackControls(legacyData);
  assertStagedActivationEnvironment();
  await assertSupabaseLegacyActivationControls({ requireHardened: true });
  const fallbackSnapshot = buildFallbackSnapshot(legacyData);
  const actualHash = sha256(stableJson(fallbackSnapshot));
  const expectedHash = valueAfter("--expected-legacy-hash");
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || expectedHash !== actualHash) {
    const error = new Error(
      "Fallback bootstrap requires the exact hash from --inventory-fallback-v4."
    );
    error.code = "TOURNEY_FALLBACK_BOOTSTRAP_HASH_MISMATCH";
    throw error;
  }
  const hosted = await createSupabaseAdminClient().rpc(
    "roo_enqueue_tourney_fallback_bootstrap",
    {
      p_actor: "schema-v4-activation",
      p_fallback_snapshot: fallbackSnapshot,
    }
  );
  if (hosted.error) {
    const error = new Error("Tourney fallback bootstrap enqueue failed.");
    error.code = hosted.error.code || "TOURNEY_FALLBACK_BOOTSTRAP_FAILED";
    throw error;
  }
  return { enqueued: true, legacySnapshotHash: actualHash, ...(hosted.data || {}) };
};

const checkManualFailoverV4 = async () => {
  const { checkTourneyManualFailoverReadiness } =
    await import("../src/server/tourney/store.js");
  const result = await checkTourneyManualFailoverReadiness();
  if (!result.ready) {
    const error = new Error("Manual Tourney failover readiness failed.");
    error.code = "TOURNEY_MANUAL_FAILOVER_BLOCKED";
    error.blockers = result.blockers;
    throw error;
  }
  return result;
};

const actions = [
  { flag: "--print-target-fingerprints", requiresEnvironment: true, touchesLegacy: false, touchesSupabase: false, execute: printTargetFingerprints },
  { flag: "--snapshot", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, touchesSanity: true, options: ["--output", "--supabase-database-url-stdin"], execute: captureSnapshot },
  { flag: "--verify-snapshot", touchesLegacy: false, touchesSupabase: false, execute: verifySnapshot },
  { flag: "--apply-legacy-schema", touchesLegacy: true, touchesSupabase: false, execute: applyLegacySchema },
  { flag: "--expand-legacy-v4", touchesLegacy: true, touchesSupabase: false, execute: () => applyLegacyV4Phase("expand") },
  { flag: "--activate-legacy-v4", touchesLegacy: true, touchesSupabase: true, execute: () => applyLegacyV4Phase("activate") },
  { flag: "--activate-supabase-v4", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, execute: activateSupabaseSchemaV4 },
  { flag: "--repair-legacy-v4", touchesLegacy: true, touchesSupabase: false, execute: () => applyLegacyV4Phase("repair") },
  { flag: "--repair-legacy-trigger-bindings-v4", touchesLegacy: true, touchesSupabase: true, execute: () => applyLegacyV4Phase("triggerBindings") },
  { flag: "--inventory-activation-v4", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, touchesSanity: true, touchesDiscord: true, execute: inventoryActivationV4 },
  { flag: "--capture-latency-baseline-v4", touchesLegacy: false, touchesSupabase: true, touchesSupabaseDatabase: true, execute: captureLatencyBaselineV4 },
  { flag: "--apply-activation-v4", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, touchesSanity: true, touchesDiscord: true, options: ["--inventory-hash"], required: ["--inventory-hash"], execute: applyActivationV4 },
  { flag: "--inventory-fallback-v4", touchesLegacy: true, touchesSupabase: true, execute: inventoryFallbackV4 },
  { flag: "--bootstrap-fallback-v4", touchesLegacy: true, touchesSupabase: true, options: ["--expected-legacy-hash"], required: ["--expected-legacy-hash"], execute: bootstrapFallbackV4 },
  { flag: "--check-manual-failover-v4", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, execute: checkManualFailoverV4 },
  { flag: "--migrate", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, execute: migrateTourneyShadow },
  { flag: "--parity", touchesLegacy: true, touchesSupabase: true, touchesSupabaseDatabase: true, execute: runTourneyParity },
];
const valueFlags = new Set([
  "--env",
  "--expected-legacy-hash",
  "--inventory-hash",
  "--output",
  "--verify-snapshot",
]);
const knownFlags = new Set([
  ...actions.map((action) => action.flag),
  "--env",
  "--expected-legacy-hash",
  "--inventory-hash",
  "--output",
  "--supabase-database-url-stdin",
]);

const parseCliAction = () => {
  const counts = new Map();
  const tokens = process.argv.slice(2);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || !knownFlags.has(token)) {
      const error = new Error("The Tourney cutover command contains an invalid argument.");
      error.code = "TOURNEY_CLI_ARGUMENT_INVALID";
      throw error;
    }
    const count = (counts.get(token) || 0) + 1;
    if (count > 1) {
      const error = new Error("The Tourney cutover command contains a duplicate argument.");
      error.code = "TOURNEY_CLI_ARGUMENT_INVALID";
      throw error;
    }
    counts.set(token, count);
    if (valueFlags.has(token)) {
      const value = String(tokens[index + 1] || "").trim();
      if (!value || value.startsWith("--")) {
        const error = new Error(`A value is required after ${token}.`);
        error.code = "TOURNEY_CLI_ARGUMENT_INVALID";
        throw error;
      }
      index += 1;
    }
  }
  const selected = actions.filter((action) => counts.has(action.flag));
  if (selected.length !== 1) {
    const error = new Error("Exactly one valid Tourney cutover action is required.");
    error.code = "TOURNEY_CLI_ACTION_INVALID";
    throw error;
  }
  const allowed = new Set([selected[0].flag, "--env", ...(selected[0].options || [])]);
  if ([...counts.keys()].some((flag) => !allowed.has(flag))) {
    const error = new Error("The Tourney cutover command contains an invalid action option.");
    error.code = "TOURNEY_CLI_ARGUMENT_INVALID";
    throw error;
  }
  if ((selected[0].required || []).some((flag) => !counts.has(flag))) {
    const error = new Error("The Tourney cutover command is missing a required action option.");
    error.code = "TOURNEY_CLI_ARGUMENT_INVALID";
    throw error;
  }
  return selected[0];
};

const main = async () => {
  const selected = parseCliAction();
  const contactsHostedTarget = Boolean(
    selected.touchesLegacy || selected.touchesSupabase ||
    selected.touchesSupabaseDatabase || selected.touchesSanity ||
    selected.touchesDiscord
  );
  if (
    (
      selected.requiresEnvironment || contactsHostedTarget
    ) &&
    !hasFlag("--env")
  ) {
    const error = new Error("An explicit private --env file is required for this action.");
    error.code = "TOURNEY_ENV_FILE_REQUIRED";
    throw error;
  }
  loadEnvironment();
  if (hasFlag("--supabase-database-url-stdin")) {
    await loadSupabaseDatabaseTargetFromStdin();
  }
  if (contactsHostedTarget) assertHostedExecutionEnvironment();
  if (selected.touchesSanity) assertSanityConnectionTarget();
  if (selected.touchesDiscord) assertDiscordConnectionTarget();
  const checks = [];
  if (selected.touchesLegacy) checks.push(assertLegacyConnectionTarget());
  if (selected.touchesSupabase) checks.push(assertSupabaseConnectionTarget());
  if (selected.touchesSupabaseDatabase) {
    checks.push(assertSupabaseDatabaseConnectionTarget());
  }
  await Promise.all(checks);
  return selected.execute();
};

export {
  HOSTED_SNAPSHOT_RELATIONS,
  LEGACY_TABLES,
  assertDiscordConnectionTarget,
  assertLegacyConnectionTarget,
  assertSanityConnectionTarget,
  assertSupabaseConnectionTarget,
  assertSupabaseDatabaseConnectionTarget,
  assertHostedExecutionEnvironment,
  assertSnapshotEnvironment,
  decryptSnapshot,
  encryptSnapshot,
  loadEnvironment,
  main,
  parseCliAction,
  printTargetFingerprints,
  reserveSnapshotOutput,
  resolveSnapshotInput,
  runPsql,
  stableJson,
  validateHostedSnapshot,
  valueAfter,
};

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

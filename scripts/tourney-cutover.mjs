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
import { createSupabaseAdminClient } from "../src/server/supabase/adminClient.js";
import { migrateTourneyShadow } from "../src/server/supabase/tourneyMigration.js";
import { TOURNEY_MIRROR_CONTRACT } from "../src/server/tourney/mirrorContract.js";
import { runTourneyParity } from "../src/server/tourney/store.js";

const execFileAsync = promisify(execFile);

const loadEnvironment = () => {
  const envArgument = process.argv.indexOf("--env");
  const envPath = envArgument >= 0 ? process.argv[envArgument + 1] : ".env.local";
  if (envPath && fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: envArgument >= 0, quiet: true });
  }
};

const hasFlag = (flag) => process.argv.includes(flag);
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
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
const legacyDatabaseUrl = () => normalize(process.env.TOURNEY_DATABASE_URL);
const runPsql = async (databaseUrl, args, options = {}) => {
  try {
    return await execFileAsync("psql", args, {
      env: { ...process.env, PGCONNECT_TIMEOUT: "15", PGDATABASE: databaseUrl },
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
    data?.payload && typeof data.payload === "object" &&
    parsedPayload && sha256(payloadText) === data.payload_sha256 &&
    stableJson(parsedPayload) === stableJson(data.payload);
  if (!validMetadata) {
    const error = new Error("Supabase Tourney snapshot proof is missing or invalid.");
    error.code = "TOURNEY_HOSTED_SNAPSHOT_PROOF_INVALID";
    throw error;
  }
  const missingRelations = HOSTED_SNAPSHOT_RELATIONS.filter(
    (relation) => !Array.isArray(data.payload[relation])
  );
  const wrongCounts = HOSTED_SNAPSHOT_RELATIONS.filter(
    (relation) => Number(data.table_counts[relation]) !== data.payload[relation]?.length
  );
  if (
    missingRelations.length > 0 ||
    wrongCounts.length > 0 ||
    stableJson(data.payload.legacy) !== stableJson(legacyData) ||
    stableJson(data.payload.sanity_account) !== stableJson(sanityAccount)
  ) {
    const error = new Error("Supabase Tourney snapshot payload is incomplete or inconsistent.");
    error.code = "TOURNEY_HOSTED_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  return { payload: data.payload, payloadTextSha256: sha256(payloadText) };
};

const captureHostedSnapshot = async ({ legacyData, legacyPayloadText, sanityAccount }) => {
  const client = createSupabaseAdminClient();
  const parameters = {
    p_legacy_snapshot: legacyData,
    p_legacy_snapshot_text: legacyPayloadText,
    p_sanity_account: sanityAccount,
  };
  const hardened = await client.rpc(
    "roo_capture_tourney_hardening_snapshot",
    parameters
  );
  if (hardened.error) {
    const error = new Error(
      "Supabase Tourney hardening snapshot failed; no incomplete fallback is permitted."
    );
    error.code = hardened.error.code || "TOURNEY_SNAPSHOT_FAILED";
    throw error;
  }
  return {
    data: hardened.data,
    functionName: "public.roo_capture_tourney_hardening_snapshot",
  };
};

const captureSnapshot = async () => {
  const legacyUrl = legacyDatabaseUrl();
  const encryptionSecret = normalize(process.env.TOURNEY_SNAPSHOT_KEY);
  if (!legacyUrl || Buffer.byteLength(encryptionSecret) < 32) {
    throw new Error(
      "TOURNEY_DATABASE_URL and a TOURNEY_SNAPSHOT_KEY of at least 32 bytes are required."
    );
  }
  const [legacyCapture, sanityAccount] = await Promise.all([
      readLegacySnapshot(legacyUrl),
      readSanityAccountDocument(),
  ]);
  {
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
    assertStagedActivationEnvironment();
    const hosted = await captureHostedSnapshot({
      legacyData,
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
      capturedAt: new Date().toISOString(),
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
    const timestamp = snapshot.capturedAt.replace(/[-:.]/g, "");
    const output = valueAfter("--output") || path.join(
      process.env.HOME,
      "Documents",
      "Codex",
      "Tourney Cutover",
      `pre-cutover-${timestamp}.enc`
    );
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(output, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, encrypted);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return {
      output,
      sha256: crypto.createHash("sha256").update(encrypted).digest("hex"),
      legacyCounts: Object.fromEntries(
        Object.entries(legacyData).map(([table, rows]) => [table, rows.length])
      ),
      supabaseSnapshot: "hosted-encrypted",
      sanityAccountCaptured: Boolean(sanityAccount),
      localDecryptVerified: true,
      hostedPayloadHashVerified: true,
    };
  }
};

const verifySnapshot = async () => {
  const input = valueAfter("--verify-snapshot");
  const secret = normalize(process.env.TOURNEY_SNAPSHOT_KEY);
  if (!input || Buffer.byteLength(secret) < 32) {
    throw new Error(
      "--verify-snapshot <path> and a TOURNEY_SNAPSHOT_KEY of at least 32 bytes are required."
    );
  }
  const encrypted = fs.readFileSync(path.resolve(input));
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

const assertSupabaseLegacyActivationControls = async ({ requireHardened = false } = {}) => {
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
    (requireHardened && data?.hardened_active !== true)
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
  }[phase];
  if (!fileName) throw new Error("Unsupported legacy schema-v4 phase.");
  if (phase === "activate") {
    assertStagedActivationEnvironment();
    await assertSupabaseLegacyActivationControls();
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

const main = async () => {
  loadEnvironment();
  let result;
  if (hasFlag("--snapshot")) result = await captureSnapshot();
  else if (hasFlag("--verify-snapshot")) result = await verifySnapshot();
  else if (hasFlag("--apply-legacy-schema")) result = await applyLegacySchema();
  else if (hasFlag("--expand-legacy-v4")) result = await applyLegacyV4Phase("expand");
  else if (hasFlag("--activate-legacy-v4")) result = await applyLegacyV4Phase("activate");
  else if (hasFlag("--activate-supabase-v4")) result = await activateSupabaseSchemaV4();
  else if (hasFlag("--repair-legacy-v4")) result = await applyLegacyV4Phase("repair");
  else if (hasFlag("--inventory-activation-v4")) result = await inventoryActivationV4();
  else if (hasFlag("--capture-latency-baseline-v4")) result = await captureLatencyBaselineV4();
  else if (hasFlag("--apply-activation-v4")) result = await applyActivationV4();
  else if (hasFlag("--inventory-fallback-v4")) result = await inventoryFallbackV4();
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
    "Use --snapshot, --verify-snapshot <path>, --apply-legacy-schema, --expand-legacy-v4, " +
    "--activate-legacy-v4, --activate-supabase-v4, --repair-legacy-v4, " +
    "--inventory-activation-v4, --apply-activation-v4, " +
    "--capture-latency-baseline-v4, " +
    "--inventory-fallback-v4, --bootstrap-fallback-v4 --expected-legacy-hash <sha256>, " +
    "--migrate, or --parity."
  );
  return result;
};

export { decryptSnapshot, encryptSnapshot, stableJson };

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

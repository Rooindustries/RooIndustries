#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient as createSanityClient } from "@sanity/client";
import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";
import { migrateTourneyShadow } from "../src/server/supabase/tourneyMigration.js";
import { splitPostgresStatements } from "../src/server/tourney/sqlStatements.js";
import { runTourneyParity } from "../src/server/tourney/store.js";

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
];
const readLegacySnapshot = async (databaseUrl) => {
  const sql = neon(databaseUrl);
  const queries = LEGACY_TABLES.map((table) =>
    sql.query(`select * from ${table}`)
  );
  const results = await sql.transaction(queries, {
    isolationLevel: "RepeatableRead",
    readOnly: true,
  });
  return Object.fromEntries(
    LEGACY_TABLES.map((table, index) => [table, jsonSafe(results[index] || [])])
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

const captureSnapshot = async () => {
  const legacyUrl = normalize(process.env.TOURNEY_DATABASE_URL || process.env.POSTGRES_URL);
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
    const snapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      legacy: legacyData,
      supabase: {
        hostedEncryptedSnapshot: true,
        captureFunction: "public.roo_capture_tourney_pre_cutover_snapshot",
      },
      sanityAccount,
    };
    const encrypted = encryptSnapshot({ snapshot, secret: encryptionSecret });
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
    };
  }
};

const applyLegacySchema = async () => {
  const databaseUrl = normalize(process.env.TOURNEY_DATABASE_URL || process.env.POSTGRES_URL);
  if (!databaseUrl) throw new Error("Legacy Tourney database is not configured.");
  const sqlText = fs.readFileSync(
    new URL("./tourney-cutover-legacy.sql", import.meta.url),
    "utf8"
  );
  const sql = neon(databaseUrl);
  const statements = splitPostgresStatements(sqlText);
  await sql.transaction(statements.map((statement) => sql.query(statement)));
  return { applied: true };
};

let result;
if (hasFlag("--snapshot")) result = await captureSnapshot();
else if (hasFlag("--apply-legacy-schema")) result = await applyLegacySchema();
else if (hasFlag("--migrate")) result = await migrateTourneyShadow();
else if (hasFlag("--parity")) result = await runTourneyParity();
else throw new Error("Use --snapshot, --apply-legacy-schema, --migrate, or --parity.");

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

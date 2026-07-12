#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");
const files = fs
  .readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const failures = [];
const versions = new Set();

for (const file of files) {
  const match = file.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
  if (!match) failures.push(`Invalid migration filename: ${file}`);
  if (match && versions.has(match[1])) {
    failures.push(`Duplicate migration version: ${match[1]}`);
  }
  if (match) versions.add(match[1]);
  const sql = fs.readFileSync(path.join(migrationsDirectory, file), "utf8");
  if (!sql.trim()) failures.push(`Empty migration: ${file}`);
}

const requiredHashes = new Map([
  [
    "20260711231920_bootstrap_social_auth_identities.sql",
    "58bd19899743b3e0d3ee830bced0ab79ec26278b20561d79efa904ac779a8112",
  ],
  [
    "20260711232325_fix_social_auth_identity_timestamps.sql",
    "643db1fb0a84a44b3b8a492f268e861a78729a2ab23dc974367ba4a4ac4681dc",
  ],
]);
for (const [file, expected] of requiredHashes) {
  const location = path.join(migrationsDirectory, file);
  if (!fs.existsSync(location)) {
    failures.push(`Hosted migration is missing locally: ${file}`);
    continue;
  }
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(location))
    .digest("hex");
  if (actual !== expected) failures.push(`Hosted migration changed: ${file}`);
}

for (const stale of [
  "20260711230055_bootstrap_social_auth_identities.sql",
  "20260711232258_fix_social_auth_identity_timestamps.sql",
]) {
  if (files.includes(stale)) failures.push(`Stale migration filename remains: ${stale}`);
}

const hardeningFile = path.join(
  migrationsDirectory,
  "20260712015615_harden_commerce_integrity_and_recovery.sql"
);
if (fs.existsSync(hardeningFile)) {
  const sql = fs.readFileSync(hardeningFile, "utf8");
  const mutationStart = sql.indexOf(
    "create or replace function public.roo_apply_commerce_document_mutations"
  );
  const mutationEnd = sql.indexOf(
    "create or replace function public.roo_fetch_recovery_payment_documents",
    mutationStart
  );
  const mutationBody = sql.slice(mutationStart, mutationEnd);
  if (/roo_refresh_operational_shadow\s*\(/i.test(mutationBody)) {
    failures.push("Commerce mutation RPC still calls the full projector.");
  }
  for (const required of [
    "assert_commerce_start_fence",
    "project_commerce_document_ids",
    "roo_commerce_mirror_status_for_ids",
    "alter default privileges for role postgres\n  revoke execute on functions",
  ]) {
    if (!sql.includes(required)) failures.push(`Hardening migration lacks: ${required}`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, migrations: files.length }, null, 2));

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { fetchSupabaseDatabaseTarget } from "./lib/supabase-database-target-transport.mjs";

const repairError = (code) => Object.assign(
  new Error("The production Tourney drift repair wrapper is invalid."),
  { code }
);
const requireValue = (value, code) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.startsWith("--")) throw repairError(code);
  return normalized;
};

export const parseTransportRepairArguments = (argv = process.argv.slice(2)) => {
  const actionFlags = new Set(["--preflight", "--apply", "--finalize"]);
  const valueFlags = new Set([
    "--env",
    "--authorization-hash",
    "--verified-snapshot",
    "--snapshot-transport-url",
  ]);
  const allowed = new Set([...actionFlags, ...valueFlags]);
  const seen = new Set();
  const actions = [];
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag) || seen.has(flag)) {
      throw repairError("TOURNEY_DATABASE_TARGET_TRANSPORT_ARGUMENT_INVALID");
    }
    seen.add(flag);
    if (actionFlags.has(flag)) {
      actions.push(flag);
      continue;
    }
    values[flag] = requireValue(
      argv[index + 1],
      "TOURNEY_DATABASE_TARGET_TRANSPORT_ARGUMENT_INVALID"
    );
    index += 1;
  }
  if (actions.length !== 1) {
    throw repairError("TOURNEY_DATABASE_TARGET_TRANSPORT_ACTION_INVALID");
  }
  const action = actions[0];
  const required = ["--env", "--snapshot-transport-url"];
  if (action !== "--preflight") required.push("--authorization-hash");
  if (action === "--apply") required.push("--verified-snapshot");
  if (required.some((flag) => !values[flag])) {
    throw repairError("TOURNEY_DATABASE_TARGET_TRANSPORT_ARGUMENT_INVALID");
  }
  return { action, values };
};

const loadEnvironment = (envPath) => {
  const resolved = path.resolve(envPath);
  const stats = fs.statSync(resolved);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw repairError("TOURNEY_DATABASE_TARGET_TRANSPORT_ENV_INVALID");
  }
  const parsed = dotenv.parse(fs.readFileSync(resolved));
  return { parsed, resolved };
};

const targetPins = (env) => ({
  legacy: String(env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT || "").trim(),
  sanity: String(env.TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT || "").trim(),
  supabaseApi: String(env.TOURNEY_CUTOVER_EXPECTED_SUPABASE_API_FINGERPRINT || "").trim(),
  supabaseDatabase: String(
    env.TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT || ""
  ).trim(),
});

const runRepair = ({ args, envPath, target }) => new Promise((resolve, reject) => {
  const repairPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "tourney-live-drift-repair.mjs"
  );
  const childArgs = [repairPath, args.action, "--env", envPath];
  for (const flag of ["--authorization-hash", "--verified-snapshot"]) {
    if (args.values[flag]) childArgs.push(flag, args.values[flag]);
  }
  childArgs.push("--supabase-database-url-stdin");
  const child = spawn(process.execPath, childArgs, {
    env: process.env,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) return resolve();
    reject(repairError(
      signal
        ? "TOURNEY_DATABASE_TARGET_TRANSPORT_CHILD_SIGNAL"
        : "TOURNEY_DATABASE_TARGET_TRANSPORT_CHILD_FAILED"
    ));
  });
  child.stdin.end(`${JSON.stringify(target)}\n`);
});

export const main = async (argv = process.argv.slice(2)) => {
  const args = parseTransportRepairArguments(argv);
  const { parsed, resolved } = loadEnvironment(args.values["--env"]);
  const target = await fetchSupabaseDatabaseTarget({
    bearer: parsed.CRON_SECRET,
    expectedTargets: targetPins(parsed),
    transportUrl: args.values["--snapshot-transport-url"],
  });
  await runRepair({ args, envPath: resolved, target });
};

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.code || "TOURNEY_DATABASE_TARGET_TRANSPORT_FAILED")}\n`);
    process.exitCode = 1;
  });
}

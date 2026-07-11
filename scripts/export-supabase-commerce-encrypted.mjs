#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const explicitEnvIndex = process.argv.indexOf("--env");
const explicitEnv =
  explicitEnvIndex >= 0
    ? String(process.argv[explicitEnvIndex + 1] || "").trim()
    : "";
for (const candidate of [
  explicitEnv,
  ".env.local",
  ".vercel/.env.production.local",
]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

const supabaseUrl = readEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const supabaseSecret = readEnv(
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY"
);
if (!supabaseUrl || !supabaseSecret) {
  throw new Error("Supabase server credentials are required.");
}

const supabase = createClient(supabaseUrl, supabaseSecret, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: {
    headers: { "X-Client-Info": "roo-commerce-encrypted-export" },
  },
});

const runWithInput = ({ command, args, input, env = process.env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with status ${code}.`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });

const main = async () => {
  const { data: snapshot, error } = await supabase.rpc(
    "roo_export_commerce_trial_snapshot"
  );
  if (error || snapshot?.format !== "roo-supabase-commerce-export-v1") {
    throw new Error("The Supabase commerce snapshot could not be created.");
  }

  const exportedAt = new Date().toISOString();
  const payload = Buffer.from(
    JSON.stringify({ ...snapshot, exported_by_client_at: exportedAt })
  );
  const passphrase = crypto.randomBytes(48).toString("base64url");
  const stamp = exportedAt.slice(0, 16).replace(/[T:]/g, "-");
  const directory = "/Users/serviroo/Documents/Roo Industries Migration";
  const filename = `Supabase commerce pre-cutover export ${stamp}.json.enc`;
  const outputPath = path.join(directory, filename);
  const keychainService = `RooIndustries-Supabase-Commerce-Snapshot-${stamp}`;

  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await runWithInput({
    command: "openssl",
    args: [
      "enc",
      "-aes-256-cbc",
      "-salt",
      "-pbkdf2",
      "-iter",
      "200000",
      "-pass",
      "env:ROO_SNAPSHOT_PASSPHRASE",
      "-out",
      outputPath,
    ],
    input: payload,
    env: { ...process.env, ROO_SNAPSHOT_PASSPHRASE: passphrase },
  });
  await fsPromises.chmod(outputPath, 0o600);

  await runWithInput({
    command: "security",
    args: [
      "add-generic-password",
      "-U",
      "-a",
      "serviroo",
      "-s",
      keychainService,
      "-w",
    ],
    input: Buffer.from(`${passphrase}\n`),
  });

  const encrypted = await fsPromises.readFile(outputPath);
  const decrypted = await runWithInput({
    command: "openssl",
    args: [
      "enc",
      "-d",
      "-aes-256-cbc",
      "-pbkdf2",
      "-iter",
      "200000",
      "-pass",
      "env:ROO_SNAPSHOT_PASSPHRASE",
      "-in",
      outputPath,
    ],
    input: Buffer.alloc(0),
    env: { ...process.env, ROO_SNAPSHOT_PASSPHRASE: passphrase },
  });
  const verified = JSON.parse(decrypted.toString("utf8"));
  if (
    verified.format !== snapshot.format ||
    verified.source_documents?.length !== snapshot.source_documents?.length
  ) {
    throw new Error("The encrypted Supabase export failed verification.");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputPath,
        keychainService,
        sourceDocuments: snapshot.source_documents?.length || 0,
        encryptedBytes: encrypted.length,
        encryptedSha256: crypto
          .createHash("sha256")
          .update(encrypted)
          .digest("hex"),
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(`[supabase-commerce-encrypted-export] ${error.message}`);
  process.exit(1);
});

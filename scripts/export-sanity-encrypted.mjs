#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createClient } from "@sanity/client";
import dotenv from "dotenv";

for (const candidate of [".env.local", ".vercel/.env.production.local"]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

const projectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
const dataset =
  readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
const token = readEnv(
  "SANITY_PRIVATE_READ_TOKEN",
  "SANITY_READ_TOKEN",
  "SANITY_PRIVATE_WRITE_TOKEN",
  "SANITY_WRITE_TOKEN"
);
if (!projectId || !token) {
  throw new Error("Sanity read credentials are required.");
}

const client = createClient({
  projectId,
  dataset,
  apiVersion:
    readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") ||
    "2023-10-01",
  token,
  useCdn: false,
  perspective: "raw",
});

const runWithInput = ({ command, args, input, env = process.env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with status ${code}.`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.end(input);
  });

const main = async () => {
  const documents = await client.fetch("*[]");
  const exportedAt = new Date().toISOString();
  const payload = Buffer.from(
    JSON.stringify({
      format: "roo-sanity-shadow-export-v1",
      projectId,
      dataset,
      exportedAt,
      documentCount: documents.length,
      documents,
    })
  );
  const passphrase = crypto.randomBytes(48).toString("base64url");
  const date = exportedAt.slice(0, 10);
  const directory = "/Users/serviroo/Documents/Roo Industries Migration";
  const filename = `Sanity pre-cutover export ${date}.json.enc`;
  const outputPath = path.join(directory, filename);
  const keychainService = `RooIndustries-Sanity-Snapshot-${date}`;

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
  const verified = JSON.parse(decrypted.stdout.toString("utf8"));
  if (
    verified.documentCount !== documents.length ||
    verified.projectId !== projectId ||
    verified.dataset !== dataset
  ) {
    throw new Error("The encrypted Sanity export failed verification.");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputPath,
        keychainService,
        documents: documents.length,
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
  console.error(`[sanity-encrypted-export] ${error.message}`);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import { createClient as createSanityClient } from "@sanity/client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { sha256 } from "./supabase-shadow-migration.mjs";

export const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};

export const argumentsFor = (name) =>
  process.argv.flatMap((value, index) =>
    value === name ? [String(process.argv[index + 1] || "").trim()] : []
  ).filter(Boolean);

export const loadRepairEnvironment = (envPath) => {
  if (!envPath) throw new Error("--env must name the exact repair environment file.");
  const resolved = path.resolve(envPath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("The repair environment must be a regular file.");
  }
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("SUPABASE_") ||
      key.startsWith("NEXT_PUBLIC_SUPABASE_") ||
      key.startsWith("SANITY_")
    ) {
      delete process.env[key];
    }
  }
  const loaded = dotenv.config({ path: resolved, override: true, quiet: true });
  if (loaded.error) throw loaded.error;
  return resolved;
};

export const readEnv = (...keys) =>
  keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";

export const parseExpectedGeneration = (value) => {
  const generation = Number(value);
  if (!value || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("--expected-generation must be a non-negative integer.");
  }
  return generation;
};

export const createRepairSupabaseClient = (clientInfo) => {
  const url = readEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  const secret = readEnv("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !secret) throw new Error("Supabase server credentials are required.");
  return createSupabaseClient(url, secret, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { "X-Client-Info": clientInfo } },
  });
};

export const createRepairSanityClient = ({ requireWrite = false } = {}) => {
  const projectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
  const dataset = readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production";
  const token = requireWrite
    ? readEnv("SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN")
    : readEnv(
        "SANITY_PRIVATE_READ_TOKEN",
        "SANITY_PRIVATE_WRITE_TOKEN",
        "SANITY_READ_TOKEN",
        "SANITY_WRITE_TOKEN"
      );
  if (!projectId || !token) {
    throw new Error(
      requireWrite
        ? "Sanity write credentials are required."
        : "Sanity read credentials are required."
    );
  }
  return createSanityClient({
    projectId,
    dataset,
    apiVersion:
      readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") ||
      "2023-10-01",
    token,
    useCdn: false,
    perspective: "raw",
  });
};

export const requireRpc = async (client, name, parameters = {}) => {
  const { data, error } = await client.rpc(name, parameters);
  if (!error) return data;
  const failure = new Error(`${name} failed.`);
  failure.code = error.code || "SUPABASE_RPC_FAILED";
  throw failure;
};

export const assertPausedCommerceControl = async ({
  supabase,
  expectedGeneration,
}) => {
  const control = await requireRpc(supabase, "roo_commerce_control");
  if (
    String(control?.primary_backend || "") !== "supabase" ||
    Number(control?.generation) !== expectedGeneration ||
    control?.starts_paused !== true
  ) {
    throw new Error(
      "Commerce must be Supabase-primary, on the expected generation, and paused before repair."
    );
  }
  return control;
};

export const buildConfirmationDigest = (shape) => sha256(shape);

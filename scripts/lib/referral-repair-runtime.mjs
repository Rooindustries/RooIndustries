import { createDocumentWriteClient } from "../../src/server/data/documentClient.js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import operatorEnvironment from "./operator-environment.cjs";
import { sha256 } from "./supabase-shadow-migration.mjs";

export const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
};

export const argumentsFor = (name) =>
  process.argv.flatMap((value, index) =>
    value === name ? [String(process.argv[index + 1] || "").trim()] : []
  ).filter(Boolean);

export const isValidSanityDocumentId = (value) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value || ""));

export const loadRepairEnvironment = operatorEnvironment.loadOperatorEnvironment;

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

export const createRepairDocumentClient = () => createDocumentWriteClient();

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

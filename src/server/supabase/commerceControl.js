import { createSupabaseAdminClient } from "./adminClient.js";
import { resolveSupabaseRuntimePolicy } from "./runtime.js";

const unavailable = (message, code = "COMMERCE_CONTROL_UNAVAILABLE") => {
  const error = new Error(message);
  error.status = 503;
  error.statusCode = 503;
  error.code = code;
  return error;
};

const normalizeControl = (value = {}) => ({
  primaryBackend:
    String(value?.primary_backend || "").trim().toLowerCase() === "supabase"
      ? "supabase"
      : "sanity",
  generation: Math.max(0, Number(value?.generation) || 0),
  startsPaused: Boolean(value?.starts_paused),
  changeReason: String(value?.change_reason || "").trim(),
  updatedAt: String(value?.updated_at || "").trim(),
});

export const getCommerceControl = async ({
  client = createSupabaseAdminClient(),
} = {}) => {
  const { data, error } = await client.rpc("roo_commerce_control");
  if (error || !data || typeof data !== "object") {
    throw unavailable("The commerce control plane is unavailable.");
  }
  return normalizeControl(data);
};

export const assertCommerceStartAllowed = async ({
  env = process.env,
  client,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  if (policy.commercePrimaryBackend !== "supabase") {
    return {
      primaryBackend: policy.commercePrimaryBackend,
      generation: policy.commerceFailoverGeneration,
      startsPaused: policy.commerceStartsPaused,
    };
  }

  if (policy.commerceStartsPaused) {
    throw unavailable(
      "New commerce starts are temporarily paused.",
      "COMMERCE_STARTS_PAUSED"
    );
  }

  const control = await getCommerceControl({ ...(client ? { client } : {}) });
  if (control.primaryBackend !== "supabase") {
    throw unavailable(
      "Supabase is not the authoritative commerce writer.",
      "COMMERCE_PRIMARY_MISMATCH"
    );
  }
  if (control.generation !== policy.commerceFailoverGeneration) {
    throw unavailable(
      "The commerce deployment generation is stale.",
      "COMMERCE_GENERATION_STALE"
    );
  }
  if (control.startsPaused) {
    throw unavailable(
      "New commerce starts are temporarily paused.",
      "COMMERCE_STARTS_PAUSED"
    );
  }
  return control;
};

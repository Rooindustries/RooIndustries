import { createSupabaseAdminClient } from "./adminClient.js";
import { resolveSupabaseRuntimePolicy } from "./runtime.js";
import {
  assertCommerceControlMatchesLease,
  requireCommerceFailoverLease,
} from "./commerceFailoverLease.js";
import envValue from "./envValue.cjs";

const { normalizeBackend } = envValue;

const unavailable = (message, code = "COMMERCE_CONTROL_UNAVAILABLE") => {
  const error = new Error(message);
  error.status = 503;
  error.statusCode = 503;
  error.code = code;
  return error;
};

const normalizeControl = (value = {}) => ({
  primaryBackend: normalizeBackend(value?.primary_backend),
  generation: Math.max(0, Number(value?.generation) || 0),
  startsPaused: Boolean(value?.starts_paused),
  changeReason: String(value?.change_reason || "").trim(),
  updatedAt: String(value?.updated_at || "").trim(),
});

export const getCommerceControl = async ({
  client = createSupabaseAdminClient(),
} = {}) => {
  let result;
  try {
    result = await client.rpc("roo_commerce_control");
  } catch {
    throw unavailable("The commerce control plane is unavailable.");
  }
  const { data, error } = result || {};
  if (error || !data || typeof data !== "object") {
    throw unavailable("The commerce control plane is unavailable.");
  }
  return normalizeControl(data);
};

const assertCommerceAllowed = async ({
  env = process.env,
  client,
  nowSeconds,
  pauseMessage,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);

  if (policy.commercePrimaryBackend !== "supabase") {
    const lease = requireCommerceFailoverLease({ env, policy, nowSeconds });
    try {
      const liveControl = await getCommerceControl({ ...(client ? { client } : {}) });
      assertCommerceControlMatchesLease({ control: liveControl, lease });
    } catch (error) {
      if (error?.code !== "COMMERCE_CONTROL_UNAVAILABLE") throw error;
    }
    if (lease.startsPaused) {
      throw unavailable(pauseMessage, "COMMERCE_STARTS_PAUSED");
    }
    return {
      primaryBackend: lease.backend,
      generation: lease.generation,
      startsPaused: lease.startsPaused,
      deploymentId: lease.deploymentId,
      leaseExpiresAt: lease.expiresAt,
    };
  }

  if (policy.commerceStartsPaused) {
    throw unavailable(pauseMessage, "COMMERCE_STARTS_PAUSED");
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
      pauseMessage,
      "COMMERCE_STARTS_PAUSED"
    );
  }
  return control;
};

export const assertCommerceStartAllowed = (options = {}) =>
  assertCommerceAllowed({
    ...options,
    pauseMessage: "New commerce starts are temporarily paused.",
  });

export const assertCommerceWriteAllowed = (options = {}) =>
  assertCommerceAllowed({
    ...options,
    pauseMessage: "Commerce changes are temporarily paused.",
  });

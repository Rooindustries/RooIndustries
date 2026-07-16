import sanityConfiguration from "./sanityConfiguration.cjs";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const BACKENDS = new Set(["sanity", "supabase"]);
const { inspectSanityConfiguration } = sanityConfiguration;

const read = (env, key) => String(env?.[key] || "").trim();
const readBoolean = (env, key) => TRUE_VALUES.has(read(env, key).toLowerCase());

const parsePercentage = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.floor(number)));
};

const parseCanaryAccounts = (value) =>
  new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );

const parseGeneration = (value) => {
  const normalized = String(value || "0").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error("COMMERCE_FAILOVER_GENERATION must be a non-negative integer.");
  }
  const generation = Number(normalized);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("COMMERCE_FAILOVER_GENERATION is too large.");
  }
  return generation;
};

export const resolveSupabaseRuntimePolicy = (env = process.env) => {
  const runtime =
    read(env, "VERCEL_ENV").toLowerCase() ||
    (read(env, "NODE_ENV").toLowerCase() === "production"
      ? "production"
      : "development");
  const requestedPrimary =
    read(env, "DATA_PRIMARY_BACKEND").toLowerCase() || "supabase";
  const requestedCommercePrimary =
    read(env, "COMMERCE_PRIMARY_BACKEND").toLowerCase() || requestedPrimary;

  if (!BACKENDS.has(requestedPrimary)) {
    throw new Error("DATA_PRIMARY_BACKEND must be sanity or supabase.");
  }
  if (!BACKENDS.has(requestedCommercePrimary)) {
    throw new Error("COMMERCE_PRIMARY_BACKEND must be sanity or supabase.");
  }

  const cutoverEnabled = readBoolean(env, "SUPABASE_CUTOVER_ENABLED");
  const commerceCutoverEnabled = readBoolean(env, "COMMERCE_CUTOVER_ENABLED");
  const commerceStartsPaused = readBoolean(env, "COMMERCE_STARTS_PAUSED");
  const commerceFailoverGeneration = parseGeneration(
    read(env, "COMMERCE_FAILOVER_GENERATION")
  );
  const shadowWritesEnabled = readBoolean(env, "SUPABASE_SHADOW_WRITES");
  const sanity = inspectSanityConfiguration(env);
  const reverseMirrorLegacyFlagEnabled = readBoolean(
    env,
    "SANITY_REVERSE_MIRROR_WRITES"
  );
  const commerceCanaryPercentage = parsePercentage(
    read(env, "SUPABASE_COMMERCE_CANARY_PERCENT")
  );
  if (
    runtime === "production" &&
    requestedPrimary === "supabase" &&
    !cutoverEnabled
  ) {
    throw new Error(
      "Production Supabase cutover requires SUPABASE_CUTOVER_ENABLED=1."
    );
  }
  if (
    runtime === "production" &&
    requestedCommercePrimary === "supabase" &&
    !commerceCutoverEnabled
  ) {
    throw new Error(
      "Production Supabase commerce cutover requires COMMERCE_CUTOVER_ENABLED=1."
    );
  }
  return {
    runtime,
    primaryBackend: requestedPrimary,
    commercePrimaryBackend: requestedCommercePrimary,
    cutoverEnabled,
    commerceCutoverEnabled,
    commerceStartsPaused,
    commerceFailoverGeneration,
    shadowWritesEnabled,
    reverseMirrorEnabled: sanity.writeConfigured,
    reverseMirrorLegacyFlagEnabled,
    sanityConfigurationStatus: sanity.status,
    contentCanaryPercentage: parsePercentage(
      read(env, "SUPABASE_CONTENT_CANARY_PERCENT")
    ),
    commerceCanaryPercentage,
    authCanaryAccounts: parseCanaryAccounts(
      read(env, "SUPABASE_AUTH_CANARY_ACCOUNTS")
    ),
  };
};

export const shouldUseSupabaseForAccount = ({ identifier, env = process.env }) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  if (policy.primaryBackend === "supabase") return true;
  return policy.authCanaryAccounts.has(String(identifier || "").trim().toLowerCase());
};

export const deterministicCanaryBucket = (value) => {
  const input = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
};

export const selectCanaryBackend = ({ key, percentage, fallback = "sanity" }) =>
  deterministicCanaryBucket(key) < parsePercentage(percentage)
    ? "supabase"
    : fallback;

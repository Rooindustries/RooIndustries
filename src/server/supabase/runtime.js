const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const BACKENDS = new Set(["sanity", "supabase"]);

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

export const resolveSupabaseRuntimePolicy = (env = process.env) => {
  const runtime =
    read(env, "VERCEL_ENV").toLowerCase() ||
    (read(env, "NODE_ENV").toLowerCase() === "production"
      ? "production"
      : "development");
  const requestedPrimary =
    read(env, "DATA_PRIMARY_BACKEND").toLowerCase() || "sanity";

  if (!BACKENDS.has(requestedPrimary)) {
    throw new Error("DATA_PRIMARY_BACKEND must be sanity or supabase.");
  }

  const cutoverEnabled = readBoolean(env, "SUPABASE_CUTOVER_ENABLED");
  const shadowWritesEnabled = readBoolean(env, "SUPABASE_SHADOW_WRITES");
  const reverseMirrorEnabled = readBoolean(
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
    (requestedPrimary === "supabase" || commerceCanaryPercentage > 0) &&
    !reverseMirrorEnabled
  ) {
    throw new Error(
      "Supabase commerce writes require SANITY_REVERSE_MIRROR_WRITES=1."
    );
  }
  if (commerceCanaryPercentage > 0 && !shadowWritesEnabled) {
    throw new Error(
      "Supabase commerce canaries require SUPABASE_SHADOW_WRITES=1."
    );
  }

  return {
    runtime,
    primaryBackend: requestedPrimary,
    cutoverEnabled,
    shadowWritesEnabled,
    reverseMirrorEnabled,
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

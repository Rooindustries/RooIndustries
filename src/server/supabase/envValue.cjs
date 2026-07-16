const BACKENDS = new Set(["sanity", "supabase"]);

const readEnvValue = (env, key) => {
  const value = env?.[key];
  return value === undefined || value === null ? "" : String(value).trim();
};

const readFirstEnvValue = (env, keys = []) => {
  for (const key of keys) {
    const value = readEnvValue(env, key);
    if (value) return value;
  }
  return "";
};

const normalizeBackendLiteral = (value) => {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return BACKENDS.has(normalized) ? normalized : "";
};

const normalizeBackend = (value, fallback = "") =>
  normalizeBackendLiteral(value) || normalizeBackendLiteral(fallback);

module.exports = {
  normalizeBackend,
  readEnvValue,
  readFirstEnvValue,
};

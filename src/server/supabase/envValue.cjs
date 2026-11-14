const ENV_VALUE_PADDING = /^(?:\s|\\[nrt])+|(?:\s|\\[nrt])+$/g;
const readEnvValue = (env, key) => {
  const value = env?.[key];
  return value === undefined || value === null ? "" : String(value).replace(ENV_VALUE_PADDING, "");
};
const readFirstEnvValue = (env, keys = []) => {
  for (const key of keys) {
    const value = readEnvValue(env, key);
    if (value) return value;
  }
  return "";
};
const readProcessEnvValue = key => readEnvValue(process.env, key);
const readFirstProcessEnvValue = (...keys) => readFirstEnvValue(process.env, keys);
const resolveStoreBackend = value => {
  if (value === undefined || value === null || value === "") return "supabase";
  if (typeof value === "string" && ["", "sanity", "supabase"].includes(value.trim().toLowerCase())) return "supabase";
  const error = new Error("The stored backend is unsupported.");
  error.code = "UNSUPPORTED_STORE_BACKEND";
  error.status = 503;
  throw error;
};
module.exports = {
  resolveStoreBackend,
  normalizeBackend: resolveStoreBackend,
  readEnvValue,
  readFirstEnvValue,
  readProcessEnvValue,
  readFirstProcessEnvValue,
};

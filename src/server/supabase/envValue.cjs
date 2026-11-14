const OUTSIDE_VALUE_PADDING = /^(?:\s|\\[nrt])+|(?:\s|\\[nrt])+$/g;
const readEnvValue = (env, key) => {
  const value = env?.[key];
  return value === undefined || value === null ? "" : String(value).trim();
};
const firstValue = (read) => (env, keys = []) => {
  for (const key of keys) {
    const value = read(env, key);
    if (value) return value;
  }
  return "";
};
const readFirstEnvValue = firstValue(readEnvValue);
const readOutsideEnvValue = (env, key) => readEnvValue(env, key).replace(OUTSIDE_VALUE_PADDING, "");
const readFirstOutsideEnvValue = firstValue(readOutsideEnvValue);
const outsideSetting = key => readOutsideEnvValue(process.env, key);
const firstOutsideSetting = (...keys) => readFirstOutsideEnvValue(process.env, keys);
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
  readOutsideEnvValue,
  readFirstOutsideEnvValue,
  outsideSetting,
  firstOutsideSetting,
};

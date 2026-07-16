const { readEnvValue } = require("./envValue.cjs");

const PRIVATE_TARGET_KEYS = Object.freeze({
  projectId: "SANITY_PRIVATE_PROJECT_ID",
  dataset: "SANITY_PRIVATE_DATASET",
  readToken: "SANITY_PRIVATE_READ_TOKEN",
  writeToken: "SANITY_PRIVATE_WRITE_TOKEN",
});

const PUBLIC_TARGET_KEYS = Object.freeze({
  projectId: "SANITY_PROJECT_ID",
  dataset: "SANITY_DATASET",
  readToken: "SANITY_READ_TOKEN",
  writeToken: "SANITY_WRITE_TOKEN",
});

const read = (env, key) => readEnvValue(env, key);
const hasAny = (env, keys) => keys.some((key) => Boolean(read(env, key)));

const inspectSanityConfiguration = (env = process.env) => {
  const privateSelected = hasAny(env, Object.values(PRIVATE_TARGET_KEYS));
  const keys = privateSelected ? PRIVATE_TARGET_KEYS : PUBLIC_TARGET_KEYS;
  const values = Object.fromEntries(
    Object.entries(keys).map(([name, key]) => [name, read(env, key)])
  );
  const anyConfigured = hasAny(env, [
    ...Object.values(PRIVATE_TARGET_KEYS),
    ...Object.values(PUBLIC_TARGET_KEYS),
    "SANITY_PRIVATE_API_VERSION",
    "SANITY_API_VERSION",
    "SANITY_WEBHOOK_SECRET",
  ]);
  const missing = [
    ...(!values.projectId ? [keys.projectId] : []),
    ...(!values.dataset ? [keys.dataset] : []),
    ...(!values.writeToken ? [keys.writeToken] : []),
  ];
  const writeConfigured = missing.length === 0;
  const readConfigured =
    Boolean(values.projectId) &&
    Boolean(values.dataset) &&
    Boolean(values.readToken || values.writeToken);

  return {
    status: !anyConfigured ? "absent" : writeConfigured ? "complete" : "partial",
    target: privateSelected ? "private" : "public",
    keys,
    missing,
    readConfigured,
    writeConfigured,
  };
};

module.exports = {
  PRIVATE_TARGET_KEYS,
  PUBLIC_TARGET_KEYS,
  inspectSanityConfiguration,
};

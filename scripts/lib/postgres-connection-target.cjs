const decodeUrlValue = (value) => {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("\0")) throw new Error();
    return decoded;
  } catch {
    throw new Error("The PostgreSQL connection URL contains invalid encoding.");
  }
};

const requireValue = (value, label) => {
  if (value) return value;
  throw new Error(`The PostgreSQL connection URL is missing ${label}.`);
};

const passthroughVariables = new Set([
  "HOME",
  "LANG",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

const optionalParameters = new Map([
  ["channel_binding", {
    key: "PGCHANNELBINDING",
    allowed: new Set(["disable", "prefer"]),
  }],
  ["sslmode", {
    key: "PGSSLMODE",
    allowed: new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]),
  }],
  ["target_session_attrs", {
    key: "PGTARGETSESSIONATTRS",
    allowed: new Set(["any", "read-write", "read-only", "primary", "standby", "prefer-standby"]),
  }],
]);
const secureSslModes = new Set(["require", "verify-ca", "verify-full"]);
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

const validateParameters = (parsed) => {
  const seen = new Set();
  const result = {};
  for (const [parameter, value] of parsed.searchParams) {
    const definition = optionalParameters.get(parameter);
    if (!definition || seen.has(parameter) || !value || value.includes("\0")) {
      throw new Error("The PostgreSQL connection URL has unsupported parameters.");
    }
    if (definition.allowed && !definition.allowed.has(value)) {
      throw new Error("The PostgreSQL connection URL has an invalid parameter value.");
    }
    seen.add(parameter);
    result[definition.key] = value;
  }
  return result;
};

const buildPostgresConnectionEnv = (databaseUrl, baseEnv = process.env) => {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("The PostgreSQL connection URL is invalid.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("The PostgreSQL connection URL has an unsupported protocol.");
  }
  if (parsed.hash) {
    throw new Error("The PostgreSQL connection URL must not contain a fragment.");
  }

  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const database = decodeUrlValue(parsed.pathname.replace(/^\//, ""));
  if (hostname.includes(",") || hostname.includes("%") || hostname.startsWith("/")) {
    throw new Error("The PostgreSQL connection URL has an unsupported host.");
  }
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => (
      passthroughVariables.has(key) || key.startsWith("LC_")
    ))
  );

  env.PGHOST = requireValue(hostname, "a host");
  env.PGPORT = parsed.port || "5432";
  env.PGUSER = requireValue(decodeUrlValue(parsed.username), "a user");
  env.PGPASSWORD = requireValue(decodeUrlValue(parsed.password), "a password");
  env.PGDATABASE = requireValue(database, "a database name");
  env.PGCONNECT_TIMEOUT = "15";

  const parameters = validateParameters(parsed);
  if (!loopbackHosts.has(hostname) && !secureSslModes.has(parameters.PGSSLMODE)) {
    throw new Error("The PostgreSQL connection URL must require TLS.");
  }
  Object.assign(env, parameters);

  return env;
};

const buildPostgresConnectionOptions = (databaseUrl) => {
  const env = buildPostgresConnectionEnv(databaseUrl, {});
  const sslMode = env.PGSSLMODE || "disable";
  const ssl = sslMode === "verify-ca"
    ? { checkServerIdentity: () => undefined }
    : sslMode;
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: ssl === "disable" ? false : ssl,
    ...(env.PGTARGETSESSIONATTRS
      ? { target_session_attrs: env.PGTARGETSESSIONATTRS }
      : {}),
  };
};

const buildPostgresSessionArgs = (args = []) => [
  "--no-password",
  "-X",
  "--set=ON_ERROR_STOP=1",
  "--command=set search_path=pg_catalog,public; set statement_timeout='120s'; set lock_timeout='5s'",
  ...args,
];

module.exports = {
  buildPostgresConnectionEnv,
  buildPostgresConnectionOptions,
  buildPostgresSessionArgs,
};

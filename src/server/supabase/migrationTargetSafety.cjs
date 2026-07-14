const crypto = require("node:crypto");

const TARGET_ENVIRONMENTS = new Set(["preview", "production"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

const normalize = (value) => String(value || "").trim();
const firstNonEmpty = (...values) =>
  values.map(normalize).find(Boolean) || "";
const enabled = (value) => TRUE_VALUES.has(normalize(value).toLowerCase());
const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(normalize(left).toLowerCase());
  const rightBuffer = Buffer.from(normalize(right).toLowerCase());
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const targetError = (code) => Object.assign(
  new Error("Migration target configuration is invalid."),
  { code }
);

const databaseIdentity = (value, code) => {
  let parsed;
  try {
    parsed = new URL(normalize(value));
  } catch {
    throw targetError(code);
  }
  let database;
  let username;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    username = decodeURIComponent(parsed.username);
  } catch {
    throw targetError(code);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !database ||
    !username
  ) {
    throw targetError(code);
  }
  return {
    hostname: parsed.hostname.toLowerCase().replace(/\.$/, ""),
    port: parsed.port || "5432",
    database,
    username,
  };
};

const databaseTargetIdentity = ({ hostname, port, database }) => ({
  hostname,
  port,
  database,
});

const apiIdentity = (value) => {
  let parsed;
  try {
    parsed = new URL(normalize(value));
  } catch {
    throw targetError("SUPABASE_API_TARGET_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw targetError("SUPABASE_API_TARGET_INVALID");
  }
  return {
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "443",
    pathname: parsed.pathname.replace(/\/+$/, "") || "/",
  };
};

const apiProjectReference = (api) =>
  api.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] || "";

const databaseProjectReference = (database) => {
  const direct = database.hostname.match(
    /^db\.([a-z0-9-]+)\.supabase\.co$/
  )?.[1];
  if (direct) return direct;
  if (!database.hostname.endsWith(".pooler.supabase.com")) return "";
  const pooler = database.username.toLowerCase().match(/\.([a-z0-9-]+)$/)?.[1];
  if (!pooler) throw targetError("SUPABASE_PROJECT_TARGET_MISMATCH");
  return pooler;
};

const supabaseDatabaseIdentity = (values) => {
  const database = databaseIdentity(
    values.supabaseDatabaseUrl,
    "SUPABASE_DATABASE_TARGET_INVALID"
  );
  const projectRef = databaseProjectReference(database);
  return {
    database: databaseTargetIdentity(database),
    ...(projectRef ? { projectRef } : {}),
  };
};

const supabaseIdentity = (values) => {
  const api = apiIdentity(values.supabaseUrl);
  const databaseIdentityValue = supabaseDatabaseIdentity(values);
  const apiProjectRef = apiProjectReference(api);
  if (
    apiProjectRef &&
    databaseIdentityValue.projectRef !== apiProjectRef
  ) {
    throw targetError("SUPABASE_PROJECT_TARGET_MISMATCH");
  }
  return {
    api,
    ...databaseIdentityValue,
    ...(apiProjectRef ? { projectRef: apiProjectRef } : {}),
  };
};

const fingerprint = (kind, identity) =>
  sha256(`roo-migration-target:v1:${kind}:${JSON.stringify(identity)}`);
const cutoverFingerprint = (kind, identity) =>
  sha256(`roo-tourney-cutover-target:v2:${kind}:${JSON.stringify(identity)}`);

const selectedTargetValues = (env = process.env) => {
  const environment = normalize(
    env.SUPABASE_MIGRATION_TARGET_ENVIRONMENT
  ).toLowerCase();
  if (environment === "preview") {
    return {
      environment,
      legacyDatabaseUrl: normalize(env.TOURNEY_PREVIEW_DATABASE_URL),
      supabaseDatabaseUrl: normalize(env.SUPABASE_PREVIEW_DATABASE_URL),
      supabaseUrl: normalize(env.SUPABASE_PREVIEW_URL),
      supabaseSecret: firstNonEmpty(
        env.SUPABASE_PREVIEW_SECRET_KEY,
        env.SUPABASE_PREVIEW_SERVICE_ROLE_KEY
      ),
    };
  }
  return {
    environment,
    legacyDatabaseUrl: firstNonEmpty(
      env.TOURNEY_DATABASE_URL,
      env.POSTGRES_URL
    ),
    supabaseDatabaseUrl: normalize(env.SUPABASE_DATABASE_URL),
    supabaseUrl: firstNonEmpty(
      env.SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_URL
    ),
    supabaseSecret: firstNonEmpty(
      env.SUPABASE_SECRET_KEY,
      env.SUPABASE_SERVICE_ROLE_KEY
    ),
  };
};

const legacyFingerprint = (values) => fingerprint(
  "legacy-postgres",
  databaseTargetIdentity(
    databaseIdentity(values.legacyDatabaseUrl, "LEGACY_DATABASE_TARGET_INVALID")
  )
);
const supabaseFingerprint = (values) =>
  fingerprint("supabase", supabaseIdentity(values));
const supabaseApiFingerprint = (values) =>
  fingerprint("supabase-api", apiIdentity(values.supabaseUrl));
const supabaseDatabaseFingerprint = (values) =>
  fingerprint("supabase-postgres", supabaseDatabaseIdentity(values));
const computeFingerprints = (values) => ({
  legacy: legacyFingerprint(values),
  supabase: supabaseFingerprint(values),
});

const assertTourneyCutoverLegacyTarget = ({ databaseUrl, expectedFingerprint }) => {
  const identity = databaseIdentity(databaseUrl, "LEGACY_DATABASE_TARGET_INVALID");
  const actual = cutoverFingerprint("legacy-postgres", identity);
  const hostname = identity.hostname.toLowerCase();
  const isSupabase = hostname.endsWith(".supabase.co") ||
    hostname.endsWith(".pooler.supabase.com");
  if (
    isSupabase ||
    !FINGERPRINT_PATTERN.test(normalize(expectedFingerprint).toLowerCase()) ||
    !safeEqual(actual, expectedFingerprint)
  ) {
    throw targetError("TOURNEY_CUTOVER_LEGACY_TARGET_MISMATCH");
  }
  return {
    fingerprint: actual,
    database: identity.database,
    username: identity.username,
  };
};

const assertTourneyCutoverSupabaseApiTarget = ({ supabaseUrl, expectedFingerprint }) => {
  const identity = apiIdentity(supabaseUrl);
  const actual = cutoverFingerprint("supabase-api", identity);
  if (
    !FINGERPRINT_PATTERN.test(normalize(expectedFingerprint).toLowerCase()) ||
    !safeEqual(actual, expectedFingerprint)
  ) {
    throw targetError("TOURNEY_CUTOVER_SUPABASE_API_TARGET_MISMATCH");
  }
  return { fingerprint: actual, ...identity };
};

const cutoverSupabaseDatabaseIdentity = ({ databaseUrl, supabaseUrl }) => {
  const database = databaseIdentity(
    databaseUrl,
    "SUPABASE_DATABASE_TARGET_INVALID"
  );
  const projectRef = databaseProjectReference(database);
  const apiProjectRef = apiProjectReference(apiIdentity(supabaseUrl));
  if (!projectRef || !apiProjectRef || projectRef !== apiProjectRef) {
    throw targetError("SUPABASE_PROJECT_TARGET_MISMATCH");
  }
  return { ...database, projectRef };
};

const assertTourneyCutoverSupabaseDatabaseTarget = ({
  databaseUrl,
  supabaseUrl,
  expectedFingerprint,
}) => {
  const identity = cutoverSupabaseDatabaseIdentity({ databaseUrl, supabaseUrl });
  const actual = cutoverFingerprint("supabase-postgres", identity);
  if (
    !FINGERPRINT_PATTERN.test(normalize(expectedFingerprint).toLowerCase()) ||
    !safeEqual(actual, expectedFingerprint)
  ) {
    throw targetError("TOURNEY_CUTOVER_SUPABASE_DATABASE_TARGET_MISMATCH");
  }
  return { fingerprint: actual, ...identity };
};

const sanityIdentity = ({ projectId, dataset }) => {
  const normalizedProjectId = normalize(projectId).toLowerCase();
  const normalizedDataset = normalize(dataset);
  if (
    !/^[a-z0-9-]+$/.test(normalizedProjectId) ||
    !/^[a-z0-9_-]+$/.test(normalizedDataset)
  ) {
    throw targetError("SANITY_TARGET_INVALID");
  }
  return { projectId: normalizedProjectId, dataset: normalizedDataset };
};

const assertTourneyCutoverSanityTarget = ({
  projectId,
  dataset,
  expectedFingerprint,
}) => {
  const identity = sanityIdentity({ projectId, dataset });
  const actual = cutoverFingerprint("sanity", identity);
  if (
    !FINGERPRINT_PATTERN.test(normalize(expectedFingerprint).toLowerCase()) ||
    !safeEqual(actual, expectedFingerprint)
  ) {
    throw targetError("TOURNEY_CUTOVER_SANITY_TARGET_MISMATCH");
  }
  return { fingerprint: actual, ...identity };
};

const discordIdentity = ({ apiBaseUrl, guildId, participantRoleId, hostRoleId }) => {
  const api = apiIdentity(apiBaseUrl || "https://discord.com/api/v10");
  const canonicalApi = `https://${api.hostname}${
    api.port === "443" ? "" : `:${api.port}`
  }${api.pathname}`;
  const snowflake = /^[0-9]{5,30}$/;
  const identity = {
    apiBaseUrl: canonicalApi,
    guildId: normalize(guildId),
    participantRoleId: normalize(participantRoleId),
    hostRoleId: normalize(hostRoleId),
  };
  if (
    canonicalApi !== "https://discord.com/api/v10" ||
    !snowflake.test(identity.guildId) ||
    !snowflake.test(identity.participantRoleId) ||
    !snowflake.test(identity.hostRoleId) ||
    identity.participantRoleId === identity.hostRoleId
  ) {
    throw targetError("DISCORD_TARGET_INVALID");
  }
  return identity;
};

const assertTourneyCutoverDiscordTarget = ({ expectedFingerprint, ...target }) => {
  const identity = discordIdentity(target);
  const actual = cutoverFingerprint("discord", identity);
  if (
    !FINGERPRINT_PATTERN.test(normalize(expectedFingerprint).toLowerCase()) ||
    !safeEqual(actual, expectedFingerprint)
  ) {
    throw targetError("TOURNEY_CUTOVER_DISCORD_TARGET_MISMATCH");
  }
  return { fingerprint: actual, ...identity };
};

const failure = (code, message) => ({ code, message });

const expectedFingerprintFailures = ({ actual, env }) => {
  const failures = [];
  const expected = {
    legacy: normalize(
      env.SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT
    ).toLowerCase(),
    supabase: normalize(
      env.SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT
    ).toLowerCase(),
  };
  for (const target of ["legacy", "supabase"]) {
    if (!FINGERPRINT_PATTERN.test(expected[target])) {
      failures.push(failure(
        `${target.toUpperCase()}_EXPECTED_FINGERPRINT_INVALID`,
        `SUPABASE_MIGRATION_EXPECTED_${target.toUpperCase()}_FINGERPRINT must be a SHA-256 fingerprint.`
      ));
    } else if (actual && !safeEqual(actual[target], expected[target])) {
      failures.push(failure(
        `${target.toUpperCase()}_TARGET_FINGERPRINT_MISMATCH`,
        `The configured ${target} migration target does not match its expected fingerprint.`
      ));
    }
  }
  return { expected, failures };
};

const sameComputedTarget = (compute, selected, generic) => {
  try {
    return safeEqual(compute(selected), compute(generic));
  } catch {
    return false;
  }
};

const sameSupabaseProject = (selected, generic) => {
  try {
    const selectedProject = supabaseDatabaseIdentity(selected).projectRef;
    const genericProject = supabaseDatabaseIdentity(generic).projectRef;
    return Boolean(selectedProject) && selectedProject === genericProject;
  } catch {
    return false;
  }
};

const inheritedProductionTargets = ({ env, actual, environment, values }) => {
  if (environment !== "preview" || !actual) return [];
  const genericValues = {
    legacyDatabaseUrl: firstNonEmpty(
      env.TOURNEY_DATABASE_URL,
      env.POSTGRES_URL
    ),
    supabaseDatabaseUrl: normalize(env.SUPABASE_DATABASE_URL),
    supabaseUrl: firstNonEmpty(
      env.SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_URL
    ),
  };
  const inherited = [];
  if (sameComputedTarget(legacyFingerprint, values, genericValues)) {
    inherited.push("legacy");
  }
  if (
    sameComputedTarget(supabaseApiFingerprint, values, genericValues) ||
    sameComputedTarget(supabaseDatabaseFingerprint, values, genericValues) ||
    sameSupabaseProject(values, genericValues)
  ) {
    inherited.push("supabase");
  }
  return inherited;
};

const productionAcknowledgementRequirement = ({
  env,
  environment,
  inheritedTargets,
}) => {
  const required = environment === "production" || inheritedTargets.length > 0;
  if (!required || enabled(env.SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS)) {
    return { failure: null, required };
  }
  return {
    failure: failure(
      "PRODUCTION_MUTATION_FLAG_REQUIRED",
      inheritedTargets.length > 0
        ? "Preview migration targets that match inherited generic targets require SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1."
        : "Production migration targets require SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1."
    ),
    required,
  };
};

const inspectMigrationTargets = (env = process.env) => {
  const values = selectedTargetValues(env);
  const failures = [];
  if (!TARGET_ENVIRONMENTS.has(values.environment)) {
    failures.push(failure(
      "TARGET_ENVIRONMENT_INVALID",
      "SUPABASE_MIGRATION_TARGET_ENVIRONMENT must be preview or production."
    ));
  }
  if (!values.supabaseSecret) {
    failures.push(failure(
      "SUPABASE_TARGET_SECRET_MISSING",
      "The selected Supabase migration target requires a server secret key."
    ));
  }

  let actual = null;
  try {
    actual = computeFingerprints(values);
  } catch (error) {
    failures.push(failure(
      error.code || "MIGRATION_TARGET_INVALID",
      "The selected migration target URLs are invalid."
    ));
  }

  const expectedResult = expectedFingerprintFailures({ actual, env });
  failures.push(...expectedResult.failures);
  const inheritedTargets = inheritedProductionTargets({
    env,
    actual,
    environment: values.environment,
    values,
  });
  const productionRequirement = productionAcknowledgementRequirement({
    env,
    environment: values.environment,
    inheritedTargets,
  });
  if (productionRequirement.failure) failures.push(productionRequirement.failure);

  return {
    ok: failures.length === 0,
    actual,
    expected: expectedResult.expected,
    environment: values.environment,
    failures,
    inheritedProductionTargets: inheritedTargets,
    requiresProductionAcknowledgement: productionRequirement.required,
    values,
  };
};

const productionAcknowledged = ({ acknowledgement, action, actual }) =>
  acknowledgement?.confirmed === true &&
  normalize(acknowledgement.action).toLowerCase() === action &&
  safeEqual(acknowledgement.legacyTargetFingerprint, actual?.legacy) &&
  safeEqual(acknowledgement.supabaseTargetFingerprint, actual?.supabase);

const authorizeMigrationTargetRequest = ({
  env = process.env,
  payload = {},
  action,
  mutating = true,
} = {}) => {
  const inspection = inspectMigrationTargets(env);
  if (!inspection.ok) {
    throw Object.assign(new Error("Migration target validation failed."), {
      code: "MIGRATION_TARGET_VALIDATION_FAILED",
      status: 409,
    });
  }
  if (
    mutating &&
    inspection.requiresProductionAcknowledgement &&
    !productionAcknowledged({
      acknowledgement: payload.productionMutationAcknowledgement,
      action: normalize(action).toLowerCase(),
      actual: inspection.actual,
    })
  ) {
    throw Object.assign(new Error("Production mutation acknowledgement required."), {
      code: "PRODUCTION_MUTATION_ACKNOWLEDGEMENT_REQUIRED",
      status: 409,
    });
  }
  return inspection;
};

const buildMigrationRouteEnv = ({ env = process.env, inspection } = {}) => {
  const checked = inspection || inspectMigrationTargets(env);
  if (!checked.ok) throw targetError("MIGRATION_TARGET_VALIDATION_FAILED");
  return {
    ...env,
    TOURNEY_DATABASE_URL: checked.values.legacyDatabaseUrl,
    POSTGRES_URL: "",
    SUPABASE_DATABASE_URL: checked.values.supabaseDatabaseUrl,
    SUPABASE_URL: checked.values.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_URL: "",
    SUPABASE_SECRET_KEY: checked.values.supabaseSecret,
    SUPABASE_SERVICE_ROLE_KEY: "",
  };
};

module.exports = {
  assertTourneyCutoverDiscordTarget,
  assertTourneyCutoverLegacyTarget,
  assertTourneyCutoverSanityTarget,
  assertTourneyCutoverSupabaseApiTarget,
  assertTourneyCutoverSupabaseDatabaseTarget,
  authorizeMigrationTargetRequest,
  buildMigrationRouteEnv,
  computeLegacyMigrationTargetFingerprint: (databaseUrl) =>
    legacyFingerprint({ legacyDatabaseUrl: normalize(databaseUrl) }),
  computeTourneyCutoverLegacyTargetFingerprint: (databaseUrl) =>
    cutoverFingerprint(
      "legacy-postgres",
      databaseIdentity(databaseUrl, "LEGACY_DATABASE_TARGET_INVALID")
    ),
  computeTourneyCutoverSanityTargetFingerprint: ({ projectId, dataset }) =>
    cutoverFingerprint("sanity", sanityIdentity({ projectId, dataset })),
  computeTourneyCutoverSupabaseApiTargetFingerprint: (supabaseUrl) =>
    cutoverFingerprint("supabase-api", apiIdentity(supabaseUrl)),
  computeTourneyCutoverSupabaseDatabaseTargetFingerprint: ({ databaseUrl, supabaseUrl }) =>
    cutoverFingerprint(
      "supabase-postgres",
      cutoverSupabaseDatabaseIdentity({ databaseUrl, supabaseUrl })
    ),
  computeTourneyCutoverDiscordTargetFingerprint: (target) =>
    cutoverFingerprint("discord", discordIdentity(target)),
  computeMigrationTargetFingerprints: (env = process.env) =>
    computeFingerprints(selectedTargetValues(env)),
  inspectMigrationTargets,
};

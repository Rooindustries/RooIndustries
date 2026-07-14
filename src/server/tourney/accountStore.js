import crypto from "node:crypto";
import { assertTourneySchemaVersion, getTourneySql } from "./sqlClient.js";
import { enqueueTourneyExternalOperation } from "./externalOperations.js";
import { resolveTourneyStorePolicy } from "./store.js";
import { isEnabledTourneyFlag, stableTourneyJson } from "./canonical.js";

const STORE_DOC_ID = "tourneyAuthStore";
const STORE_DOC_TYPE = "tourneyAuthStore";
const MEMORY_STORE =
  globalThis.__rooTourneyAccountStore ||
  (globalThis.__rooTourneyAccountStore = { accountsJson: "" });

const getSanityConfig = (env = process.env) => ({
  projectId:
    env.SANITY_PROJECT_ID ||
    env.NEXT_PUBLIC_SANITY_PROJECT_ID ||
    "9g42k3ur",
  dataset:
    env.SANITY_DATASET ||
    env.NEXT_PUBLIC_SANITY_DATASET ||
    "production",
  apiVersion:
    env.SANITY_API_VERSION ||
    env.NEXT_PUBLIC_SANITY_API_VERSION ||
    "2023-10-01",
  token:
    env.SANITY_WRITE_TOKEN ||
    env.SANITY_API_TOKEN ||
    "",
});

const shouldUseMemoryStore = (env = process.env) =>
  env.TOURNEY_ACCOUNT_STORE_MODE === "memory";

export const getTourneyAccountsCanonicalHash = (accounts) =>
  crypto.createHash("sha256").update(stableTourneyJson(accounts)).digest("hex");
export const getTourneyAdminAuthCanonicalHash = (account = {}) =>
  crypto.createHash("sha256").update(stableTourneyJson({
    username: String(account.username || "").trim().toLowerCase(),
    email: String(account.email || "").trim().toLowerCase(),
    role: String(account.role || "").trim().toLowerCase(),
    active: account.active !== false,
    version: String(account.version || "1"),
    passwordHash: String(account.passwordHash || account.password_hash || ""),
  })).digest("hex");
const snapshotTable = (backend) => backend === "supabase"
  ? "tourney.account_snapshots"
  : "tourney_account_snapshots";

export const readLatestTourneyAccountSnapshot = async ({
  env = process.env,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const sql = await getTourneySql(env);
  const rows = await sql`
    select snapshot_id,version,accounts_json,canonical_hash,created_at
    from ${sql(snapshotTable(policy.primaryBackend))}
    order by version desc limit 1
  `;
  return rows[0] || null;
};

const getSanityClient = async (env = process.env) => {
  if (shouldUseMemoryStore(env)) return null;

  const config = getSanityConfig(env);
  if (!config.projectId || !config.dataset || !config.token) {
    return null;
  }

  const { createDataClient } = await import("../data/documentClient.js");
  return createDataClient({
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    token: config.token,
    useCdn: false,
  });
};

export const isPersistentTourneyAccountStoreConfigured = async (env = process.env) =>
  shouldUseMemoryStore(env) || Boolean(
    env.SUPABASE_DATABASE_URL || env.TOURNEY_DATABASE_URL || env.POSTGRES_URL ||
    await getSanityClient(env)
  );

export const readPersistedTourneyAccountsJson = async (env = process.env) => {
  if (shouldUseMemoryStore(env)) {
    return MEMORY_STORE.accountsJson || "";
  }

  const hardened = isEnabledTourneyFlag(env.TOURNEY_HARDENING_V4_ENABLED);
  try {
    if (!env.SUPABASE_DATABASE_URL && !env.TOURNEY_DATABASE_URL && !env.POSTGRES_URL) {
      throw Object.assign(new Error("Tourney database is not configured."), { code: "42P01" });
    }
    if (env.NODE_ENV === "test") throw Object.assign(new Error("Use the configured test account store."), { code: "42P01" });
    if (hardened) await assertTourneySchemaVersion(env);
    const policy = resolveTourneyStorePolicy(env);
    const sql = await getTourneySql(env);
    const rows = await sql`
      select accounts_json from ${sql(snapshotTable(policy.primaryBackend))}
      order by version desc limit 1
    `;
    if (rows[0]?.accounts_json) return JSON.stringify(rows[0].accounts_json);
    if (hardened) {
      const error = new Error("The authoritative Tourney account snapshot is missing.");
      error.code = "TOURNEY_ACCOUNT_SNAPSHOT_REQUIRED";
      error.status = 503;
      throw error;
    }
  } catch (error) {
    if (hardened || !['42P01', '42703'].includes(String(error?.code || ""))) {
      throw error;
    }
  }

  const client = await getSanityClient(env);
  if (!client) return "";

  const doc = await client.fetch(
    `*[_id == $id][0]{accountsJson}`,
    { id: STORE_DOC_ID },
    { cache: "no-store" }
  );

  return String(doc?.accountsJson || "").trim();
};

export const projectTourneyAccountSnapshotToSanity = async ({
  accountsJson,
  actorUsername,
  signal,
  env = process.env,
} = {}) => {
  const client = await getSanityClient(env);
  if (!client) throw new Error("Persistent Tourney Sanity projection is not configured.");
  const updatedAt = new Date().toISOString();
  const updatedBy = String(actorUsername || "").trim().toLowerCase();
  await client.createIfNotExists({
    _id: STORE_DOC_ID,
    _type: STORE_DOC_TYPE,
    accountsJson: "[]",
    updatedAt,
    updatedBy,
  }, { signal });
  await client.patch(STORE_DOC_ID).set({
    accountsJson,
    updatedAt,
    updatedBy,
  }).commit({ autoGenerateArrayKeys: true, signal });
  return { ok: true, provider: "sanity", updatedAt, updatedBy };
};

export const writePersistedTourneyAccountsJson = async ({
  accountsJson,
  actorUsername,
  expectedCurrentHash = "",
  env = process.env,
} = {}) => {
  const nextAccountsJson = String(accountsJson || "").trim();
  const updatedAt = new Date().toISOString();
  const updatedBy = String(actorUsername || "").trim().toLowerCase();

  if (!nextAccountsJson) {
    throw new Error("Missing tourney accounts JSON.");
  }

  if (shouldUseMemoryStore(env)) {
    MEMORY_STORE.accountsJson = nextAccountsJson;
    MEMORY_STORE.updatedAt = updatedAt;
    MEMORY_STORE.updatedBy = updatedBy;
    return {
      ok: true,
      provider: "memory",
      updatedAt,
      updatedBy,
    };
  }

  const parsed = JSON.parse(nextAccountsJson);
  const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;
  if (!Array.isArray(accounts)) throw new Error("Tourney account JSON is invalid.");
  const policy = resolveTourneyStorePolicy(env);
  const sql = await getTourneySql(env);
  const [context] = await sql`
    select nullif(current_setting('roo.tourney_command_id', true), '') as command_id
  `;
  if (!context?.command_id) {
    const error = new Error("Tourney account updates require a command.");
    error.code = "TOURNEY_COMMAND_CONTEXT_REQUIRED";
    throw error;
  }
  const canonicalHash = getTourneyAccountsCanonicalHash(accounts);
  await sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('roo-tourney-account-snapshot-version', 0)
    )
  `;
  const currentRows = await sql`
    select snapshot_id,version,accounts_json,canonical_hash
    from ${sql(snapshotTable(policy.primaryBackend))}
    order by version desc limit 1
  `;
  if (
    expectedCurrentHash && currentRows[0]?.canonical_hash &&
    currentRows[0].canonical_hash !== expectedCurrentHash
  ) {
    const error = new Error("Tourney accounts changed while this request was being prepared.");
    error.status = 409;
    error.code = "TOURNEY_ACCOUNT_SNAPSHOT_CONFLICT";
    throw error;
  }
  const rows = await sql`
    insert into ${sql(snapshotTable(policy.primaryBackend))} (
      version, accounts_json, canonical_hash, generation, created_by,
      supersedes_snapshot_id
    ) select
      coalesce(max(version), 0) + 1, ${sql.json(accounts)}, ${canonicalHash},
      ${policy.generation}, ${updatedBy},
      (array_agg(snapshot_id order by version desc))[1]
    from ${sql(snapshotTable(policy.primaryBackend))}
    returning snapshot_id, version, created_at
  `;
  const previousAccounts = Array.isArray(currentRows[0]?.accounts_json)
    ? currentRows[0].accounts_json
    : currentRows[0]?.accounts_json?.accounts;
  const nextUsernames = new Set(accounts.map((account) =>
    String(account?.username || "").trim().toLowerCase()
  ));
  const authAccounts = [
    ...accounts,
    ...(Array.isArray(previousAccounts) ? previousAccounts : [])
      .filter((account) => !nextUsernames.has(
        String(account?.username || "").trim().toLowerCase()
      ))
      .map((account) => ({ ...account, active: false })),
  ];
  for (const account of authAccounts) {
    await enqueueTourneyExternalOperation({
      commandId: context.command_id,
      operationKind: "supabase_admin_auth",
      entityType: "account",
      entityId: account.username,
      desiredState: {
        account,
        accountHash: getTourneyAdminAuthCanonicalHash(account),
        snapshotId: rows[0].snapshot_id,
        snapshotVersion: Number(rows[0].version),
        snapshotHash: canonicalHash,
      },
      env,
    });
  }
  await enqueueTourneyExternalOperation({
    commandId: context.command_id,
    operationKind: "sanity_account_projection",
    entityType: "account_snapshot",
    entityId: rows[0].snapshot_id,
    desiredState: {
      accountsJson: nextAccountsJson,
      actorUsername: updatedBy,
      snapshotId: rows[0].snapshot_id,
      snapshotVersion: Number(rows[0].version),
      snapshotHash: canonicalHash,
    },
    env,
  });

  return {
    ok: true,
    provider: policy.primaryBackend,
    updatedAt: rows[0].created_at || updatedAt,
    updatedBy,
  };
};

export const appendTourneyAccountPrincipalSnapshot = async ({
  env = process.env,
  principalId,
  username,
} = {}) => {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  const normalizedPrincipalId = String(principalId || "").trim();
  if (!normalizedUsername || !normalizedPrincipalId) {
    throw new Error("A complete Tourney account principal is required.");
  }
  const policy = resolveTourneyStorePolicy(env);
  const sql = await getTourneySql(env);
  await sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('roo-tourney-account-snapshot-version', 0)
    )
  `;
  const [current] = await sql`
    select snapshot_id,version,accounts_json
    from ${sql(snapshotTable(policy.primaryBackend))}
    order by version desc limit 1
  `;
  const accounts = Array.isArray(current?.accounts_json)
    ? current.accounts_json
    : current?.accounts_json?.accounts;
  if (!Array.isArray(accounts)) throw new Error("Tourney account snapshot is missing.");
  let found = false;
  const nextAccounts = accounts.map((account) => {
    if (String(account?.username || "").trim().toLowerCase() !== normalizedUsername) {
      return account;
    }
    found = true;
    return { ...account, principalId: normalizedPrincipalId };
  });
  if (!found) throw new Error("Tourney account principal target is missing.");
  if (getTourneyAccountsCanonicalHash(accounts) === getTourneyAccountsCanonicalHash(nextAccounts)) {
    return { updated: false, version: Number(current.version) };
  }
  const accountsJson = JSON.stringify(nextAccounts, null, 2);
  const [created] = await sql`
    insert into ${sql(snapshotTable(policy.primaryBackend))} (
      version,accounts_json,canonical_hash,generation,created_by,supersedes_snapshot_id
    ) values (
      ${Number(current.version) + 1},${sql.json(nextAccounts)},
      ${getTourneyAccountsCanonicalHash(nextAccounts)},${policy.generation},
      'auth-principal-projection',${current.snapshot_id}
    ) returning snapshot_id,version,created_at
  `;
  const [context] = await sql`
    select nullif(current_setting('roo.tourney_command_id',true),'') command_id
  `;
  await enqueueTourneyExternalOperation({
    commandId: context?.command_id,
    operationKind: "sanity_account_projection",
    entityType: "account_snapshot",
    entityId: created.snapshot_id,
    desiredState: {
      accountsJson,
      actorUsername: "auth-principal-projection",
      snapshotId: created.snapshot_id,
      snapshotVersion: Number(created.version),
      snapshotHash: getTourneyAccountsCanonicalHash(nextAccounts),
    },
    env,
  });
  return { updated: true, version: Number(created.version), updatedAt: created.created_at };
};

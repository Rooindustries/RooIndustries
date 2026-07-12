import crypto from "node:crypto";
import { getTourneySql } from "./sqlClient.js";
import { enqueueTourneyExternalOperation } from "./externalOperations.js";
import { resolveTourneyStorePolicy } from "./store.js";

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

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};
export const getTourneyAccountsCanonicalHash = (accounts) =>
  crypto.createHash("sha256").update(stableJson(accounts)).digest("hex");
const snapshotTable = (backend) => backend === "supabase"
  ? "tourney.account_snapshots"
  : "tourney_account_snapshots";

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

  try {
    if (!env.SUPABASE_DATABASE_URL && !env.TOURNEY_DATABASE_URL && !env.POSTGRES_URL) {
      throw Object.assign(new Error("Tourney database is not configured."), { code: "42P01" });
    }
    if (env.NODE_ENV === "test") throw Object.assign(new Error("Use the configured test account store."), { code: "42P01" });
    const policy = resolveTourneyStorePolicy(env);
    const sql = await getTourneySql(env);
    const rows = await sql`
      select accounts_json from ${sql(snapshotTable(policy.primaryBackend))}
      order by version desc limit 1
    `;
    if (rows[0]?.accounts_json) return JSON.stringify(rows[0].accounts_json);
  } catch (error) {
    if (!['42P01', '42703'].includes(String(error?.code || ""))) throw error;
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
  });
  await client.patch(STORE_DOC_ID).set({
    accountsJson,
    updatedAt,
    updatedBy,
  }).commit({ autoGenerateArrayKeys: true });
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
    select canonical_hash from ${sql(snapshotTable(policy.primaryBackend))}
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
  for (const account of accounts) {
    await enqueueTourneyExternalOperation({
      commandId: context.command_id,
      operationKind: "supabase_admin_auth",
      entityType: "account",
      entityId: account.username,
      desiredState: { account },
      env,
    });
  }
  await enqueueTourneyExternalOperation({
    commandId: context.command_id,
    operationKind: "sanity_account_projection",
    entityType: "account_snapshot",
    entityId: rows[0].snapshot_id,
    desiredState: { accountsJson: nextAccountsJson, actorUsername: updatedBy },
    env,
  });

  return {
    ok: true,
    provider: policy.primaryBackend,
    updatedAt: rows[0].created_at || updatedAt,
    updatedBy,
  };
};

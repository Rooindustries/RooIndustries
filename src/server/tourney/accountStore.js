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
    env.REACT_APP_SANITY_WRITE_TOKEN ||
    env.SANITY_API_TOKEN ||
    "",
});

const shouldUseMemoryStore = (env = process.env) =>
  env.TOURNEY_ACCOUNT_STORE_MODE === "memory";

const getSanityClient = async (env = process.env) => {
  if (shouldUseMemoryStore(env)) return null;

  const config = getSanityConfig(env);
  if (!config.projectId || !config.dataset || !config.token) {
    return null;
  }

  const { createClient } = await import("@sanity/client");
  return createClient({
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    token: config.token,
    useCdn: false,
  });
};

export const isPersistentTourneyAccountStoreConfigured = async (env = process.env) =>
  shouldUseMemoryStore(env) || Boolean(await getSanityClient(env));

export const readPersistedTourneyAccountsJson = async (env = process.env) => {
  if (shouldUseMemoryStore(env)) {
    return MEMORY_STORE.accountsJson || "";
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

export const writePersistedTourneyAccountsJson = async ({
  accountsJson,
  actorUsername,
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

  const client = await getSanityClient(env);
  if (!client) {
    throw new Error("Persistent tourney account store is not configured.");
  }

  await client.createIfNotExists({
    _id: STORE_DOC_ID,
    _type: STORE_DOC_TYPE,
    accountsJson: "[]",
    updatedAt,
    updatedBy,
  });

  await client
    .patch(STORE_DOC_ID)
    .set({
      accountsJson: nextAccountsJson,
      updatedAt,
      updatedBy,
    })
    .commit({ autoGenerateArrayKeys: true });

  return {
    ok: true,
    provider: "sanity",
    updatedAt,
    updatedBy,
  };
};

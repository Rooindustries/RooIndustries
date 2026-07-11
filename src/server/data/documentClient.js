import { createClient as createSanityClient } from "@sanity/client";
import { createSupabaseDocumentClient } from "../supabase/documentClient.js";
import { createShadowingSanityClient } from "../supabase/shadowingSanityClient.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { createReverseMirroringSupabaseClient } from "../supabase/reverseMirroringClient.js";

const DEFAULT_API_VERSION = "2023-10-01";
const DOCUMENT_BACKENDS = new Set(["sanity", "supabase"]);

const readFirst = (env, keys) =>
  keys
    .map((key) => String(env?.[key] || "").trim())
    .find(Boolean) || "";

const resolveDocumentBackend = ({ override, primary }) => {
  const backend = String(override || primary || "").trim().toLowerCase();
  if (!DOCUMENT_BACKENDS.has(backend)) {
    throw new Error("Document backend override must be sanity or supabase.");
  }
  return backend;
};

const resolvePolicyBackend = ({ policy, domain = "global" }) =>
  domain === "commerce"
    ? policy.commercePrimaryBackend
    : policy.primaryBackend;

const resolveSanityEnv = (env = process.env, { requireWrite = false } = {}) => {
  const projectId = readFirst(env, ["SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID"]);
  const dataset = readFirst(env, ["SANITY_PRIVATE_DATASET", "SANITY_DATASET"]);
  const apiVersion =
    readFirst(env, ["SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION"]) ||
    DEFAULT_API_VERSION;
  const token = readFirst(
    env,
    requireWrite
      ? ["SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN"]
      : [
          "SANITY_PRIVATE_READ_TOKEN",
          "SANITY_READ_TOKEN",
          "SANITY_PRIVATE_WRITE_TOKEN",
          "SANITY_WRITE_TOKEN",
        ]
  );

  if (!projectId || !dataset || !token) {
    throw new Error(
      requireWrite
        ? "Sanity write access is not configured."
        : "Sanity read access is not configured."
    );
  }
  return { projectId, dataset, apiVersion, token };
};

const createConfiguredSanityClient = ({
  env = process.env,
  requireWrite = false,
  perspective = "published",
} = {}) =>
  createSanityClient({
    ...resolveSanityEnv(env, { requireWrite }),
    useCdn: false,
    perspective,
  });

export const createDataClient = (
  sanityConfig = {},
  {
    env = process.env,
    supabaseClient,
    backendOverride = "",
    domain = "global",
  } = {}
) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  const backend = resolveDocumentBackend({
    override: backendOverride,
    primary: resolvePolicyBackend({ policy, domain }),
  });
  if (backend === "supabase") {
    const client = createSupabaseDocumentClient({
      shadowClient: supabaseClient,
      commerceOnly: domain === "commerce",
      cutoverGeneration: policy.commerceFailoverGeneration,
    });
    if (!policy.reverseMirrorEnabled) return client;
    return createReverseMirroringSupabaseClient({
      supabaseClient: client,
      sanityClient: createSanityClient(sanityConfig),
    });
  }

  const sanityClient = createSanityClient(sanityConfig);
  if (!policy.shadowWritesEnabled) return sanityClient;
  return createShadowingSanityClient({
    sanityClient,
    shadowClient: supabaseClient,
    commerceOnly: domain === "commerce",
  });
};

export const createDocumentReadClient = ({
  env = process.env,
  perspective = "published",
  supabaseClient,
  backendOverride = "",
  domain = "global",
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  const backend = resolveDocumentBackend({
    override: backendOverride,
    primary: resolvePolicyBackend({ policy, domain }),
  });
  if (backend === "supabase") {
    return createSupabaseDocumentClient({
      shadowClient: supabaseClient,
      commerceOnly: domain === "commerce",
      cutoverGeneration: policy.commerceFailoverGeneration,
    });
  }
  return createConfiguredSanityClient({ env, perspective });
};

export const createDocumentWriteClient = ({
  env = process.env,
  supabaseClient,
  backendOverride = "",
  domain = "global",
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  const backend = resolveDocumentBackend({
    override: backendOverride,
    primary: resolvePolicyBackend({ policy, domain }),
  });
  if (backend === "supabase") {
    const client = createSupabaseDocumentClient({
      shadowClient: supabaseClient,
      commerceOnly: domain === "commerce",
      cutoverGeneration: policy.commerceFailoverGeneration,
    });
    if (!policy.reverseMirrorEnabled) return client;
    return createReverseMirroringSupabaseClient({
      supabaseClient: client,
      sanityClient: createConfiguredSanityClient({ env, requireWrite: true }),
    });
  }

  const sanityClient = createConfiguredSanityClient({ env, requireWrite: true });
  if (!policy.shadowWritesEnabled) return sanityClient;
  return createShadowingSanityClient({
    sanityClient,
    shadowClient: supabaseClient,
    commerceOnly: domain === "commerce",
  });
};

export const createOptionalDocumentWriteClient = ({
  env = process.env,
  supabaseClient,
  backendOverride = "",
  domain = "global",
} = {}) => {
  try {
    return createDocumentWriteClient({
      env,
      supabaseClient,
      backendOverride,
      domain,
    });
  } catch {
    return null;
  }
};

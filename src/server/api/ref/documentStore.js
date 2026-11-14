import envValue from "../../supabase/envValue.cjs";
const { normalizeBackend } = envValue;
import {
  createDocumentReadClient,
  createDocumentWriteClient,
  createOptionalDocumentWriteClient,
} from "../../data/documentClient.js";
import { createCommerceStore } from "../../commerce/store.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";


export const requireEnvValue = (key, message = "") => {
  const value = String(process.env[key] || "").trim();
  if (!value) {
    throw new Error(message || `Missing required environment variable: ${key}`);
  }
  return value;
};

export const createRefReadClient = ({ perspective = "published" } = {}) => {
  return createDocumentReadClient({ perspective });
};

export const createRefWriteClient = ({ backendOverride = "" } = {}) =>
  createDocumentWriteClient({ backendOverride });

export const createCommerceReadClient = ({
  perspective = "published",
  backendOverride = "",
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy();
  const backend = normalizeBackend(
    backendOverride,
    normalizeBackend(policy.commercePrimaryBackend, "supabase")
  );
  return createCommerceStore({
    backend,
    cutoverGeneration: policy.commerceFailoverGeneration,
    client: createDocumentReadClient({
      perspective,
      backendOverride,
      domain: "commerce",
    }),
  });
};

export const createCommerceWriteClient = ({ backendOverride = "" } = {}) => {
  const policy = resolveSupabaseRuntimePolicy();
  const backend = normalizeBackend(
    backendOverride,
    normalizeBackend(policy.commercePrimaryBackend, "supabase")
  );
  return createCommerceStore({
    backend,
    cutoverGeneration: policy.commerceFailoverGeneration,
    client: createDocumentWriteClient({
      backendOverride,
      domain: "commerce",
    }),
  });
};

export const createOptionalRefWriteClient = () =>
  createOptionalDocumentWriteClient();

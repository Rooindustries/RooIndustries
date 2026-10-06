import { createSupabaseDocumentClient } from "../supabase/documentClient.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import envValue from "../supabase/envValue.cjs";
const { resolveStoreBackend } = envValue;
export const createDocumentReadClient = ({ env = process.env, supabaseClient, backendOverride, domain = "global", documentTypes, allowLegacyFallback } = {}) => {
  resolveStoreBackend(backendOverride);
  const policy = resolveSupabaseRuntimePolicy(env);
  return createSupabaseDocumentClient({ shadowClient: supabaseClient || createSupabaseAdminClient({env}), commerceOnly: domain === "commerce", documentTypes, allowLegacyFallback, cutoverGeneration: policy.commerceFailoverGeneration });
};
export const createDocumentWriteClient = createDocumentReadClient;
export const createDataClient = (options = {}, connection = {}) => createDocumentWriteClient({...options,...connection});
export const createOptionalDocumentWriteClient = (options = {}) => {
  try { return createDocumentWriteClient(options); } catch { return null; }
};

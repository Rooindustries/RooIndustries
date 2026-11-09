import {createSupabaseAdminClient} from "./adminClient.js";
import {requireRpcData, requireShadowDocumentArray} from "./shadowStore.js";

export const fetchShadowDocuments = async ({
  documentTypes = null,
  ids = null,
  filters = [],
  limit = 500,
  allowLegacyFallback = true,
  client = createSupabaseAdminClient(),
} = {}) => {
  const targeted = await client.rpc("roo_fetch_shadow_documents_targeted", {
    p_document_types:
      Array.isArray(documentTypes) && documentTypes.length > 0
        ? documentTypes
        : null,
    p_ids: Array.isArray(ids) && ids.length > 0 ? ids : null,
    p_filters: Array.isArray(filters) ? filters : [],
    p_limit: Math.max(1, Math.min(1000, Number(limit) || 500)),
  });
  let data;
  if (
    targeted?.error &&
    ["42883", "PGRST202"].includes(String(targeted.error.code || ""))
  ) {
    if (!allowLegacyFallback) {
      const failure = new Error("Targeted commerce reads are unavailable.");
      failure.code = "COMMERCE_TARGETED_READ_UNAVAILABLE";
      failure.status = 503;
      failure.statusCode = 503;
      throw failure;
    }
    data = requireRpcData(
      await client.rpc("roo_fetch_shadow_documents", {
        p_document_types:
          Array.isArray(documentTypes) && documentTypes.length > 0
            ? documentTypes
            : null,
      }),
      "shadow fetch"
    );
  } else {
    data = requireRpcData(targeted, "targeted shadow fetch");
  }
  return requireShadowDocumentArray(data);
};

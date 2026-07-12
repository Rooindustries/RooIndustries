import { createDocumentWriteClient } from "../data/documentClient.js";
import { logSafeError } from "../safeErrorLog.js";

export const flushDeferredCommerceMirror = async () => {
  try {
    const client = createDocumentWriteClient({
      backendOverride: "supabase",
      domain: "commerce",
    });
    if (typeof client?.flushCommerceMirror !== "function") {
      return { supported: false, attempted: 0, mirrored: 0, failed: 0 };
    }
    return await client.flushCommerceMirror({
      failClosed: false,
      limit: 25,
      maxBatches: 2,
    });
  } catch (error) {
    logSafeError("Deferred commerce mirror flush failed", error);
    return { supported: false, attempted: 0, mirrored: 0, failed: 1 };
  }
};

import { createDocumentWriteClient } from "../data/documentClient.js";
import { logSafeError } from "../safeErrorLog.js";
import { resolveSupabaseRuntimePolicy } from "./runtime.js";
import sanityConfiguration from "./sanityConfiguration.cjs";
import { logSanityMirrorEvent } from "./mirrorObservability.js";

const { inspectSanityConfiguration } = sanityConfiguration;

export const isDeferredCommerceMirrorEnabled = (env = process.env) => {
  try {
    return (
      resolveSupabaseRuntimePolicy(env).commercePrimaryBackend === "supabase" &&
      inspectSanityConfiguration(env).writeConfigured
    );
  } catch {
    return false;
  }
};

const wait = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));

const readMirrorBacklog = async (client) => {
  if (typeof client?.shadowClient?.rpc !== "function") return null;
  const { data, error } = await client.shadowClient.rpc(
    "roo_commerce_mirror_backlog"
  );
  if (error) return null;
  return data && typeof data === "object" ? data : null;
};

export const flushDeferredCommerceMirror = async ({
  maxAttempts = 4,
  retryDelayMs = 350,
} = {}) => {
  if (!isDeferredCommerceMirrorEnabled()) {
    return {
      supported: false,
      skipped: true,
      reason: "sanity_unconfigured_or_inactive",
      attempted: 0,
      mirrored: 0,
      failed: 0,
    };
  }
  try {
    const client = createDocumentWriteClient({
      backendOverride: "supabase",
      domain: "commerce",
    });
    if (typeof client?.flushCommerceMirror !== "function") {
      return { supported: false, attempted: 0, mirrored: 0, failed: 0 };
    }
    const attempts = Math.max(1, Math.min(6, Number(maxAttempts) || 4));
    const summary = {
      supported: true,
      attempted: 0,
      mirrored: 0,
      failed: 0,
      pending: 0,
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await client.flushCommerceMirror({
        limit: 25,
        maxBatches: 2,
      });
      summary.supported = result?.supported !== false;
      summary.attempted += Number(result?.attempted || 0);
      summary.mirrored += Number(result?.mirrored || 0);
      summary.failed += Number(result?.failed || 0);
      const backlog = await readMirrorBacklog(client);
      summary.pending = Math.max(0, Number(backlog?.pending || 0));
      if (!summary.supported || !backlog || summary.pending < 1) return summary;
      if (attempt + 1 < attempts) await wait(retryDelayMs);
    }
    return summary;
  } catch (error) {
    logSafeError("Deferred commerce mirror flush failed", error);
    logSanityMirrorEvent({
      event: "sanity_mirror_lag",
      reason: "deferred_flush_failed",
      domain: "commerce",
    });
    return { supported: false, attempted: 0, mirrored: 0, failed: 1 };
  }
};

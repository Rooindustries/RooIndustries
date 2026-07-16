import { runLegacyApiHandler } from "../../../../../src/lib/nextApiAdapter";
import webhookPayPal from "../../../../../src/server/api/payment/webhookPayPal.js";
import { after } from "next/server";
import {
  flushDeferredCommerceMirror,
  isDeferredCommerceMirrorEnabled,
} from "../../../../../src/server/supabase/deferredCommerceMirror";
import { logSanityMirrorEvent } from "../../../../../src/server/supabase/mirrorObservability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (request) => {
  const response = await runLegacyApiHandler({
    request,
    handler: webhookPayPal,
    methodOverride: "POST",
  });
  if (response.ok && isDeferredCommerceMirrorEnabled()) {
    try {
      after(() => flushDeferredCommerceMirror());
    } catch {
      logSanityMirrorEvent({
        event: "sanity_mirror_lag",
        reason: "deferred_schedule_failed",
        domain: "commerce",
      });
    }
  }
  return response;
};

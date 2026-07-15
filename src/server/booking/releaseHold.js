import { createDataClient as createClient } from "../data/documentClient.js";
import crypto from "crypto";
import { verifyHoldToken } from "./holdToken.js";
import { selectHoldAuthority } from "./holdAuthority.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { getClientAddress, requireRateLimit } from "../api/ref/rateLimit.js";
import { logSafeError } from "../safeErrorLog.js";

const createReleaseClient = (backendOverride) =>
  createClient(
    {
      projectId: process.env.SANITY_PROJECT_ID,
      dataset: process.env.SANITY_DATASET || "production",
      apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
      token: process.env.SANITY_WRITE_TOKEN,
      useCdn: false,
    },
    { backendOverride, domain: "commerce" }
  );

export default async function handler(req, res) {
  if (String(req?.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { holdId, holdToken } = req.body || {};
  const clientAddress = getClientAddress(req);
  if (
    !(await requireRateLimit(res, {
      key: `release-hold:${clientAddress}`,
      max: 25,
      message: "Too many hold release requests. Please try again later.",
    }))
  ) {
    return;
  }
  if (!holdId || !holdToken) {
    return res.status(400).json({ ok: false, message: "Missing hold credentials" });
  }

  const tokenPayload = verifyHoldToken({
    token: holdToken,
    holdId,
    ignoreExpiry: true,
  });
  const policy = resolveSupabaseRuntimePolicy();
  const backend = selectHoldAuthority({
    tokenPayload,
    fallbackBackend: policy.commercePrimaryBackend,
    policy,
  });
  const client = createReleaseClient(backend);

  try {
    const hold = await client.fetch(`*[_type == "slotHold" && _id == $id][0]`, {
      id: holdId,
    });
    if (!hold) {
      return res.status(404).json({ ok: false, message: "Hold not found" });
    }

    const validToken = verifyHoldToken({
      token: holdToken,
      holdId,
      startTimeUTC: hold.startTimeUTC,
      holdNonce: hold.holdNonce || "",
      backend: hold.backendOwner === "supabase" ? "supabase" : "sanity",
      cutoverGeneration: Number(hold.cutoverGeneration || 0),
    });
    if (!validToken) {
      return res.status(403).json({ ok: false, message: "Invalid hold token" });
    }
    if (String(hold.phase || "").trim().toLowerCase() === "payment_pending") {
      return res.status(409).json({
        ok: false,
        message: "This hold belongs to an active payment session.",
      });
    }

    const releasedAt = new Date().toISOString();
    let patch = client.patch(holdId);
    if (hold._rev && typeof patch.ifRevisionId === "function") {
      patch = patch.ifRevisionId(hold._rev);
    }
    await patch
      .set({
        phase: "released",
        releasedAt,
        expiresAt: releasedAt,
        holdNonce: crypto.randomUUID(),
      })
      .commit(backend === "supabase" ? { deferMirror: true } : {});
    return res.status(200).json({ ok: true, message: "Hold released" });
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) === 409) {
      return res.status(409).json({
        ok: false,
        message: "Hold changed before it could be released",
      });
    }
    logSafeError("Slot hold release failed", error);
    return res.status(500).json({ ok: false, message: "Failed to release hold" });
  }
}

import { createDataClient as createClient } from "../../data/documentClient.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { resolveSupabaseCreatorRegistrationConflicts } from "../../supabase/accounts.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";

const sanityConfig = {
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_READ_TOKEN || process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  perspective: "published",
};
const readClient = createClient(sanityConfig, { domain: "commerce" });
const registrationReadClient = createClient(sanityConfig, {
  domain: "global",
  allowLegacyFallback: false,
});

export default async function handler(req, res) {
  if (String(req?.method || "").toUpperCase() !== "GET") {
    res.setHeader?.("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const raw = (req.query.code || "").trim();
    const code = raw.toLowerCase();
    const clientAddress = getClientAddress(req);

    if (
      !(await requireRateLimit(res, {
        key: `validate-referral:${clientAddress}`,
        max: 25,
        message: "Too many referral validation requests. Please try again later.",
      }))
    ) {
      return;
    }

    if (!readClient.config().projectId || !readClient.config().dataset) {
      logSafeError("Referral storage configuration missing", {
        code: "sanity_config_missing",
        status: 500,
      });
      return res.status(500).json({ ok: false, error: "Server misconfigured" });
    }

    if (!code)
      return res.status(400).json({ ok: false, error: "Missing code" });

    if (req.query.purpose === "registration") {
      if (!/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/.test(code)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid referral code",
        });
      }
      const policy = resolveSupabaseRuntimePolicy();
      const supabaseConflicts =
        policy.shadowWritesEnabled || policy.primaryBackend === "supabase"
          ? resolveSupabaseCreatorRegistrationConflicts({ referralCode: code })
          : Promise.resolve({ referralCodeReserved: false });
      let existingReferral;
      let existingCoupon;
      let conflicts;
      try {
        [existingReferral, existingCoupon, conflicts] = await Promise.all([
          registrationReadClient.fetch(
            `*[_type == "referral" && lower(slug.current) == $code][0]{_id,registrationStatus}`,
            { code }
          ),
          readClient.fetch(
            `*[_type == "coupon" && lower(code) == $code][0]{_id}`,
            { code }
          ),
          supabaseConflicts,
        ]);
      } catch (error) {
        logSafeError("Referral registration availability lookup failed", error);
        return res.status(503).json({
          ok: false,
          error: "Referral code availability is temporarily unavailable.",
          reason: "unavailable",
        });
      }
      const pendingRegistration =
        existingReferral?.registrationStatus === "pending_email";
      if (
        (existingReferral?._id && !pendingRegistration) ||
        existingCoupon?._id ||
        (conflicts.referralCodeReserved && !pendingRegistration)
      ) {
        return res.status(200).json({
          ok: false,
          error: "Referral code already taken",
          reason: "reserved",
        });
      }
      return res.status(200).json({
        ok: false,
        error: "Not found",
        reason: "available",
      });
    }

    // Public checkout projection. Creator details stay behind authenticated routes.
    const ref = await readClient.fetch(
      `*[_type == "referral" && registrationStatus != "pending_email" && slug.current == $code][0]{
        "code": slug.current,
        currentDiscountPercent
      }`,
      { code }
    );

    if (!ref) {
      return res.status(200).json({
        ok: false,
        error: "Not found",
        reason: "not_found",
      });
    }

    const discountPercent = Number(ref.currentDiscountPercent);
    return res.status(200).json({
      ok: true,
      active: true,
      eligible: true,
      referral: {
        code: String(ref.code || code).trim(),
        currentDiscountPercent: Number.isFinite(discountPercent)
          ? Math.min(100, Math.max(0, discountPercent))
          : 0,
      },
    });
  } catch (e) {
    logSafeError("Referral validation failed", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

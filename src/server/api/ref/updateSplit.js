import { createDataClient as createClient } from "../../data/documentClient.js";
import { requireReferralSession } from "./auth.js";
import { logSafeError } from "../../safeErrorLog.js";
import { assertCommerceWriteAllowed } from "../../supabase/commerceControl.js";

const client = createClient(
  {
    projectId: process.env.SANITY_PROJECT_ID,
    dataset: process.env.SANITY_DATASET,
    apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
    token: process.env.SANITY_WRITE_TOKEN,
    useCdn: false,
  },
  { domain: "commerce" }
);

const parsePercent = (value) => {
  const text = String(value ?? "").trim();
  if (!/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/.test(text)) {
    return null;
  }
  const basisPoints = Math.round(Number(text) * 100);
  return basisPoints >= 0 && basisPoints <= 10000 ? basisPoints : null;
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const session = await requireReferralSession(req, res);
    if (!session) return;
    const id = session.referralId;
    const { commissionPercent, discountPercent } = req.body || {};
    const nextCommissionBasisPoints = parsePercent(commissionPercent);
    const nextDiscountBasisPoints = parsePercent(discountPercent);

    if (
      nextCommissionBasisPoints === null ||
      nextDiscountBasisPoints === null
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "Percentages must be between 0 and 100 with at most two decimal places",
        });
    }

    await assertCommerceWriteAllowed();

    const creator = await client.fetch(
      `*[_type == "referral" && _id == $id][0]{
        maxCommissionPercent,
        successfulReferrals,
        bypassUnlock,
        isFirstTime
      }`,
      { id }
    );

    if (!creator) {
      return res.status(404).json({ ok: false, error: "Creator not found" });
    }

    const configuredMax = Number(creator.maxCommissionPercent);
    const max = Number.isFinite(configuredMax) && configuredMax >= 0
      ? Math.min(configuredMax, 100)
      : 15;
    const maxBasisPoints = Math.round(max * 100);
    const successfulReferrals = creator.successfulReferrals ?? 0;
    const bypassUnlock = creator.bypassUnlock === true;
    const unlocked = successfulReferrals >= 5 || bypassUnlock;

    if (!unlocked) {
      return res.status(403).json({
        ok: false,
        error: "Five successful referrals are required before changing this split",
      });
    }

    if (nextCommissionBasisPoints + nextDiscountBasisPoints > maxBasisPoints) {
      return res.status(400).json({
        ok: false,
        error: `Total % cannot exceed ${max}`,
      });
    }

    const nextCommission = nextCommissionBasisPoints / 100;
    const nextDiscount = nextDiscountBasisPoints / 100;

    let patch = client.patch(id).set({
      currentCommissionPercent: nextCommission,
      currentDiscountPercent: nextDiscount,
    });

    if (unlocked && creator.isFirstTime) {
      patch = patch.set({ isFirstTime: false });
    }

    await patch.commit();

    return res.json({ ok: true });
  } catch (err) {
    logSafeError("Referral split update failed", err);
    const status = Number(err?.statusCode || err?.status || 500);
    return res.status(status).json({
      ok: false,
      error:
        status === 503
          ? "Commerce changes are temporarily unavailable."
          : "Server error",
    });
  }
}

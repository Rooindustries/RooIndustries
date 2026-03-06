import { createClient } from "@sanity/client";
import { requireReferralSession } from "./auth.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const session = requireReferralSession(req, res);
    if (!session) return;
    const id = session.referralId;
    const { commissionPercent, discountPercent } = req.body || {};
    const nextCommission = Number(commissionPercent);
    const nextDiscount = Number(discountPercent);

    if (
      !Number.isFinite(nextCommission) ||
      !Number.isFinite(nextDiscount) ||
      nextCommission < 0 ||
      nextDiscount < 0
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid commission/discount values" });
    }

    // Fetch current data for this creator
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

    const max = creator.maxCommissionPercent;
    const successfulReferrals = creator.successfulReferrals ?? 0;
    const bypassUnlock = creator.bypassUnlock === true;

    // Same validation as before
    if (nextCommission + nextDiscount > max) {
      return res.status(400).json({
        ok: false,
        error: `Total % cannot exceed ${max}`,
      });
    }

    const unlocked = successfulReferrals >= 5 || bypassUnlock;

    // Build patch
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
    console.error("UPDATESPLIT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

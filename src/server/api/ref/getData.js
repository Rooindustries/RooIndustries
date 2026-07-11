import { createDataClient as createClient } from "../../data/documentClient.js";
import { requireReferralSession } from "./auth.js";
import { logSafeError } from "../../safeErrorLog.js";

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_READ_TOKEN || process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  perspective: "published",
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const session = requireReferralSession(req, res);
    if (!session) return;
    const id = session.referralId;

    const referral = await readClient.fetch(
      `*[_type == "referral" && _id == $id][0]{
        _id,
        name,
        slug,
        creatorEmail,
        currentCommissionPercent,
        currentDiscountPercent,
        maxCommissionPercent,
        successfulReferrals,
        isFirstTime,
        bypassUnlock
      }`,
      { id }
    );

    if (!referral) {
      return res.status(404).json({ ok: false, error: "Referral not found" });
    }

    return res.status(200).json({ ok: true, referral });
  } catch (err) {
    logSafeError("Referral dashboard read failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

import { createClient } from "@sanity/client";

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  useCdn: false,
  perspective: "published",
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing creator id" });
    }

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

    console.log("GETDATA REFERRAL:", referral);

    if (!referral) {
      return res.status(404).json({ ok: false, error: "Referral not found" });
    }

    return res.status(200).json({ ok: true, referral });
  } catch (err) {
    console.error("💥 getData ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

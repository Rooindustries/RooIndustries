import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { id, commissionPercent, discountPercent } = req.body;

    console.log("💾 Update request:", req.body);

    if (!id)
      return res.status(400).json({ ok: false, error: "Missing creator ID" });

    // Fetch current max limit
    const creator = await client.fetch(
      `*[_type == "referral" && _id == $id][0]{
        maxCommissionPercent
      }`,
      { id }
    );

    if (!creator)
      return res.status(404).json({ ok: false, error: "Creator not found" });

    const max = creator.maxCommissionPercent;

    // Validate the sum
    if (commissionPercent + discountPercent > max) {
      return res.status(400).json({
        ok: false,
        error: `Total % cannot exceed ${max}`,
      });
    }

    // Update sanity doc
    await client
      .patch(id)
      .set({
        currentCommissionPercent: commissionPercent,
        currentDiscountPercent: discountPercent,
      })
      .commit();

    return res.json({ ok: true });
  } catch (err) {
    console.error("UPDATESPLIT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

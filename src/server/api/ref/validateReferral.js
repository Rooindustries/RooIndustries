import { createClient } from "@sanity/client";

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  useCdn: false,
  perspective: "published",
});

export default async function handler(req, res) {
  try {
    const raw = (req.query.code || "").trim();
    const code = raw.toLowerCase();

    if (!readClient.config().projectId || !readClient.config().dataset) {
      console.error("Sanity env missing:", {
        projectId: readClient.config().projectId,
        dataset: readClient.config().dataset,
      });
      return res.status(500).json({ ok: false, error: "Server misconfigured" });
    }

    if (!code)
      return res.status(400).json({ ok: false, error: "Missing code" });

    // return fields used in the frontend/payment logic
    const ref = await readClient.fetch(
      `*[_type == "referral" && slug.current == $code][0]{
        _id,
        name,
        "code": slug.current,
        currentCommissionPercent,
        currentDiscountPercent,
        isFirstTime
      }`,
      { code }
    );

    if (!ref) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    return res.status(200).json({ ok: true, referral: ref });
  } catch (e) {
    console.error("Error validating referral:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

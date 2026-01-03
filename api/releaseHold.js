import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false, // Important: Ensures we delete from the real dataset immediately
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { holdId } = req.body || {};

  if (!holdId) {
    return res.status(400).json({ message: "Missing holdId" });
  }

  try {
    // Attempt to delete the document
    await client.delete(holdId);
    return res.status(200).json({ ok: true, message: "Hold released" });
  } catch (err) {
    console.error("Error releasing hold:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to release hold" });
  }
}

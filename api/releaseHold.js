import { createClient } from "@sanity/client";
import { verifyHoldToken } from "./holdToken";

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

  const { holdId, holdToken } = req.body || {};

  if (!holdId || !holdToken) {
    return res.status(400).json({ ok: false, message: "Missing hold credentials" });
  }

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
    });

    if (!validToken) {
      return res.status(403).json({ ok: false, message: "Invalid hold token" });
    }

    await client.delete(holdId);
    return res.status(200).json({ ok: true, message: "Hold released" });
  } catch (err) {
    console.error("Error releasing hold:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to release hold" });
  }
}

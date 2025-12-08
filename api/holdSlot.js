import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { hostDate, hostTime, startTimeUTC, packageTitle } = req.body || {};

    if (!hostDate || !hostTime || !startTimeUTC) {
      return res.status(400).json({
        ok: false,
        message: "Missing hostDate, hostTime, or startTimeUTC.",
      });
    }

    // 1) Already booked?
    const existingBooking = await client.fetch(
      `*[_type == "booking" && hostDate == $date && hostTime == $time][0]`,
      { date: hostDate, time: hostTime }
    );

    if (existingBooking) {
      return res
        .status(409)
        .json({ ok: false, message: "This slot is already booked." });
    }

    // 2) Active hold exists?
    const existingHold = await client.fetch(
      `*[_type == "slotHold" 
          && hostDate == $date 
          && hostTime == $time 
          && expiresAt > now()
        ][0]`,
      { date: hostDate, time: hostTime }
    );

    if (existingHold) {
      return res
        .status(409)
        .json({ ok: false, message: "This slot is currently reserved." });
    }

    // 3) Create 15-minute hold
    const now = Date.now();
    const expiresAt = new Date(now + 15 * 60 * 1000).toISOString();

    const created = await client.create({
      _type: "slotHold",
      hostDate,
      hostTime,
      startTimeUTC,
      packageTitle: packageTitle || "",
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      holdId: created._id,
      expiresAt,
    });
  } catch (err) {
    console.error("Error in /api/holdSlot:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to reserve this slot. Please try again.",
    });
  }
}

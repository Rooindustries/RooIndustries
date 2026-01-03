// api/holdSlot.js
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
    const { hostDate, hostTime, startTimeUTC, packageTitle, previousHoldId } =
      req.body || {};

    if (!hostDate || !hostTime || !startTimeUTC) {
      return res.status(400).json({
        ok: false,
        message: "Missing hostDate, hostTime, or startTimeUTC.",
      });
    }

    // 1) Is the slot already booked? (Permanent booking)
    const existingBooking = await client.fetch(
      `*[_type == "booking" && hostDate == $date && hostTime == $time][0]`,
      { date: hostDate, time: hostTime }
    );

    if (existingBooking) {
      return res
        .status(409)
        .json({ ok: false, message: "This slot is already booked." });
    }

    // 2) Is it held by someone else?
    const existingHold = await client.fetch(
      `*[_type == "slotHold" 
          && hostDate == $date 
          && hostTime == $time 
          && expiresAt > now()
        ][0]`,
      { date: hostDate, time: hostTime }
    );

    // If it's held, and the holder isn't the one trying to switch (i.e., it's not the previous hold)
    if (existingHold && existingHold._id !== previousHoldId) {
      return res
        .status(409)
        .json({
          ok: false,
          message: "This slot is currently reserved by someone else.",
        });
    }

    // 3) Create new 15-minute hold
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

    // 4) Clean up previous hold (Unreserve the old one)
    if (previousHoldId) {
      try {
        // Ensure we don't delete the brand new hold we just created if IDs somehow matched
        if (previousHoldId !== created._id) {
          await client.delete(previousHoldId);
        }
      } catch {
        // Don't fail the request.
      }
    }

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

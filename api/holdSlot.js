// api/holdSlot.js
import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const OWNER_TZ_NAME = "Asia/Kolkata";

const formatOwnerDateLabel = (utcDate, timeZone = OWNER_TZ_NAME) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
    })
      .formatToParts(utcDate)
      .reduce((acc, cur) => {
        acc[cur.type] = cur.value;
        return acc;
      }, {});

    const day = parts.day || "";
    const weekday = parts.weekday || "";
    const month = parts.month || "";
    const year = parts.year || "";

    return `${weekday} ${month} ${day} ${year}`.trim();
  } catch (err) {
    console.error("Failed to format owner date label", err);
    return "";
  }
};

const formatOwnerTimeLabel = (utcDate, timeZone = OWNER_TZ_NAME) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(utcDate);
  } catch (err) {
    console.error("Failed to format owner time label", err);
    return "";
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { startTimeUTC, packageTitle, previousHoldId } =
      req.body || {};

    if (!startTimeUTC) {
      return res.status(400).json({
        ok: false,
        message: "Missing startTimeUTC.",
      });
    }

    const utcDate = new Date(startTimeUTC);
    if (!Number.isFinite(utcDate.getTime())) {
      return res.status(400).json({
        ok: false,
        message: "Invalid startTimeUTC.",
      });
    }

    const hostDate = formatOwnerDateLabel(utcDate);
    const hostTime = formatOwnerTimeLabel(utcDate);

    if (!hostDate || !hostTime) {
      return res.status(400).json({
        ok: false,
        message: "Invalid owner date/time.",
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

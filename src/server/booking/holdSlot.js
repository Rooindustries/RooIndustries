// api/holdSlot.js
import { createClient } from "@sanity/client";
import crypto from "crypto";
import { issueHoldToken, verifyHoldToken } from "./holdToken.js";
import { buildSlotHoldId } from "./slotIdentity.js";
import { getClientAddress, requireRateLimit } from "../api/ref/rateLimit.js";

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
    const { startTimeUTC, packageTitle, previousHoldId, previousHoldToken } =
      req.body || {};
    const clientAddress = getClientAddress(req);
    const rateLimitKey = [
      "hold-slot",
      clientAddress,
      String(startTimeUTC || "").trim().toLowerCase(),
      String(previousHoldId || "").trim().toLowerCase(),
    ].join(":");

    if (
      !requireRateLimit(res, {
        key: rateLimitKey,
        max: 20,
        message: "Too many slot hold requests. Please try again later.",
      })
    ) {
      return;
    }

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
    const normalizedStartTimeUTC = utcDate.toISOString();
    const holdId = buildSlotHoldId(normalizedStartTimeUTC);
    if (!holdId) {
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

    const now = Date.now();
    const fetchExistingHold = () =>
      client.fetch(`*[_type == "slotHold" && _id == $id][0]`, { id: holdId });

    let existingHold = await fetchExistingHold();
    if (
      existingHold?.expiresAt &&
      new Date(existingHold.expiresAt) <= new Date(now)
    ) {
      await client.delete(holdId).catch(() => {});
      existingHold = null;
    }

    // If the same holder is refreshing the same slot, renew it in place.
    if (existingHold && previousHoldId === holdId && previousHoldToken) {
      const validPreviousToken = verifyHoldToken({
        token: previousHoldToken,
        holdId,
        startTimeUTC: existingHold.startTimeUTC || normalizedStartTimeUTC,
        holdNonce: existingHold.holdNonce || "",
      });

      if (validPreviousToken) {
        const expiresAt = new Date(now + 15 * 60 * 1000).toISOString();
        const holdNonce = crypto.randomUUID();
        await client
          .patch(holdId)
          .set({
            packageTitle: packageTitle || "",
            expiresAt,
            startTimeUTC: normalizedStartTimeUTC,
            holdNonce,
          })
          .commit();

        const holdToken = issueHoldToken({
          holdId,
          startTimeUTC: normalizedStartTimeUTC,
          expiresAt,
          holdNonce,
        });

        return res.status(200).json({
          ok: true,
          holdId,
          holdToken,
          expiresAt,
        });
      }
    }

    if (existingHold) {
      return res.status(409).json({
        ok: false,
        message: "This slot is currently reserved by someone else.",
      });
    }

    // 3) Create new 15-minute hold
    const expiresAt = new Date(now + 15 * 60 * 1000).toISOString();
    const holdNonce = crypto.randomUUID();

    const createHold = () =>
      client.create({
        _id: holdId,
        _type: "slotHold",
        hostDate,
        hostTime,
        startTimeUTC: normalizedStartTimeUTC,
        packageTitle: packageTitle || "",
        expiresAt,
        holdNonce,
      });

    let created;
    try {
      created = await createHold();
    } catch (createError) {
      const statusCode =
        Number(createError?.statusCode || createError?.status || 0) || 0;
      if (statusCode === 409) {
        const activeHold = await fetchExistingHold();
        const activeHoldExpired =
          !!activeHold?.expiresAt && new Date(activeHold.expiresAt) <= new Date();

        if (activeHoldExpired) {
          await client.delete(holdId).catch(() => {});
          try {
            created = await createHold();
          } catch (retryError) {
            const retryStatusCode =
              Number(retryError?.statusCode || retryError?.status || 0) || 0;
            if (retryStatusCode !== 409) throw retryError;
          }
        }

        if (created) {
          // reclaimed expired hold successfully
        } else if (
          activeHold?.expiresAt &&
          new Date(activeHold.expiresAt) > new Date()
        ) {
          return res.status(409).json({
            ok: false,
            message: "This slot is currently reserved by someone else.",
          });
        } else {
          return res.status(409).json({
            ok: false,
            message: "This slot is currently being refreshed. Please try again.",
          });
        }
      }
      if (!created) {
        throw createError;
      }
    }

    let holdToken = "";
    try {
      holdToken = issueHoldToken({
        holdId: created._id,
        startTimeUTC: normalizedStartTimeUTC,
        expiresAt,
        holdNonce,
      });
    } catch (tokenError) {
      console.error("Failed to issue hold token:", tokenError);
      await client.delete(created._id).catch(() => {});
      return res.status(500).json({
        ok: false,
        message: "Server misconfigured for hold security.",
      });
    }

    // 4) Clean up previous hold (Unreserve the old one)
    if (previousHoldId && previousHoldId !== created._id) {
      try {
        const previousHold = await client.fetch(
          `*[_type == "slotHold" && _id == $id][0]`,
          { id: previousHoldId }
        );
        const validPreviousToken = verifyHoldToken({
          token: previousHoldToken,
          holdId: previousHoldId,
          startTimeUTC: previousHold?.startTimeUTC,
          holdNonce: previousHold?.holdNonce || "",
        });
        if (
          validPreviousToken &&
          previousHoldId !== created._id
        ) {
          await client.delete(previousHoldId);
        }
      } catch {
        // Don't fail the request.
      }
    }

    return res.status(200).json({
      ok: true,
      holdId: created._id,
      holdToken,
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

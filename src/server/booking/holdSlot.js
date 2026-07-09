import { createClient } from "@sanity/client";
import crypto from "crypto";
import { issueHoldToken, verifyHoldToken } from "./holdToken.js";
import {
  buildBookingSlotId,
  buildSlotHoldId,
  isExactWholeMinute,
  normalizeStartTimeUTC,
} from "./slotIdentity.js";
import {
  getBookingSettings,
  isBookingBlockingStatus,
  isSlotAllowedForPackage,
} from "./slotPolicy.js";
import { getClientAddress, requireRateLimit } from "../api/ref/rateLimit.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export const HOLD_DURATION_MS = 20 * 60 * 1000;

const isConflict = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const isHoldActive = (hold, now = Date.now()) => {
  const phase = String(hold?.phase || "active").trim().toLowerCase();
  const expiresAt = new Date(hold?.expiresAt || "").getTime();
  return (
    phase !== "released" &&
    phase !== "consumed" &&
    Number.isFinite(expiresAt) &&
    expiresAt > now
  );
};

const patchAtRevision = async (document, values) => {
  let patch = client.patch(document._id);
  if (document?._rev && typeof patch.ifRevisionId === "function") {
    patch = patch.ifRevisionId(document._rev);
  }
  return patch.set(values).commit();
};

const issueResponse = ({ hold, startTimeUTC, expiresAt, holdNonce, res }) => {
  const holdToken = issueHoldToken({
    holdId: hold._id,
    startTimeUTC,
    expiresAt,
    holdNonce,
  });
  return res.status(200).json({
    ok: true,
    holdId: hold._id,
    holdToken,
    expiresAt,
  });
};

const releasePreviousHold = async ({
  previousHoldId,
  previousHoldToken,
  currentHoldId,
}) => {
  if (!previousHoldId || previousHoldId === currentHoldId || !previousHoldToken) {
    return;
  }

  try {
    const previousHold = await client.fetch(
      `*[_type == "slotHold" && _id == $id][0]`,
      { id: previousHoldId }
    );
    if (!previousHold?._id) return;
    const validToken = verifyHoldToken({
      token: previousHoldToken,
      holdId: previousHoldId,
      startTimeUTC: previousHold.startTimeUTC,
      holdNonce: previousHold.holdNonce || "",
    });
    if (!validToken) return;
    const releasedAt = new Date().toISOString();
    await patchAtRevision(previousHold, {
      phase: "released",
      releasedAt,
      expiresAt: releasedAt,
      holdNonce: crypto.randomUUID(),
    });
  } catch {
    // Moving to a new slot must not fail because a stale previous hold changed.
  }
};

export default async function handler(req, res) {
  if (String(req?.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const { startTimeUTC, packageTitle, previousHoldId, previousHoldToken } =
    req.body || {};
  const clientAddress = getClientAddress(req);
  if (
    !requireRateLimit(res, {
      key: `hold-slot:${clientAddress}`,
      max: 20,
      message: "Too many slot hold requests. Please try again later.",
    })
  ) {
    return;
  }

  const normalizedStartTimeUTC = normalizeStartTimeUTC(startTimeUTC);
  if (!normalizedStartTimeUTC || !isExactWholeMinute(normalizedStartTimeUTC)) {
    return res.status(400).json({
      ok: false,
      message: "startTimeUTC must be an exact configured minute.",
    });
  }

  try {
    const settings = await getBookingSettings({ client });
    const slot = isSlotAllowedForPackage({
      settings,
      packageTitle,
      startTimeUTC: normalizedStartTimeUTC,
    });
    if (!slot.allowed) {
      return res.status(400).json({
        ok: false,
        message: "This time is not available for the selected package.",
      });
    }

    const holdId = buildSlotHoldId(normalizedStartTimeUTC);
    const slotLockId = buildBookingSlotId(normalizedStartTimeUTC);
    const [slotLock, matchingBookings] = await Promise.all([
      client.fetch(`*[_type == "bookingSlot" && _id == $id][0]`, {
        id: slotLockId,
      }),
      client.fetch(
        `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status}`,
        { startTimeUTC: normalizedStartTimeUTC }
      ),
    ]);
    const activeLock = slotLock && slotLock.status !== "released";
    const activeLegacyBooking = (Array.isArray(matchingBookings)
      ? matchingBookings
      : matchingBookings
        ? [matchingBookings]
        : []
    ).some((booking) => isBookingBlockingStatus(booking?.status));
    if (activeLock || activeLegacyBooking) {
      return res.status(409).json({
        ok: false,
        message: "This slot is already booked.",
      });
    }

    const now = Date.now();
    const expiresAt = new Date(now + HOLD_DURATION_MS).toISOString();
    const fetchHold = () =>
      client.fetch(`*[_type == "slotHold" && _id == $id][0]`, { id: holdId });
    const existingHold = await fetchHold();

    if (isHoldActive(existingHold, now)) {
      const mayRefresh =
        previousHoldId === holdId &&
        verifyHoldToken({
          token: previousHoldToken,
          holdId,
          startTimeUTC: existingHold.startTimeUTC || normalizedStartTimeUTC,
          holdNonce: existingHold.holdNonce || "",
        });
      if (!mayRefresh) {
        return res.status(409).json({
          ok: false,
          message: "This slot is currently reserved by someone else.",
        });
      }

      const holdNonce = crypto.randomUUID();
      try {
        const refreshed = await patchAtRevision(existingHold, {
          packageTitle: String(packageTitle || "").trim(),
          startTimeUTC: normalizedStartTimeUTC,
          hostDate: slot.hostDate,
          hostTime: slot.hostTime,
          expiresAt,
          phase: "active",
          releasedAt: "",
          consumedAt: "",
          paymentRecordId: "",
          holdNonce,
        });
        return issueResponse({
          hold: refreshed || existingHold,
          startTimeUTC: normalizedStartTimeUTC,
          expiresAt,
          holdNonce,
          res,
        });
      } catch (error) {
        if (isConflict(error)) {
          return res.status(409).json({
            ok: false,
            message: "This slot changed while it was being refreshed.",
          });
        }
        throw error;
      }
    }

    const holdNonce = crypto.randomUUID();
    const holdValues = {
      _id: holdId,
      _type: "slotHold",
      hostDate: slot.hostDate,
      hostTime: slot.hostTime,
      startTimeUTC: normalizedStartTimeUTC,
      packageTitle: String(packageTitle || "").trim(),
      expiresAt,
      holdNonce,
      phase: "active",
      releasedAt: "",
      consumedAt: "",
      paymentRecordId: "",
    };

    let created;
    try {
      created = existingHold
        ? await patchAtRevision(existingHold, holdValues)
        : await client.create(holdValues);
    } catch (error) {
      if (isConflict(error)) {
        return res.status(409).json({
          ok: false,
          message: "This slot is currently being reserved. Please try again.",
        });
      }
      throw error;
    }

    try {
      const response = issueResponse({
        hold: created || holdValues,
        startTimeUTC: normalizedStartTimeUTC,
        expiresAt,
        holdNonce,
        res,
      });
      await releasePreviousHold({
        previousHoldId,
        previousHoldToken,
        currentHoldId: holdId,
      });
      return response;
    } catch (error) {
      const failedAt = new Date().toISOString();
      await patchAtRevision(created || holdValues, {
        phase: "released",
        releasedAt: failedAt,
        expiresAt: failedAt,
        holdNonce: crypto.randomUUID(),
      }).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error("Error in /api/holdSlot:", error);
    return res.status(500).json({
      ok: false,
      message: "Failed to reserve this slot. Please try again.",
    });
  }
}

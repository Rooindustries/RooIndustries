import { createRefReadClient } from "../api/ref/sanity.js";
import {
  filterActiveBookings,
  getBookingSettings,
} from "./slotPolicy.js";

const BOOKINGS_QUERY = `*[_type == "booking"]{
  startTimeUTC,
  packageTitle,
  originalOrderId,
  status
}`;
const HOLDS_QUERY = `*[_type == "slotHold"]{
  startTimeUTC,
  _id,
  phase,
  expiresAt
}`;

const HOLD_STATES = Object.freeze({
  ACTIVE: "active",
});

const isExpiredHold = (hold, now = Date.now()) => {
  const expiresAtMs = new Date(hold?.expiresAt || "").getTime();
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
};

const isActiveHold = (hold, now) => {
  const phase = String(hold?.phase || "active").trim().toLowerCase();
  return phase !== "released" && phase !== "consumed" && !isExpiredHold(hold, now);
};

export async function getBookingAvailability({ client } = {}) {
  const readClient = client || createRefReadClient();
  const [settings, bookings, holds] = await Promise.all([
    getBookingSettings({ client: readClient }),
    readClient.fetch(BOOKINGS_QUERY),
    readClient.fetch(HOLDS_QUERY),
  ]);
  const now = Date.now();

  return {
    settings: {
      dateSlots: settings.dateSlots,
      xocDateSlots: settings.xocDateSlots,
      vertexEssentialsDateSlots: settings.vertexEssentialsDateSlots,
      packageDateSlots: settings.packageDateSlots,
    },
    bookedSlots: [
      ...filterActiveBookings(bookings)
        .map((booking) => ({
          startTimeUTC: String(booking?.startTimeUTC || "").trim(),
          isHold: false,
        }))
        .filter((booking) => booking.startTimeUTC),
      ...((Array.isArray(holds) ? holds : [])
        .filter((hold) => isActiveHold(hold, now))
        .map((hold) => ({
          startTimeUTC: String(hold?.startTimeUTC || "").trim(),
          isHold: true,
          holdId: String(hold?._id || "").trim(),
          phase: String(hold?.phase || "").trim(),
          expiresAt: String(hold?.expiresAt || "").trim(),
          isExpiredHold: false,
          holdState: HOLD_STATES.ACTIVE,
        }))
        .filter((hold) => hold.startTimeUTC && hold.holdId)),
    ],
  };
}

export default async function bookingAvailability(req, res) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed.",
    });
  }

  try {
    const availability = await getBookingAvailability();
    return res.status(200).json({
      ok: true,
      ...availability,
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: "Booking availability unavailable.",
    });
  }
}

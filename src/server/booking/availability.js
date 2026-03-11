import { createRefReadClient } from "../api/ref/sanity.js";
import {
  filterActiveBookings,
  getBookingSettings,
} from "./slotPolicy.js";

const BOOKINGS_QUERY = `*[_type == "booking"]{
  startTimeUTC,
  packageTitle,
  status
}`;
const HOLDS_QUERY = `*[_type == "slotHold" && (expiresAt > now() || phase == "payment_pending")]{
  startTimeUTC,
  _id,
  phase
}`;

export async function getBookingAvailability({ client } = {}) {
  const readClient = client || createRefReadClient();
  const [settings, bookings, holds] = await Promise.all([
    getBookingSettings({ client: readClient }),
    readClient.fetch(BOOKINGS_QUERY),
    readClient.fetch(HOLDS_QUERY),
  ]);

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
        .map((hold) => ({
          startTimeUTC: String(hold?.startTimeUTC || "").trim(),
          isHold: true,
          holdId: String(hold?._id || "").trim(),
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
      error: error?.message || "Booking availability unavailable.",
    });
  }
}

import { createCommerceReadClient } from "../api/ref/sanity.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { isSupabaseAdminConfigured } from "../supabase/adminClient.js";
import {
  filterActiveBookings,
  getBookingSettings,
} from "./slotPolicy.js";

const BOOKINGS_QUERY = `*[_type == "booking"]{
  _id,
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
const SLOT_LOCKS_QUERY = `*[_type == "bookingSlot" && status != "released"]{
  _id,
  bookingId,
  startTimeUTC,
  status
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
  const policy = resolveSupabaseRuntimePolicy();
  const primaryBackend = policy.commercePrimaryBackend;
  const secondaryBackend = primaryBackend === "supabase" ? "sanity" : "supabase";
  const primaryClient =
    client || createCommerceReadClient({ backendOverride: primaryBackend });
  const includeSecondary =
    !client &&
    ((primaryBackend === "sanity" &&
      secondaryBackend === "supabase" &&
      isSupabaseAdminConfigured()) ||
      (primaryBackend === "supabase" &&
        policy.commerceFailoverGeneration < 1));
  const clients = includeSecondary
    ? [
        primaryClient,
        createCommerceReadClient({ backendOverride: secondaryBackend }),
      ]
    : [primaryClient];
  const [settings, backendResults] = await Promise.all([
    getBookingSettings({ client: primaryClient }),
    Promise.all(
      clients.map(async (readClient) => {
        if (typeof readClient.fetchAvailability === "function") {
          return readClient.fetchAvailability({
            bookingsQuery: BOOKINGS_QUERY,
            holdsQuery: HOLDS_QUERY,
            slotLocksQuery: SLOT_LOCKS_QUERY,
          });
        }
        const [bookings, holds, slotLocks] = await Promise.all([
          readClient.fetch(BOOKINGS_QUERY),
          readClient.fetch(HOLDS_QUERY),
          readClient.fetch(SLOT_LOCKS_QUERY),
        ]);
        return { bookings, holds, slotLocks };
      })
    ),
  ]);
  const now = Date.now();
  const bookings = backendResults.flatMap((result) => result.bookings || []);
  const holds = backendResults.flatMap((result) => result.holds || []);
  const slotLocks = backendResults.flatMap((result) => result.slotLocks || []);
  const occupied = new Map();

  filterActiveBookings(bookings).forEach((booking) => {
    const startTimeUTC = String(booking?.startTimeUTC || "").trim();
    if (startTimeUTC) {
      occupied.set(`booking:${startTimeUTC}`, { startTimeUTC, isHold: false });
    }
  });
  slotLocks.forEach((slotLock) => {
    const startTimeUTC = String(slotLock?.startTimeUTC || "").trim();
    if (startTimeUTC) {
      occupied.set(`booking:${startTimeUTC}`, { startTimeUTC, isHold: false });
    }
  });
  holds
    .filter((hold) => isActiveHold(hold, now))
    .forEach((hold) => {
      const startTimeUTC = String(hold?.startTimeUTC || "").trim();
      const holdId = String(hold?._id || "").trim();
      if (!startTimeUTC || !holdId || occupied.has(`booking:${startTimeUTC}`)) return;
      occupied.set(`hold:${startTimeUTC}:${holdId}`, {
        startTimeUTC,
        isHold: true,
        holdId,
        phase: String(hold?.phase || "").trim(),
        expiresAt: String(hold?.expiresAt || "").trim(),
        isExpiredHold: false,
        holdState: HOLD_STATES.ACTIVE,
      });
    });

  return {
    settings: {
      dateSlots: settings.dateSlots,
      xocDateSlots: settings.xocDateSlots,
      vertexEssentialsDateSlots: settings.vertexEssentialsDateSlots,
      packageDateSlots: settings.packageDateSlots,
    },
    bookedSlots: [...occupied.values()],
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

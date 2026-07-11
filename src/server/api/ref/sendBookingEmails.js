import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import {
  getBookingForEmailDispatch,
  sendBookingEmailsForBooking,
} from "./bookingEmails.js";
import { verifyBookingEmailDispatchToken } from "./bookingEmailDispatchToken.js";
import { createCommerceWriteClient } from "./sanity.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const bookingId = String(req.body?.bookingId || "").trim();
  const emailDispatchToken = String(req.body?.emailDispatchToken || "").trim();

  if (!bookingId || !emailDispatchToken) {
    return res.status(400).json({
      ok: false,
      error: "Missing booking email confirmation details.",
    });
  }

  const clientAddress = getClientAddress(req);
  if (
    !(await requireRateLimit(res, {
      key: `send-booking-emails:${clientAddress}`,
      max: 20,
      message: "Too many booking email requests. Please try again later.",
    }))
  ) {
    return;
  }

  const initialToken = verifyBookingEmailDispatchToken({
    token: emailDispatchToken,
    bookingId,
  });
  if (!initialToken.ok) {
    const status =
      initialToken.reason === "booking_email_token_expired" ? 401 : 403;
    return res.status(status).json({
      ok: false,
      error: "Booking email confirmation is not authorized.",
      code: initialToken.reason,
    });
  }

  const policy = resolveSupabaseRuntimePolicy();
  const tokenBackend = initialToken.payload?.be
    ? initialToken.payload.be === "supabase"
      ? "supabase"
      : "sanity"
    : "";
  const backendCandidates = tokenBackend
    ? [tokenBackend]
    : [
        policy.commercePrimaryBackend,
        policy.commercePrimaryBackend === "supabase" ? "sanity" : "supabase",
      ];
  let booking = null;
  let client = null;
  for (const backend of backendCandidates) {
    let candidate = null;
    let found = null;
    try {
      candidate = createCommerceWriteClient({ backendOverride: backend });
      found = await getBookingForEmailDispatch({ bookingId, client: candidate });
    } catch (error) {
      if (backend !== "sanity") continue;
      found = await getBookingForEmailDispatch({ bookingId });
    }
    if (found?._id) {
      booking = found;
      client = candidate;
      break;
    }
  }
  if (!booking?._id) {
    return res.status(404).json({
      ok: false,
      error: "Booking not found.",
    });
  }

  const tokenResult = verifyBookingEmailDispatchToken({
    token: emailDispatchToken,
    bookingId,
    email: String(booking.email || booking.payerEmail || "").trim(),
    ...(initialToken.payload?.be
      ? { backend: booking.backendOwner || tokenBackend }
      : {}),
    ...(initialToken.payload?.gen !== undefined
      ? { cutoverGeneration: Number(booking.cutoverGeneration || 0) }
      : {}),
  });

  if (!tokenResult.ok) {
    const status =
      tokenResult.reason === "booking_email_token_expired" ? 401 : 403;
    return res.status(status).json({
      ok: false,
      error: "Booking email confirmation is not authorized.",
      code: tokenResult.reason,
    });
  }

  const result = await sendBookingEmailsForBooking({
    bookingId,
    booking,
    ...(client ? { client } : {}),
  });

  return res.status(result.httpStatus).json(result.body);
}

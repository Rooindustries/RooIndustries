import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import {
  getBookingForEmailDispatch,
  sendBookingEmailsForBooking,
} from "./bookingEmails.js";
import { verifyBookingEmailDispatchToken } from "./bookingEmailDispatchToken.js";

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
    !requireRateLimit(res, {
      key: `send-booking-emails:${clientAddress}:${bookingId.toLowerCase()}`,
      max: 20,
      message: "Too many booking email requests. Please try again later.",
    })
  ) {
    return;
  }

  const booking = await getBookingForEmailDispatch({ bookingId });
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
  });

  return res.status(result.httpStatus).json(result.body);
}

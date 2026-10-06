import { createDataClient as createClient } from "../../data/documentClient.js";
import { requireAdminKey } from "./auth.js";
import { applyBookingStatusTransition } from "./bookingRefunds.js";
import { logSafeError } from "../../safeErrorLog.js";

const client = createClient(
  {},
  { domain: "commerce" }
);

export default async function handler(req, res) {
  if (String(req?.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    if (!requireAdminKey(req, res)) return;
    const { bookingId, status, payerEmail } = req.body || {};
    if (!bookingId || !status) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing bookingId or status" });
    }
    const result = await applyBookingStatusTransition({
      client,
      bookingId: String(bookingId).trim(),
      status,
      payerEmail,
      source: "admin",
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    logSafeError("Booking status update failed", error);
    return res.status(status).json({
      ok: false,
      error: status < 500 ? error.message : "Failed to update booking status",
    });
  }
}

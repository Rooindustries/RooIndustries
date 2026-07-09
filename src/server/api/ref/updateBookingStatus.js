import { createClient } from "@sanity/client";
import { requireAdminKey } from "./auth.js";
import { applyBookingStatusTransition } from "./bookingRefunds.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

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
    console.error("Error updating booking:", error);
    return res.status(status).json({
      ok: false,
      error: status < 500 ? error.message : "Failed to update booking status",
    });
  }
}

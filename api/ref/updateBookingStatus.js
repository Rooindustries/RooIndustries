import { createClient } from "@sanity/client";
import { requireAdminKey } from "./auth";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    if (!requireAdminKey(req, res)) return;

    const { bookingId, status, payerEmail } = req.body;
    if (!bookingId || !status) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing bookingId or status" });
    }

    const allowedStatuses = ["pending", "captured", "completed", "cancelled"];
    if (!allowedStatuses.includes(String(status).toLowerCase())) {
      return res.status(400).json({ ok: false, error: "Invalid status value" });
    }

    await client.patch(bookingId).set({ status, payerEmail }).commit();

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error updating booking:", err);
    res
      .status(500)
      .json({ ok: false, error: "Failed to update booking status" });
  }
}

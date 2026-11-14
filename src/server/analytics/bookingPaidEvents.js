import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { logSafeEvent } from "../safeErrorLog.js";

const touchLabel = (attribution, field) => {
  const touch = attribution?.lastTouch || attribution;
  return typeof touch?.[field] === "string" ? touch[field] : "";
};

const paidEventsError = (step, fallbackCode, error) =>
  Object.assign(new Error(`Booking paid events could not be ${step}.`), {
    code: String(error?.code || fallbackCode),
    status: Number(error?.status || 0) || 0,
  });

export async function reportBookingPaidEvents(
  { limit = 50 } = {},
  { adminClient = createSupabaseAdminClient() } = {}
) {
  const { data, error } = await adminClient.rpc("roo_claim_booking_paid_events", { p_limit: limit });
  if (error || !Array.isArray(data)) throw paidEventsError("claimed", "BOOKING_PAID_CLAIM_FAILED", error);
  if (!data.length) return { reported: 0 };
  for (const row of data) {
    logSafeEvent("booking_paid", {
      event_id: row.event_id,
      provider: row.provider,
      value: row.value === null || row.value === undefined ? undefined : Number(row.value),
      currency: row.currency,
      package_title: row.package_title,
      source: touchLabel(row.attribution, "source"),
      campaign: touchLabel(row.attribution, "campaign"),
    });
  }
  const acknowledged = await adminClient.rpc("roo_ack_booking_paid_events", {
    p_event_ids: data.map((row) => row.event_id),
  });
  if (acknowledged.error) throw paidEventsError("acknowledged", "BOOKING_PAID_ACK_FAILED", acknowledged.error);
  return { reported: data.length };
}

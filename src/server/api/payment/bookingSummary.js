import envValue from "../../supabase/envValue.cjs";
import { asBookingSummary } from "../../../lib/bookingSummary.js";
import { logSafeWarn } from "../../safeErrorLog.js";
import { getPaymentRecordById } from "./paymentRecord.js";

const { resolveStoreBackend } = envValue;
const settled = status =>
  ["booked", "email_partial"].includes(String(status || "").trim().toLowerCase());
const sameAuthority = (left, right) =>
  resolveStoreBackend(left.backendOwner) === resolveStoreBackend(right.backendOwner) &&
  Number(left.cutoverGeneration ?? 0) === Number(right.cutoverGeneration ?? 0);
const hasDispute = value =>
  value.dodoDisputeActive === true ||
  (value.dodoDisputes != null &&
    (!Array.isArray(value.dodoDisputes) || value.dodoDisputes.some(dispute =>
      !["dispute_won", "dispute_cancelled"].includes(dispute?.status))));
const warnMismatch = () =>
  logSafeWarn("Booking summary link mismatch", { code: "booking_summary_link_mismatch" });

export const buildBrowserCompletionBody = async ({ client, record: authorizedRecord, body }) => {
  let bookingSummary = null;
  let requiresReschedule = body.requiresReschedule === true;
  try {
    if (settled(body.status) && body.bookingId) {
      const record = await getPaymentRecordById(client, authorizedRecord._id);
      requiresReschedule ||= record?.requiresReschedule === true;
      const authorized = record && record._id === authorizedRecord._id &&
        record.provider === authorizedRecord.provider &&
        record.pricingFingerprint === authorizedRecord.pricingFingerprint &&
        sameAuthority(record, authorizedRecord) && record.bookingId === body.bookingId;
      if (record && !authorized) warnMismatch();
      if (authorized && settled(record.status)) {
        const booking = await client.fetch(
          '*[_type == "booking" && _id == $id][0]{...}', { id: record.bookingId }
        );
        requiresReschedule ||= booking?.requiresReschedule === true ||
          booking?.recoveryStatus === "requires_reschedule";
        if (booking) {
          const duplicate = record.duplicatePaymentRecord === true &&
            record.canonicalPaymentRecordId &&
            booking.paymentRecordId === record.canonicalPaymentRecordId;
          const linked = booking._id === record.bookingId &&
            booking.paymentRecordId === record._id && sameAuthority(booking, record);
          if (!linked && !duplicate) warnMismatch();
          if (linked && !requiresReschedule &&
              ["pending", "captured", "completed"].includes(String(booking.status || "").trim().toLowerCase()) &&
              record.refundState !== "full" && booking.refundStatus !== "full" &&
              !hasDispute(record) && !hasDispute(booking)) {
            bookingSummary = asBookingSummary({
              bookingId: booking._id,
              packageTitle: booking.packageTitle,
              startTimeUTC: booking.startTimeUTC,
              localTimeZone: booking.localTimeZone,
            }, record.bookingId);
          }
        }
      }
    }
  } catch (error) {
    logSafeWarn("Booking summary unavailable", error);
  }
  return { ...body, bookingSummary, requiresReschedule };
};

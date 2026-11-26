import { createHash } from "crypto";
import { sanitizeSalesAttribution } from "../../../lib/salesAttribution.ts";
import { creatorCode } from "../ref/creatorCode.js";

export const bookingEventId = (paymentRecordId: string) =>
  createHash("sha256").update(`booking-confirmed:${paymentRecordId}`).digest("hex").slice(0, 40);

export function buildSalesReceipt(
  record: Record<string, any> = {},
  booking?: Record<string, any> | null,
) {
  try {
    if (!record._id || !record.bookingId || !["booked", "email_partial"].includes(record.status)) return null;
    if (record.provider !== "free" && record.verificationState !== "server_verified") return null;
    if (["refunded", "full", "disputed"].includes(record.refundState)) return null;
    const amount = Number(record.pricingSnapshot?.netAmount);
    const currency = record.providerPublicData?.currency || (record.provider === "free" ? "USD" : record.currency);
    if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency || "")) return null;
    const attribution = booking && typeof booking === "object"
      ? sanitizeSalesAttribution(booking.salesAttribution, null)
      : Object.hasOwn(record, "committedSalesAttribution")
        ? sanitizeSalesAttribution(record.committedSalesAttribution, null)
        : sanitizeSalesAttribution(record.bookingPayload?.salesAttribution);
    return {
      eventId: bookingEventId(record._id),
      packageTitle: String(record.bookingPayload?.packageTitle || "").slice(0, 120),
      paymentType: record.provider === "free" ? "free" : "paid",
      provider: String(record.provider),
      amount,
      currency,
      referralCode: creatorCode(record.pricingSnapshot?.effectiveReferralCode),
      attribution,
    };
  } catch {
    return null;
  }
}

import { createHash } from "crypto";
import { sanitizeSalesAttribution } from "../../../lib/salesAttribution";

export function buildSalesReceipt(record: Record<string, any> = {}) {
  if (!record._id || !record.bookingId || !["booked", "email_partial"].includes(record.status)) return null;
  if (record.provider !== "free" && record.verificationState !== "server_verified") return null;
  if (["refunded", "full", "disputed"].includes(record.refundState)) return null;
  const amount = Number(record.pricingSnapshot?.netAmount);
  const currency = record.providerPublicData?.currency || (record.provider === "free" ? "USD" : record.currency);
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency || "")) return null;
  return {
    eventId: createHash("sha256").update(`booking-confirmed:${record._id}`).digest("hex").slice(0, 40),
    packageTitle: String(record.bookingPayload?.packageTitle || "").slice(0, 120),
    paymentType: record.provider === "free" ? "free" : "paid",
    provider: String(record.provider),
    amount,
    currency,
    referralCode: String(record.pricingSnapshot?.effectiveReferralCode || "").slice(0, 80),
    attribution: sanitizeSalesAttribution(record.bookingPayload?.salesAttribution),
  };
}

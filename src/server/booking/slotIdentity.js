import crypto from "crypto";

export const normalizeStartTimeUTC = (value) => {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
};

export const isExactWholeMinute = (value) => {
  const normalized = normalizeStartTimeUTC(value);
  if (!normalized) return false;
  const parsed = new Date(normalized);
  return parsed.getUTCSeconds() === 0 && parsed.getUTCMilliseconds() === 0;
};

export const buildSlotKey = (startTimeUTC) => {
  const normalized = normalizeStartTimeUTC(startTimeUTC);
  if (!normalized) return "";
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
};

export const buildSlotHoldId = (startTimeUTC) => {
  const slotKey = buildSlotKey(startTimeUTC);
  return slotKey ? `slothold-${slotKey}` : "";
};

export const buildSlotBookingId = (startTimeUTC) => {
  const slotKey = buildSlotKey(startTimeUTC);
  return slotKey ? `booking-${slotKey}` : "";
};

export const buildBookingSlotId = (startTimeUTC) => {
  const slotKey = buildSlotKey(startTimeUTC);
  return slotKey ? `bookingSlot.${slotKey}` : "";
};

export const buildDeterministicBookingId = ({
  paymentRecordId = "",
  paymentProvider = "",
  providerOrderId = "",
  providerPaymentId = "",
  idempotencyKey = "",
  originalOrderId = "",
  startTimeUTC = "",
  email = "",
  couponCode = "",
} = {}) => {
  const normalizedProviderOrderId = String(providerOrderId || "").trim();
  const normalizedProviderPaymentId = String(providerPaymentId || "").trim();
  const stablePaymentKey =
    String(paymentRecordId || "").trim() ||
    (normalizedProviderOrderId || normalizedProviderPaymentId
      ? [paymentProvider, normalizedProviderOrderId, normalizedProviderPaymentId]
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean)
          .join(":")
      : "");
  const stableFreeKey =
    String(idempotencyKey || "").trim() ||
    [startTimeUTC, email, couponCode]
      .map((value) => String(value || "").trim().toLowerCase())
      .join(":");
  const seed = stablePaymentKey || [originalOrderId, stableFreeKey].join(":");
  if (!seed.replace(/:/g, "")) return "";
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `booking.${digest}`;
};

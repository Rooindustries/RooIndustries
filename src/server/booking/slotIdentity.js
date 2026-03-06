import crypto from "crypto";

export const normalizeStartTimeUTC = (value) => {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
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

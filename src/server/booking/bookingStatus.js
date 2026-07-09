export const BOOKING_STATUS = Object.freeze({
  PENDING: "pending",
  CAPTURED: "captured",
  COMPLETED: "completed",
  FAILED: "failed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
});

export const BOOKING_STATUSES = Object.freeze(Object.values(BOOKING_STATUS));

export const normalizeBookingStatus = (value, fallback = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  const canonical = normalized === "canceled" ? BOOKING_STATUS.CANCELLED : normalized;
  return BOOKING_STATUSES.includes(canonical) ? canonical : fallback;
};

export const isBookingBlockingStatus = (value) => {
  const status = normalizeBookingStatus(value, BOOKING_STATUS.PENDING);
  return (
    status === BOOKING_STATUS.PENDING ||
    status === BOOKING_STATUS.CAPTURED ||
    status === BOOKING_STATUS.COMPLETED
  );
};

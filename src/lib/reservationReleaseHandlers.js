import { HOLD_STORAGE_KEY, PAYMENT_SESSION_STORAGE_KEY, CHECKOUT_BOOKING_STORAGE_KEY, updateStoredCheckoutHold, readStoredCheckoutBooking } from "./checkoutStorage";
import { readReservationStorage, writeReservationStorage, removeReservationStorage } from "./reservationStorage";
import { CLIENT_REQUEST_TIMEOUT_MS } from "./clientRequest";
import { reportReservationError, reservationOperation, releaseOutdatedHold,
  saveReservationReleaseError } from "./reservationOperation";

const paymentReleases = new Map();
const paymentConfirmations = new Map();
const paymentReleaseErrors = new Map();
export const RESERVATION_PAYMENT_EVENT = "reservation-payment-result";

const publishPayment = (detail) => window.dispatchEvent(new CustomEvent(RESERVATION_PAYMENT_EVENT, { detail }));

export const readPaymentConfirmation = (token) => paymentConfirmations.get(token) || null;
export const readPaymentReleaseError = (token) => paymentReleaseErrors.get(token) || "";
export const hasConfirmingReservation = () => [...paymentConfirmations.values()].some(({ hold, token }) =>
  Boolean(hold) && reservationOperation({ hold, paymentAccessToken: token })());
export const paymentSessionCurrent = (token) => {
  try {
    const session = JSON.parse(readReservationStorage(PAYMENT_SESSION_STORAGE_KEY) || "null");
    return Boolean(token) && session?.paymentAccessToken === token;
  } catch { return false; }
};

const confirmCapturedPayment = async (hold, token, result, checkout) => {
  const booked = (data) => ["booked", "email_partial"].includes(String(data?.status || "").toLowerCase()) && data?.bookingId;
  const existing = paymentConfirmations.get(token);
  if (existing && !booked(result)) return;
  if (existing) {
    paymentConfirmations.delete(token);
    publishPayment({ ...existing, status: "booked", data: result });
    return;
  }
  let data = result;
  let lastFailure = "";
  const confirmation = { status: "confirming", hold, token, checkout };
  paymentConfirmations.set(token, confirmation);
  if (!booked(data)) publishPayment(confirmation);
  while (!booked(data)) {
    try {
      const response = await fetch("/api/payment/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS),
      });
      const next = await response.json();
      if (paymentConfirmations.get(token) !== confirmation) return;
      if (!response.ok || next?.manualReviewRequired || ["failed", "refunded", "abandoned"].includes(next?.status)) {
        throw new Error(next?.recoveryReason || next?.error || "Unable to confirm payment.");
      }
      data = next;
      if (lastFailure) {
        lastFailure = "";
        confirmation.status = "confirming";
        publishPayment(confirmation);
      }
    } catch (error) {
      if (paymentConfirmations.get(token) !== confirmation) return;
      const message = error.message || "Unable to confirm payment.";
      if (message !== lastFailure) reportReservationError("Failed to confirm captured payment", error);
      lastFailure = message;
      confirmation.status = "error";
      confirmation.message = message;
      publishPayment(confirmation);
    }
    if (!booked(data)) await new Promise(resolve => setTimeout(resolve, 2500));
    if (paymentConfirmations.get(token) !== confirmation) return;
  }
  paymentConfirmations.delete(token);
  publishPayment({ status: "booked", hold, token, checkout, data });
};

export const cancelReservationPayment = async (hold, token, { isUpgrade = false, bookingData = null } = {}) => {
  const checkout = readReservationStorage(CHECKOUT_BOOKING_STORAGE_KEY);
  paymentReleaseErrors.delete(token);
  const group = paymentReleases.get(token) || [];
  let settle;
  const job = { ready: new Promise(resolve => { settle = resolve; }), finished: false };
  const index = group.push(job) - 1;
  paymentReleases.set(token, group);
  const isCurrent = () => paymentSessionCurrent(token) && (isUpgrade || reservationOperation({ hold })());
  try {
    let data;
    try {
      const response = await fetch("/api/payment/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS),
      });
      data = await response.json().catch(() => ({}));
      if (!data?.captured && (!response.ok || data?.cancelled !== true)) {
        throw new Error(data?.error || "The payment session could not be released.");
      }
      job.data = data;
    } catch (error) {
      job.error = error;
      reportReservationError("Failed to release payment session", error);
    }
    settle();
    if (data?.captured) {
      void confirmCapturedPayment(hold, token, data, checkout);
      return { captured: true };
    }
    if (job.error) {
      await Promise.all(group.map(item => item.ready));
      if (group.at(-1) !== job || group.some(item => item.data) || !isCurrent()) return { stale: true };
      const message = job.error?.name === "AbortError" || job.error?.name === "TimeoutError"
        ? "The payment session could not be released. Please try again."
        : job.error.message || "The payment session could not be released.";
      paymentReleaseErrors.set(token, message);
      if (hold) saveReservationReleaseError(hold, message);
      publishPayment({ status: "release-error", hold, token, message });
      return { error: message };
    }
    await Promise.all(group.slice(index + 1).map(item => item.ready));
    if (group.slice(index + 1).some(item => item.data)) return { stale: true };
    const refreshed = data.refreshedHold;
    if (!isCurrent()) {
      if (hold && refreshed?.slotHoldId && refreshed?.slotHoldToken &&
          !reservationOperation({ hold: { holdId: refreshed.slotHoldId, holdToken: refreshed.slotHoldToken } })()) {
        await releaseOutdatedHold({ holdId: refreshed.slotHoldId, holdToken: refreshed.slotHoldToken });
      }
      return { stale: true };
    }
    if (isUpgrade) {
      removeReservationStorage(PAYMENT_SESSION_STORAGE_KEY);
      return { nextHold: null, refreshed: null };
    }
    const nextHold = refreshed?.slotHoldId && refreshed?.slotHoldToken ? {
      ...hold,
      ...(!hold ? { startTimeUTC: bookingData?.startTimeUTC || "", packageTitle: bookingData?.packageTitle || "",
        packagePrice: bookingData?.packagePrice || "" } : {}),
      holdId: refreshed.slotHoldId,
      holdToken: refreshed.slotHoldToken,
      expiresAt: refreshed.slotHoldExpiresAt,
      phase: "holding",
    } : null;
    let checkoutUpdated = null;
    if (nextHold) {
      writeReservationStorage(HOLD_STORAGE_KEY, JSON.stringify(nextHold));
      const currentCheckout = readStoredCheckoutBooking();
      if (hold ? currentCheckout?.slotHoldId === hold.holdId && currentCheckout?.slotHoldToken === hold.holdToken
        : checkout === readReservationStorage(CHECKOUT_BOOKING_STORAGE_KEY)) {
        checkoutUpdated = updateStoredCheckoutHold(refreshed);
      }
    } else {
      removeReservationStorage(HOLD_STORAGE_KEY);
    }
    removeReservationStorage(PAYMENT_SESSION_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("hold-state", { detail: nextHold }));
    return { nextHold, refreshed, checkoutUpdated };
  } finally {
    job.finished = true;
    if (group.every(item => item.finished) && paymentReleases.get(token) === group) paymentReleases.delete(token);
  }
};

import { HOLD_STORAGE_KEY, PAYMENT_SESSION_STORAGE_KEY } from "./checkoutStorage";
import { readReservationStorage, writeReservationStorage, removeReservationStorage } from "./reservationStorage";
import { CLIENT_REQUEST_TIMEOUT_MS } from "./clientRequest";
import { getSafeErrorMetadata, logSafeError } from "../server/safeErrorLog";
import { reportClientError } from "./monitoring/client";

const RELEASE_ERROR_KEY = "reservation_release_error";
export const RESERVATION_ERROR_EVENT = "reservation-release-error";

export const reportReservationError = (label, error) => {
  logSafeError(label, error);
  reportClientError(Object.assign(new Error(label), getSafeErrorMetadata(error)));
};

const sameReservation = (expected, actual) => expected
  ? expected.holdId === actual?.holdId && expected.holdToken === actual?.holdToken
  : !actual;

export const reconcileReservation = (hold) => {
  let stored;
  try {
    stored = JSON.parse(readReservationStorage(HOLD_STORAGE_KEY) || "null");
    if (stored !== null && (
      ![stored.holdId, stored.holdToken, stored.startTimeUTC, stored.expiresAt]
        .every(value => typeof value === "string" && value.trim()) ||
      !Number.isFinite(Date.parse(stored.startTimeUTC)) || !Number.isFinite(Date.parse(stored.expiresAt))
    )) {
      throw new Error("Invalid slot reservation");
    }
  } catch (error) {
    reportReservationError("Repaired invalid slot reservation storage", error);
    if (hold) writeReservationStorage(HOLD_STORAGE_KEY, JSON.stringify(hold));
    else removeReservationStorage(HOLD_STORAGE_KEY);
    return { hold, changed: false };
  }
  const changed = !sameReservation(hold, stored);
  if (changed) reportReservationError("Slot reservation changed before reserving", new Error("Reservation changed"));
  return { hold: stored, changed };
};

export const readReservationReleaseError = (hold) => {
  try {
    const saved = JSON.parse(readReservationStorage(RELEASE_ERROR_KEY) || "null");
    return hold && sameReservation(hold, saved?.hold) ? saved.message : "";
  } catch { return ""; }
};

export const saveReservationReleaseError = (hold, message) => {
  if (message) writeReservationStorage(RELEASE_ERROR_KEY, JSON.stringify({ hold, message }));
  else removeReservationStorage(RELEASE_ERROR_KEY);
  window.dispatchEvent(new Event(RESERVATION_ERROR_EVENT));
};

export const reservationOperation = ({ hold, paymentAccessToken }) => () => {
  try {
    const stored = JSON.parse(readReservationStorage(HOLD_STORAGE_KEY) || "null");
    if (!sameReservation(hold, stored)) return false;
    if (paymentAccessToken !== undefined) {
      const session = JSON.parse(readReservationStorage(PAYMENT_SESSION_STORAGE_KEY) || "null");
      return String(session?.paymentAccessToken || "").trim() === paymentAccessToken;
    }
    return true;
  } catch { return false; }
};

export const releaseOutdatedHold = async ({ holdId, holdToken }) => {
  if (!holdId || !holdToken) return;
  try {
    const response = await fetch("/api/releaseHold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdId, holdToken }),
      signal: AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS),
    });
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error("Could not release an outdated slot reservation.");
    console.info("Released an outdated slot reservation.");
  } catch (error) {
    reportReservationError("Failed to release an outdated slot reservation", error);
  }
};

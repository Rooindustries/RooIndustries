import { HOLD_STORAGE_KEY, PAYMENT_SESSION_STORAGE_KEY } from "./checkoutStorage";
import { readReservationStorage } from "./reservationStorage";
import { CLIENT_REQUEST_TIMEOUT_MS, reportRequestError } from "./clientRequest";

const sameReservation = (expected, actual) => expected
  ? expected.holdId === actual?.holdId && expected.holdToken === actual?.holdToken
  : !actual;

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
    reportRequestError(error);
  }
};

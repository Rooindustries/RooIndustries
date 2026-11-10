import { classifyHoldResponse } from "./holdResponse";
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
    return saved && sameReservation(hold, saved.hold) ? saved.message : "";
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

const reservations = new Map();
let reservationSequence = 0;

const discardOutdatedReservations = async (responses) => {
  for (const data of responses) {
    if (!reservationOperation({ hold: data })()) await releaseOutdatedHold(data);
  }
};

export const reserveSlot = async ({ body, hold, packageDetails, isSameAsExisting }) => {
  const key = JSON.stringify([hold?.holdId, hold?.holdToken]);
  const entry = reservations.get(key) || { outdated: [], finished: false, pending: 0 };
  entry.pending += 1;
  entry.finished = false;
  const sequence = ++reservationSequence;
  entry.latest = sequence;
  reservations.set(key, entry);
  try {
    const isCurrent = reservationOperation({ hold });
    let response;
    let data;
    let networkError = false;
    try {
      response = await fetch("/api/holdSlot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS),
      });
      data = await response.json();
    } catch (error) {
      reportReservationError("Failed to reserve slot", error);
      networkError = true;
    }
    const successful = response?.ok && data?.ok === true;
    if (entry.latest !== sequence) {
      if (successful) {
        if (entry.finished) await discardOutdatedReservations([data]);
        else entry.outdated.push(data);
      }
      return { stale: true };
    }
    entry.finished = true;
    if (!isCurrent()) {
      await discardOutdatedReservations([...entry.outdated.splice(0), ...(successful ? [data] : [])]);
      return { stale: true };
    }
    const outcome = classifyHoldResponse({
      endpoint: "hold", status: response?.status, ok: response?.ok && data?.ok === true,
      code: data?.code, networkError,
    });
    if (outcome === "keep" && (networkError || response?.status >= 500)) {
      if (!networkError) reportReservationError("Failed to reserve slot", new Error(`Reservation request failed (${response.status})`));
      saveReservationReleaseError(hold, "Could not reserve this slot. Please check your internet and try again.");
    }
    if (outcome !== "replace") {
      let pendingHold = null;
      if (response?.status === 409 && data?.code === "hold_payment_in_progress" && isSameAsExisting) {
        pendingHold = { ...hold, phase: "payment_pending", paymentStartedElsewhere: true };
        writeReservationStorage(HOLD_STORAGE_KEY, JSON.stringify(pendingHold));
        window.dispatchEvent(new CustomEvent("hold-state", { detail: pendingHold }));
      } else if (outcome === "clear" && isSameAsExisting) {
        removeReservationStorage(HOLD_STORAGE_KEY);
        window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
      }
      await discardOutdatedReservations(entry.outdated.splice(0));
      return { response, data, outcome, pendingHold };
    }
    const nextHold = {
      holdId: data.holdId,
      holdToken: data.holdToken,
      expiresAt: data.expiresAt,
      startTimeUTC: body.startTimeUTC,
      packageTitle: packageDetails.title,
      packagePrice: packageDetails.price,
      packageTag: packageDetails.tag,
      phase: "active",
    };
    writeReservationStorage(HOLD_STORAGE_KEY, JSON.stringify(nextHold));
    window.dispatchEvent(new CustomEvent("hold-state", { detail: nextHold }));
    await discardOutdatedReservations(entry.outdated.splice(0));
    return { response, data, outcome, nextHold };
  } finally {
    if (--entry.pending === 0 && reservations.get(key) === entry) reservations.delete(key);
  }
};

const slotReleases = new Map();

export const releaseSlot = (hold, { suppressError = false } = {}) => {
  const key = JSON.stringify([hold?.holdId, hold?.holdToken]);
  const existing = slotReleases.get(key);
  if (existing) {
    if (!suppressError) existing.reportFailure = true;
    return existing.task;
  }
  const release = { reportFailure: !suppressError };
  const task = (async () => {
    const expired = () => new Date(hold.expiresAt).getTime() <= Date.now();
    let current = reservationOperation({ hold });
    if (expired() && current()) {
      removeReservationStorage(HOLD_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
      current = reservationOperation({ hold: null });
    }
    saveReservationReleaseError(hold, "");
    let outcome;
    let message = "";
    try {
      const response = await fetch("/api/releaseHold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: hold.holdId, holdToken: hold.holdToken }),
        signal: AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS),
      });
      const data = await response.json();
      if (response.status === 409) message = data?.message || data?.error || "";
      outcome = classifyHoldResponse({ endpoint: "release", status: response.status,
        ok: response.ok && data?.ok === true, expired: expired() });
    } catch (error) {
      reportReservationError("Failed to release hold on server", error);
      outcome = classifyHoldResponse({ endpoint: "release", networkError: true, expired: expired() });
    }
    if (!current()) return false;
    if (outcome !== "keep") {
      removeReservationStorage(HOLD_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
      return true;
    }
    if (release.reportFailure) saveReservationReleaseError(hold,
      message || "Could not release your slot. Your reservation and details are saved. Please try again.");
    return false;
  })();
  release.task = task;
  slotReleases.set(key, release);
  task.then(() => slotReleases.delete(key), () => slotReleases.delete(key));
  return task;
};

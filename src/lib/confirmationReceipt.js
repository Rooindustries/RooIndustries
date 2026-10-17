import { asBookingSummary } from "./bookingSummary";
import { useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export const asConfirmationReceipt = (value) =>
  typeof value?.bookingId === "string" && value.bookingId.trim()
    ? { bookingId: value.bookingId.trim(), ...(value.emailDispatchToken ? { emailDispatchToken: value.emailDispatchToken } : {}) }
    : null;

const readConfirmationReceipt = (state, hydrated) => {
  if (state) return asConfirmationReceipt(state.bookingConfirmation);
  if (!hydrated || typeof window === "undefined") return null;

  const historyReceipt = asConfirmationReceipt(window.history.state?.usr?.bookingConfirmation);
  if (historyReceipt) return historyReceipt;

  try {
    return asConfirmationReceipt(JSON.parse(window.sessionStorage.getItem("booking_confirmation_state")));
  } catch {
    return null;
  }
};

export const useConfirmationReceipt = () => {
  const location = useLocation();
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return readConfirmationReceipt(location.state, hydrated);
};

const summaryPrefix = "booking_confirmation_summary:";
const reschedulePrefix = "booking_confirmation_reschedule:";

export const clearBookingConfirmation = () => {
  try {
    const keys = Object.keys(window.sessionStorage).filter(key => key.startsWith(summaryPrefix));
    for (const key of keys) window.sessionStorage.removeItem(key);
    window.sessionStorage.removeItem("booking_confirmation_state");
  } catch {}
};

export const createBookingConfirmation = body => {
  const receipt = asConfirmationReceipt(body);
  if (!receipt) return null;
  const { bookingId } = receipt;
  const bookingSummary = asBookingSummary(body.bookingSummary, bookingId);
  const requiresReschedule = body.requiresReschedule === true || /reschedul/i.test(String(body.recoveryReason || ""));
  try {
    window.sessionStorage.removeItem(`${summaryPrefix}${bookingId}`);
    if (requiresReschedule) window.sessionStorage.setItem(`${reschedulePrefix}${bookingId}`, "true");
    else window.sessionStorage.removeItem(`${reschedulePrefix}${bookingId}`);
    window.sessionStorage.setItem(`${summaryPrefix}${bookingId}`, JSON.stringify(requiresReschedule ? null : bookingSummary));
    window.sessionStorage.setItem("booking_confirmation_state", JSON.stringify(receipt));
  } catch {
    if (requiresReschedule) return null;
  }
  return receipt;
};

export const readBookingConfirmationSummary = receipt => {
  if (!receipt || readBookingConfirmationReschedule(receipt)) return null;
  try { return asBookingSummary(JSON.parse(window.sessionStorage.getItem(`${summaryPrefix}${receipt.bookingId}`)), receipt.bookingId); } catch { return null; }
};

export const readBookingConfirmationReschedule = receipt => {
  if (!receipt) return false;
  try { return window.sessionStorage.getItem(`${reschedulePrefix}${receipt.bookingId}`) === "true"; } catch { return false; }
};

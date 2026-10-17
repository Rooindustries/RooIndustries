import { asBookingSummary } from "./bookingSummary";
import { useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export const asConfirmationReceipt = (value) =>
  typeof value?.bookingId === "string" && value.bookingId.trim()
    ? { bookingId: value.bookingId.trim(), ...(value.emailDispatchToken ? { emailDispatchToken: value.emailDispatchToken } : {}), ...(value.requiresReschedule === true ? { requiresReschedule: true } : {}) }
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

export const clearBookingConfirmation = () => {
  try {
    const keys = Object.keys(window.sessionStorage).filter(key => key.startsWith(summaryPrefix));
    for (const key of keys) window.sessionStorage.removeItem(key);
    window.sessionStorage.removeItem("booking_confirmation_state");
  } catch {}
};

export const createBookingConfirmation = body => {
  const requiresReschedule = body?.requiresReschedule === true || /reschedul/i.test(String(body?.recoveryReason || ""));
  const receipt = asConfirmationReceipt({ ...body, requiresReschedule });
  if (!receipt) return null;
  const { bookingId } = receipt;
  const bookingSummary = asBookingSummary(body.bookingSummary, bookingId);
  try {
    window.sessionStorage.removeItem(`${summaryPrefix}${bookingId}`);
    window.sessionStorage.setItem(`${summaryPrefix}${bookingId}`, JSON.stringify(requiresReschedule ? null : bookingSummary));
    window.sessionStorage.setItem("booking_confirmation_state", JSON.stringify(receipt));
  } catch {}
  return receipt;
};

export const readBookingConfirmationSummary = receipt => {
  if (!receipt || receipt.requiresReschedule) return null;
  try { return asBookingSummary(JSON.parse(window.sessionStorage.getItem(`${summaryPrefix}${receipt.bookingId}`)), receipt.bookingId); } catch { return null; }
};

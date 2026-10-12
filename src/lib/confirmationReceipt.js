import { useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

const asReceipt = (value) =>
  typeof value?.bookingId === "string" && value.bookingId.trim()
    ? value
    : null;

const readConfirmationReceipt = (state, hydrated) => {
  const receipt = asReceipt(state?.bookingConfirmation);
  if (receipt || !hydrated || typeof window === "undefined") return receipt;

  const historyReceipt = asReceipt(window.history.state?.usr?.bookingConfirmation);
  if (historyReceipt) return historyReceipt;

  try {
    return asReceipt(JSON.parse(window.sessionStorage.getItem("booking_confirmation_state")));
  } catch {
    return null;
  }
};

export const useConfirmationReceipt = () => {
  const location = useLocation();
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return readConfirmationReceipt(location.state, hydrated);
};

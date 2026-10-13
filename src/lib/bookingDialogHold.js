import { createContext, useContext, useLayoutEffect } from "react";

export const BookingDialogHoldContext = createContext(null);

export function useBookingDialogPending(pending) {
  const hold = useContext(BookingDialogHoldContext);
  useLayoutEffect(() => {
    if (!pending || !hold) return undefined;
    return hold();
  }, [hold, pending]);
}

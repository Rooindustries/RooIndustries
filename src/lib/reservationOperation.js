const sameReservation = (expected, actual) => expected
  ? expected.holdId === actual?.holdId && expected.holdToken === actual?.holdToken
  : !actual;

export const reservationOperation = ({ hold, currentHold, mounted, paymentAccessToken }) => () => {
  if (!mounted.current || !sameReservation(hold, currentHold.current)) return false;
  try {
    const stored = JSON.parse(sessionStorage.getItem("my_slot_hold") || "null");
    if (!sameReservation(hold, stored)) return false;
    if (paymentAccessToken !== undefined) {
      const session = JSON.parse(sessionStorage.getItem("payment_session_state") || "null");
      return String(session?.paymentAccessToken || "").trim() === paymentAccessToken;
    }
    return true;
  } catch { return false; }
};

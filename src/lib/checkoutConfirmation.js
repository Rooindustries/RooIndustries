export const CHECKOUT_CONFIRMATION_EVENT = "checkout-confirmation";

let pending = 0;

const announce = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHECKOUT_CONFIRMATION_EVENT));
};

export const beginCheckoutConfirmation = () => {
  pending += 1;
  announce();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pending = Math.max(0, pending - 1);
    announce();
  };
};

export const isCheckoutConfirmationPending = () => pending > 0;

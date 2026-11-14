import { useSyncExternalStore } from "react";
import {
  CHECKOUT_SAVE_NOTICE,
  hasCheckoutSaveFailure,
  subscribeCheckoutSaveFailure,
} from "../../public/checkout-state.js";

export default function CheckoutSaveNotice() {
  const failed = useSyncExternalStore(subscribeCheckoutSaveFailure, hasCheckoutSaveFailure, () => false);
  if (!failed) return null;
  return (
    <p role="alert" className="mt-6 rounded-xl border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-text">
      {CHECKOUT_SAVE_NOTICE}
    </p>
  );
}

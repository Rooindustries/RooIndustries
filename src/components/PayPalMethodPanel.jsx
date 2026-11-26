import React, { useEffect, useState } from "react";
let cachedPaypalSdk = null;
const PayPalLoadError = ({ onRetry }) => (
  <div className="space-y-2 text-center">
    <p role="alert" className="text-xs text-warning-text">PayPal couldn’t load. Please try again.</p>
    <button
      type="button" onClick={onRetry}
      className="glow-button h-11 w-full rounded-lg px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border"
    >Retry PayPal</button>
  </div>
);
const PayPalLoading = () => (
  <p role="status" className="flex h-11 items-center justify-center text-xs text-ink-secondary">Loading PayPal…</p>
);
function PayPalCheckout({ useReducerHook, children }) {
  const [{ isResolved, isRejected, options }, dispatch] = useReducerHook();
  if (isRejected) return <PayPalLoadError onRetry={() => dispatch({ type: "resetOptions", value: options })} />;
  if (!isResolved) return <PayPalLoading />;
  return (
    <div className="paypal-checkout-shell relative z-0 h-11 w-full overflow-hidden rounded-lg bg-transparent [&_iframe]:!rounded-[4px] [&_iframe]:!border-0 [&_iframe]:!bg-transparent [&_iframe]:!outline-0 [&_iframe]:!shadow-none">
      {children}
    </div>
  );
}
export default function PayPalMethodPanel({ paypalClientId, children }) {
  const [paypalSdk, setPaypalSdk] = useState(() => cachedPaypalSdk);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (paypalSdk) return undefined;
    let active = true;
    setLoadFailed(false);
    import("@paypal/react-paypal-js")
      .then((mod) => {
        cachedPaypalSdk = mod;
        if (active) setPaypalSdk(mod);
      })
      .catch(() => active && setLoadFailed(true));
    return () => { active = false; };
  }, [loadAttempt, paypalSdk]);
  if (loadFailed) return <PayPalLoadError onRetry={() => setLoadAttempt((count) => count + 1)} />;
  if (!paypalSdk) return <PayPalLoading />;
  return (
    <paypalSdk.PayPalScriptProvider options={{ "client-id": paypalClientId, currency: "USD", intent: "capture" }}>
      <PayPalCheckout useReducerHook={paypalSdk.usePayPalScriptReducer}>
        {children(paypalSdk.PayPalButtons)}
      </PayPalCheckout>
    </paypalSdk.PayPalScriptProvider>
  );
}

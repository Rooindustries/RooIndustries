import { useEffect, useState } from "react";
let cached = null;
export default function PayPalPanelSlot(props) {
  const [Panel, setPanel] = useState(() => cached);
  const [step, setStep] = useState(1);
  useEffect(() => {
    if (Panel || step < 0) return;
    let active = true;
    import("../lib/paymentCheckoutHold").then((m) => {
      cached = m.PayPalMethodPanel;
      if (active) setPanel(() => m.PayPalMethodPanel);
    }).catch(() => active && setStep(-step));
    return () => { active = false; };
  }, [step, Panel]);
  if (step < 0) return <div className="space-y-2 text-center"><p role="alert" className="text-xs text-warning-text">PayPal couldn’t load. Please try again.</p><button type="button" onClick={() => setStep(1 - step)} className="glow-button h-11 w-full rounded-lg px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border">Retry PayPal</button></div>;
  return Panel ? <Panel {...props} /> : <p role="status" className="flex h-11 items-center justify-center text-xs text-ink-secondary">Loading PayPal…</p>;
}

import { useEffect, useState } from "react";
import ConsentBanner from "../components/ConsentBanner";
import { onConsentChange, onConsentReset, readConsent } from "../lib/consent";
import { withMetaPixel } from "../lib/analyticsModules";

export default function ConsentRuntime() {
  const [open, setOpen] = useState(() => readConsent() === "unset");

  useEffect(() => {
    if (readConsent() === "granted") withMetaPixel((pixel) => pixel.loadMetaPixel());
    const stopChange = onConsentChange((value) => {
      setOpen(false);
      withMetaPixel((pixel) => (value === "granted" ? pixel.loadMetaPixel() : pixel.revokeMetaPixel()));
    });
    const stopReset = onConsentReset(() => {
      withMetaPixel((pixel) => pixel.revokeMetaPixel());
      setOpen(true);
    });
    return () => {
      stopChange();
      stopReset();
    };
  }, []);

  return open ? <ConsentBanner /> : null;
}

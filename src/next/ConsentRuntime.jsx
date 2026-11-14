import { useEffect, useState } from "react";
import ConsentBanner from "../components/ConsentBanner";
import { onConsentChange, onConsentReset, readConsent } from "../lib/consent";
import { withMetaPixel } from "../lib/analyticsModules";
import { storeAttributionForConsent } from "../lib/attributionStore";

const MODAL_DIALOG = '[aria-modal="true"]';

const modalDialogOpen = () => Boolean(document.querySelector(MODAL_DIALOG));

const useModalDialogOpen = (watching) => {
  const [open, setOpen] = useState(modalDialogOpen);
  useEffect(() => {
    if (!watching) return undefined;
    const check = () => setOpen(modalDialogOpen());
    check();
    const observer = new MutationObserver(check);
    const watched = { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] };
    observer.observe(document.body, watched);
    return () => observer.disconnect();
  }, [watching]);
  return open;
};

export default function ConsentRuntime() {
  const [open, setOpen] = useState(() => readConsent() === "unset");
  const dialogOpen = useModalDialogOpen(open);

  useEffect(() => {
    storeAttributionForConsent();
    if (readConsent() === "granted") withMetaPixel((pixel) => pixel.loadMetaPixel());
    const stopChange = onConsentChange((value) => {
      setOpen(false);
      storeAttributionForConsent();
      withMetaPixel((pixel) => (value === "granted" ? pixel.loadMetaPixel() : pixel.revokeMetaPixel()));
    });
    const stopReset = onConsentReset(() => {
      storeAttributionForConsent();
      withMetaPixel((pixel) => pixel.revokeMetaPixel());
      setOpen(true);
    });
    return () => {
      stopChange();
      stopReset();
    };
  }, []);

  return open && !dialogOpen ? <ConsentBanner /> : null;
}

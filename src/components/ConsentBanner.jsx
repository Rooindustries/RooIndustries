import { useLayoutEffect, useRef } from "react";
import { writeConsent } from "../lib/consent";
import { CONSENT_BANNER_SPACE } from "../lib/consentBannerSpace";

const GAP_ABOVE_BANNER = 8;
const CARD = "mx-auto w-full max-w-[26rem] rounded-xl border border-line-input bg-surface-solid p-4 text-ink"
  + " shadow-glow-soft";
const BUTTON = "inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold"
  + " focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-border";

const useReservedSpace = (cardRef) => {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const reserve = () => {
      const top = cardRef.current?.getBoundingClientRect().top ?? window.innerHeight;
      root.style.setProperty(CONSENT_BANNER_SPACE, `${Math.ceil(window.innerHeight - top) + GAP_ABOVE_BANNER}px`);
    };
    reserve();
    const observer = new ResizeObserver(reserve);
    observer.observe(cardRef.current);
    window.addEventListener("resize", reserve);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reserve);
      root.style.removeProperty(CONSENT_BANNER_SPACE);
    };
  }, [cardRef]);
};

export default function ConsentBanner() {
  const cardRef = useRef(null);
  useReservedSpace(cardRef);
  return (
    <div
      role="region"
      aria-label="Cookie choice"
      data-consent-banner=""
      className="fixed inset-x-0 bottom-24 z-[80] px-4 sm:bottom-6 sm:left-6 sm:right-auto sm:px-0"
    >
      <div ref={cardRef} className={CARD}>
        <p className="text-sm leading-relaxed text-ink-muted">
          Roo Industries uses cookies to measure visits and ads. Accept to allow them, or decline and we only keep
          what the site needs.{" "}
          <a href="/privacy" className="font-semibold text-ink underline underline-offset-2">
            Privacy Policy
          </a>
        </p>
        <div className="mt-3 flex gap-3">
          <button type="button" onClick={() => writeConsent("granted")} className={`glow-button ${BUTTON} text-white`}>
            Accept
          </button>
          <button
            type="button"
            onClick={() => writeConsent("denied")}
            className={`${BUTTON} border border-line-input bg-transparent text-ink hover:bg-surface-hover-accent`}
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}

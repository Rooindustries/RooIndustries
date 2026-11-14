import { writeConsent } from "../lib/consent";

const CARD = "mx-auto w-full max-w-[26rem] rounded-xl border border-line-input bg-surface-elevated px-4 py-3 text-ink"
  + " shadow-glow-soft";
const BUTTON = "inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold"
  + " focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-border";

export default function ConsentBanner() {
  return (
    <div
      role="region"
      aria-label="Cookie choice"
      data-consent-banner=""
      className="fixed inset-x-0 bottom-24 z-[80] px-4 sm:bottom-6 sm:left-6 sm:right-auto sm:px-0"
    >
      <div className={CARD}>
        <p className="text-sm leading-5 text-ink-muted">
          Roo Industries uses cookies to measure visits and ads.{" "}
          <a href="/privacy" className="whitespace-nowrap font-semibold text-ink underline underline-offset-2">
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

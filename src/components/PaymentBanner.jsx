import React from "react";

const TONE_CLASS = {
  error: "border-danger-border bg-danger-soft text-danger-text",
  success: "border-success-border bg-success-soft text-success-text",
  info: "border-info-border bg-info-soft text-info-text",
};
const CIRCLE = "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z";
const ICON_PATH = {
  error: `M10 6v4.5m0 3.25h.01${CIRCLE}`,
  success: `m6.75 10.25 2.25 2.25 4.25-4.75${CIRCLE}`,
  info: `M10 9.25V14m0-7.75h.01${CIRCLE}`,
};
const BTN_BASE =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold bg-surface-input text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border";

export default function PaymentBanner({ banner, bannerRef, onChooseNewTime, onRetryQuote, onClose }) {
  if (!banner?.text) return null;
  const tone = TONE_CLASS[banner.type] || TONE_CLASS.info;
  const iconPath = ICON_PATH[banner.type] || ICON_PATH.info;

  return (
    <div className="mt-6 scroll-mt-6 rounded-xl bg-canvas shadow-[0_12px_32px_rgba(0,0,0,0.65)]">
      <div
        ref={bannerRef}
        role={banner.type === "error" ? "alert" : "status"}
        aria-live={banner.type === "error" ? "assertive" : "polite"}
        aria-atomic="true"
        className={`rounded-xl border px-5 py-4 text-sm sm:text-base flex flex-col gap-3.5 sm:flex-row sm:items-start ${tone}`}
      >
        <div className="flex flex-1 items-start gap-3 min-w-0">
          <svg className="mt-0.5 h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
          </svg>
          <div className="min-w-0 max-w-[65ch] break-words">
            <p className="font-semibold leading-snug">{banner.text}</p>
            {banner.detail && (
              <p className="mt-1.5 text-sm leading-relaxed text-ink tabular-nums">{banner.detail}</p>
            )}
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          {banner.chooseNewTime && (
            <button type="button" onClick={onChooseNewTime} className={`${BTN_BASE} w-full border-danger-border sm:w-auto`}>
              Choose a new time
            </button>
          )}
          {banner.retryQuote && (
            <button type="button" onClick={onRetryQuote} className={`${BTN_BASE} w-full border-line-input sm:w-auto`}>
              Retry price check
            </button>
          )}
          <button type="button" onClick={onClose} className={`${BTN_BASE} w-full border-line-input sm:w-auto`}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

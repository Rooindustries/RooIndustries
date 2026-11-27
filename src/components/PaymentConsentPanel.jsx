import React from "react";
import { formatCheckoutAmount } from "../lib/checkoutCodes";
export { default as PaymentBanner } from "./PaymentBanner";
export { countCheckoutStartOnce, paymentStartBody, snapPaymentStart } from "../lib/paymentStartBody";
export { createPaymentConsentActions, ensureConsentBaseline, fetchPaymentProviders, runPayPalApprove } from "../lib/paymentConsentState";

export default function PaymentConsentPanel({
  quoteHold,
  quoteLoading = false,
  onAcceptQuoteHold,
}) {
  if (!quoteHold) return null;
  const currencyChanged = quoteHold.reason === "currency_changed";
  const previousText = formatCheckoutAmount(quoteHold.previousAmount, quoteHold.previousCurrency);
  const currentText = formatCheckoutAmount(quoteHold.amount, quoteHold.currency);

  return (
    <section
      role="region"
      aria-label="Updated checkout price"
      className="mt-6 rounded-2xl bg-canvas shadow-[0_12px_32px_rgba(0,0,0,0.65)]"
    >
      <div className="rounded-2xl border border-warning-border bg-warning-soft px-5 py-5 text-ink">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1.5">
            <h3 className="text-base font-bold text-warning-text sm:text-lg">
              {currencyChanged ? "Checkout currency changed" : "Updated checkout price"}
            </h3>
            <p className="text-sm leading-relaxed text-ink tabular-nums">
              {currencyChanged
                ? `Your confirmed checkout total changed from ${previousText} to ${currentText}. Review and accept the updated price before paying.`
                : `Your confirmed checkout total increased from ${previousText} to ${currentText}. Review and accept the updated price before paying.`}
            </p>
          </div>
          <button
            type="button"
            disabled={quoteLoading}
            onClick={() => onAcceptQuoteHold(quoteHold)}
            className="inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-lg border border-warning-border bg-surface-input px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-border disabled:opacity-60 sm:w-auto"
          >
            Accept updated price
          </button>
        </div>
      </div>
    </section>
  );
}

import React from "react";

const METHODS = [
  ["visa", "Visa"],
  ["mastercard", "Mastercard"],
  ["amex", "American Express"],
  ["discover", "Discover"],
  ["apple-pay", "Apple Pay"],
  ["google-pay", "Google Pay"],
  ["paypal", "PayPal"],
  ["amazon-pay", "Amazon Pay"],
  ["cash-app", "Cash App Pay"],
  ["klarna", "Klarna"],
  ["afterpay", "Afterpay"],
];

export default function PaymentMethods({ className = "" }) {
  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <ul aria-label="Payment methods" className="flex max-w-[22rem] flex-wrap justify-center gap-1 sm:max-w-none sm:gap-2">
        {METHODS.map(([id, name]) => (
          <li key={id}>
            <img
              src={`/payment-methods/${id}.svg`}
              alt={name}
              width={48}
              height={32}
              loading="lazy"
              decoding="async"
              className="block h-8 w-12"
            />
          </li>
        ))}
      </ul>
      <p className="max-w-md text-center text-xs text-ink-secondary">
        You can also pay by ACH bank debit, WeChat Pay or stablecoins.
      </p>
      <p className="max-w-md text-center text-[11px] leading-relaxed text-ink-muted">
        Klarna and Afterpay show up on US orders over $50. Cash App Pay and ACH are US only. In India, checkout skips Google Pay, Amazon Pay, WeChat Pay and stablecoins.
      </p>
    </div>
  );
}

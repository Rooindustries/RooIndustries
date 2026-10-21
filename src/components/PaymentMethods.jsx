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
    <ul aria-label="Payment methods" className={`flex max-w-[22rem] flex-wrap justify-center gap-1 sm:max-w-none sm:gap-2 ${className}`}>
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
  );
}

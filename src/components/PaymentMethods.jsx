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
    <ul role="list" aria-label="Payment methods" className={`flex max-w-[17rem] flex-wrap justify-center gap-1.5 sm:max-w-none ${className}`}>
      {METHODS.map(([id, name]) => (
        <li key={id}>
          <img
            src={`/payment-methods/${id}.svg`}
            alt={name}
            width={36}
            height={24}
            loading="lazy"
            decoding="async"
            className="block h-6 w-9"
          />
        </li>
      ))}
    </ul>
  );
}

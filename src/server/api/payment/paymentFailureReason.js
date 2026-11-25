export const normalizePaymentFailureCount = (value) => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
};

export const PARTIAL_CAPTURE_DODO_STATES = Object.freeze([
  "partially_captured",
  "partially_captured_and_capturable",
]);

export const ACTIVE_OR_PARTIAL_DODO_STATES = Object.freeze([
  "processing",
  "requires_customer_action",
  "requires_merchant_action",
  "requires_confirmation",
  "requires_capture",
  ...PARTIAL_CAPTURE_DODO_STATES,
]);

const FAILURE_ENTRIES = [
  [["insufficient_funds", "not_sufficient_funds"], "insufficient_funds",
    "Your card has insufficient funds. Please try another card or payment method."],
  [["expired_card", "card_expired"], "expired_card",
    "Your card has expired. Please use a different card or payment method."],
  [["incorrect_cvc", "invalid_cvc", "invalid_cvv", "security_code_mismatch"], "incorrect_cvc",
    "The card security code was incorrect. Please check it and try again."],
  [["incorrect_number", "invalid_card_number", "invalid_number"], "incorrect_number",
    "The card number was not accepted. Please check your card details and try again."],
  [["authentication_failed", "authentication_failure", "authentication_required", "3ds_failed", "three_ds_failed"], "authentication_failed",
    "Bank authentication was not completed. Please try again or use another payment method."],
  [["card_declined", "do_not_honor", "generic_decline", "declined", "issuer_declined", "transaction_not_permitted", "pickup_card", "lost_card", "stolen_card", "fraudulent"], "card_declined",
    "Your card was declined by your bank. Please try another card or payment method."],
  [["processing_error", "issuer_unavailable", "gateway_error", "network_error", "try_again_later"], "processing_error",
    "Your bank or payment processor could not process this payment right now. Please try again."],
  [["limit_exceeded", "withdrawal_count_limit_exceeded", "amount_limit_exceeded", "exceeds_withdrawal_amount_limit"], "limit_exceeded",
    "This payment exceeded your card limit. Please try another card or payment method."],
  [["payment_cancelled", "customer_cancelled", "cancelled", "canceled"], "payment_cancelled",
    "The payment was cancelled before completion. Please try again."],
];

const FAILURE_LOOKUP = new Map(
  FAILURE_ENTRIES.flatMap(([aliases, code, message]) =>
    aliases.map((alias) => [alias, Object.freeze({ code, message })])
  )
);

const FALLBACK_FAILURE = Object.freeze({
  code: "payment_failed",
  message: "Your payment could not be completed. Please try again or use another payment method.",
});

export const mapDodoFailureReason = (rawCode) =>
  FAILURE_LOOKUP.get(String(rawCode ?? "").trim().toLowerCase()) || FALLBACK_FAILURE;

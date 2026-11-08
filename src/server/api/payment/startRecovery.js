import { verifyHoldToken } from "../../booking/holdToken.js";
import { checkoutRecoveryDecision } from "../../../lib/checkoutRecovery.js";
import { verifyUpgradeIntentToken, verifyFrozenUpgradeIntent } from "../ref/upgradeIntentToken.js";
import {
  buildPaymentSessionRecordId, buildPaymentSessionScope, getPaymentRecordById,
  PAYMENT_STATUS_STARTED,
} from "./paymentRecord.js";

export const assertPaymentStartState = record => {
  const decision = checkoutRecoveryDecision({ ...record,
    kind: record.bookingPayload?.originalOrderId ? "upgrade" : "booking" });
  if (decision.state === "closed") {
    throw Object.assign(new Error("This checkout is closed. Please review your booking again."), {
      status: 409, code: record.bookingPayload?.originalOrderId ? "upgrade_checkout_closed" : "payment_checkout_closed",
    });
  }
};

export const findStartedPayment = async ({ client, bookingPayload, backend, cutoverGeneration }) => {
  const upgrade = Boolean(bookingPayload.originalOrderId);
  const proof = upgrade
    ? verifyUpgradeIntentToken({ token: bookingPayload.upgradeIntentToken,
      bookingId: bookingPayload.originalOrderId, email: bookingPayload.email,
      targetPackageTitle: bookingPayload.packageTitle, backend, cutoverGeneration, ignoreExpiry: true })
    : verifyHoldToken({ token: bookingPayload.slotHoldToken, holdId: bookingPayload.slotHoldId,
      startTimeUTC: bookingPayload.startTimeUTC, backend, cutoverGeneration, ignoreExpiry: true });
  if (!proof?.n) return null;
  const scope = buildPaymentSessionScope({ bookingPayload, holdNonce: proof.n }) + (upgrade ? `:${proof.n}` : "");
  const record = await getPaymentRecordById(client, buildPaymentSessionRecordId(scope));
  if (!record) return null;
  const stored = record.bookingPayload || {};
  const sameBooking = ["packageTitle", "originalOrderId", "startTimeUTC"].every(
    key => String(stored[key] || "") === String(bookingPayload[key] || "")
  ) && String(stored.email || "").trim().toLowerCase() === bookingPayload.email.toLowerCase();
  const sameOwner = upgrade
    ? record.upgradeIntentSnapshot?.intentId === proof.n && verifyFrozenUpgradeIntent({
      snapshot: record.upgradeIntentSnapshot, bookingId: bookingPayload.originalOrderId,
      email: bookingPayload.email, targetPackageTitle: bookingPayload.packageTitle,
    })
    : stored.slotHoldId === bookingPayload.slotHoldId && Boolean(verifyHoldToken({
      token: stored.slotHoldToken, holdId: bookingPayload.slotHoldId, startTimeUTC: bookingPayload.startTimeUTC,
      holdNonce: proof.n, backend, cutoverGeneration: proof.gen, ignoreExpiry: true,
    }));
  if (!sameBooking || !sameOwner || record.sessionScope !== scope || record.backendOwner !== backend ||
      Number(record.cutoverGeneration || 0) !== Number(proof.gen || 0)) {
    throw Object.assign(new Error("This reservation does not match the checkout."), {
      status: 403, code: "checkout_recovery_invalid",
    });
  }
  assertPaymentStartState(record);
  if (record.provider !== "free" && record.status === PAYMENT_STATUS_STARTED && !record.providerOrderId) {
    throw Object.assign(new Error("This payment session is already creating its provider order."), {
      status: 409, code: "provider_order_creation_in_progress",
    });
  }
  return record;
};

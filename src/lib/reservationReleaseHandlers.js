import { HOLD_STORAGE_KEY, PAYMENT_SESSION_STORAGE_KEY, CHECKOUT_BOOKING_STORAGE_KEY,
  updateStoredCheckoutHold } from "./checkoutStorage";
import { readReservationStorage, writeReservationStorage, removeReservationStorage } from "./reservationStorage";
import { releaseOutdatedHold, reportReservationError, saveReservationReleaseError } from "./reservationOperation";
import { CLIENT_REQUEST_TIMEOUT_MS } from "./clientRequest";
import { classifyHoldResponse } from "./holdResponse";
import { createBookingConfirmation } from "./confirmationReceipt";

export const createReservationReleaseHandlers = ({
  location, navigate, clearHoldState, returnToPayment, myHold, isPaymentPendingHold, currentReservation,
  releaseInFlightRef, mountedRef, currentHoldRef, releasingPayment, setReleasingPayment,
  setErrorStep1, setErrorStep2, setPaymentReleaseStatus, setMyHold, broadcastHold,
}) => {
  const BOOKING_FETCH_TIMEOUT_MS = CLIENT_REQUEST_TIMEOUT_MS;
  const showCapturedPaymentResult = (data, ownsReservation) => {
    const status = String(data.status || "").trim().toLowerCase();
    const bookingId = String(data.bookingId || "").trim();
    if (
      !["booked", "email_partial"].includes(status) ||
      !bookingId
    ) {
      returnToPayment();
      return;
    }

    const bookingConfirmation = createBookingConfirmation(data);
    if (ownsReservation) {
      removeReservationStorage(PAYMENT_SESSION_STORAGE_KEY);
      removeReservationStorage(CHECKOUT_BOOKING_STORAGE_KEY);
      clearHoldState(true);
    }
    const backgroundLocation = location.state?.backgroundLocation || null;
    navigate("/payment-success", {
      replace: true,
      state: {
        bookingConfirmation,
        ...(backgroundLocation ? { backgroundLocation } : {}),
      },
    });
  };

  const releaseHold = async (resetStep = true, { suppressError = false } = {}) => {
    if (!myHold) return true;
    if (isPaymentPendingHold) {
      setErrorStep2(
        "Your payment session is already in progress. Return to payment to finish it."
      );
      return false;
    }

    const holdIdToDelete = myHold.holdId;
    const holdTokenToDelete = myHold.holdToken;
    const hasExpired = () => new Date(myHold.expiresAt).getTime() <= Date.now();
    let isCurrentHold = currentReservation();
    if (classifyHoldResponse({ endpoint: "release", expired: hasExpired() }) === "clear") {
      clearHoldState(resetStep);
      isCurrentHold = currentReservation();
    }
    if (releaseInFlightRef.current) return hasExpired();
    releaseInFlightRef.current = true;
    saveReservationReleaseError(myHold, "");

    let outcome;
    let serverMessage = "";
    try {
      const response = await fetch("/api/releaseHold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdId: holdIdToDelete,
          holdToken: holdTokenToDelete,
        }),
        signal: AbortSignal.timeout(BOOKING_FETCH_TIMEOUT_MS),
      });
      const data = await response.json();
      const message = data?.message || data?.error;
      if (response.status === 409 && typeof message === "string") serverMessage = message;
      outcome = classifyHoldResponse({
        endpoint: "release",
        status: response.status,
        ok: response.ok && data?.ok === true,
        expired: hasExpired(),
      });
    } catch (error) {
      reportReservationError("Failed to release hold on server", error);
      outcome = classifyHoldResponse({ endpoint: "release", networkError: true, expired: hasExpired() });
    } finally {
      releaseInFlightRef.current = false;
    }
    if (!isCurrentHold()) return false;
    if (outcome !== "keep") {
      clearHoldState(resetStep);
      if (mountedRef.current) {
        setErrorStep1("");
        setErrorStep2("");
      }
      return true;
    }
    if (!suppressError) {
      const message = serverMessage || "Could not release your slot. Your reservation and details are saved. Please try again.";
      saveReservationReleaseError(myHold, message);
    }
    return false;
  };

  const releasePaymentSession = async () => {
    if (!isPaymentPendingHold || releasingPayment) return;
    const releasingHold = myHold;
    let isCurrent = currentReservation(releasingHold);
    setReleasingPayment(true);
    setErrorStep2("");
    setPaymentReleaseStatus("");
    saveReservationReleaseError(releasingHold, "");
    try {
      const stored = JSON.parse(
        readReservationStorage(PAYMENT_SESSION_STORAGE_KEY) || "null"
      );
      const paymentAccessToken = String(stored?.paymentAccessToken || "").trim();
      isCurrent = currentReservation(releasingHold, paymentAccessToken);
      if (!paymentAccessToken) {
        throw new Error("Return to payment once so the active session can be checked.");
      }
      const response = await fetch("/api/payment/cancel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paymentAccessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(BOOKING_FETCH_TIMEOUT_MS),
      });
      const data = await response.json().catch(() => ({}));
      if (data?.captured) {
        showCapturedPaymentResult(data, isCurrent());
        return;
      }
      if (!response.ok || data?.cancelled !== true) {
        throw new Error(data?.error || "The payment session could not be released.");
      }
      if (!isCurrent()) {
        if (data?.refreshedHold) {
          await releaseOutdatedHold({
            holdId: data.refreshedHold.slotHoldId,
            holdToken: data.refreshedHold.slotHoldToken,
          });
        }
        return;
      }
      const refreshed = data.refreshedHold;
      if (!refreshed?.slotHoldId || !refreshed?.slotHoldToken) {
        clearHoldState(true);
        if (mountedRef.current) setErrorStep1("The reservation expired. Please choose the slot again.");
        return;
      }
      const nextHold = {
        ...myHold,
        holdId: refreshed.slotHoldId,
        holdToken: refreshed.slotHoldToken,
        expiresAt: refreshed.slotHoldExpiresAt,
        phase: "holding",
      };
      currentHoldRef.current = nextHold;
      writeReservationStorage(HOLD_STORAGE_KEY, JSON.stringify(nextHold));
      const checkoutUpdated = updateStoredCheckoutHold(refreshed);
      removeReservationStorage(PAYMENT_SESSION_STORAGE_KEY);
      broadcastHold(nextHold);
      if (!mountedRef.current) return;
      setMyHold(nextHold);
      setPaymentReleaseStatus(
        checkoutUpdated
          ? "Payment method released. You can choose another payment method."
          : "Payment method released. Review your booking details and submit again."
      );
    } catch (error) {
      reportReservationError("Failed to release payment session", error);
      if (!isCurrent()) return;
      const timedOut =
        error?.name === "AbortError" || error?.name === "TimeoutError";
      saveReservationReleaseError(releasingHold,
        timedOut
          ? "The payment session could not be released. Please try again."
          : error.message || "The payment session could not be released."
      );
      if (mountedRef.current) setPaymentReleaseStatus("");
    } finally {
      if (mountedRef.current) setReleasingPayment(false);
    }
  };

  return { releaseHold, releasePaymentSession };
};

import React, { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const BOOKING_CONFIRMATION_STORAGE_KEY = "booking_confirmation_state";
const TERMINAL_FAILURE_STATUSES = new Set([400, 401, 403, 404]);

const readStoredBookingConfirmation = () => {
  try {
    const raw = sessionStorage.getItem(BOOKING_CONFIRMATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.bookingId && parsed?.emailDispatchToken) {
      return parsed;
    }
  } catch {}

  return null;
};

const clearStoredBookingConfirmation = () => {
  try {
    sessionStorage.removeItem(BOOKING_CONFIRMATION_STORAGE_KEY);
  } catch {}
};

export default function BookingEmailDispatchEffect() {
  const location = useLocation();
  const attemptedKeyRef = useRef("");
  const historyUsrState =
    typeof window !== "undefined" ? window.history?.state?.usr : null;
  const navState = location.state || historyUsrState || {};
  const bookingConfirmation =
    navState.bookingConfirmation || readStoredBookingConfirmation();
  const bookingId = String(bookingConfirmation?.bookingId || "").trim();
  const emailDispatchToken = String(
    bookingConfirmation?.emailDispatchToken || ""
  ).trim();

  useEffect(() => {
    if (!bookingId || !emailDispatchToken) {
      return;
    }

    const attemptKey = `${bookingId}:${emailDispatchToken}`;
    if (attemptedKeyRef.current === attemptKey) {
      return;
    }
    attemptedKeyRef.current = attemptKey;

    let cancelled = false;

    fetch("/api/ref/sendBookingEmails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId,
        emailDispatchToken,
      }),
      keepalive: true,
    })
      .then((response) => {
        if (cancelled) return;

        if (response.ok || TERMINAL_FAILURE_STATUSES.has(response.status)) {
          clearStoredBookingConfirmation();
          return;
        }

        attemptedKeyRef.current = "";
      })
      .catch(() => {
        if (cancelled) return;
        attemptedKeyRef.current = "";
      });

    return () => {
      cancelled = true;
    };
  }, [bookingId, emailDispatchToken]);

  return null;
}

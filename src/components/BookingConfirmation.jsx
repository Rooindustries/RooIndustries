import { useState } from "react";
import { Link } from "react-router-dom";
import BookingEmailDispatchEffect from "./BookingEmailDispatchEffect";
import { readBookingConfirmationReschedule, readBookingConfirmationSummary, useConfirmationReceipt } from "../lib/confirmationReceipt";
import { formatBookingAppointment } from "../lib/bookingSummary";

export default function BookingConfirmation({ free = false }) {
  const receipt = useConfirmationReceipt();
  const requiresReschedule = readBookingConfirmationReschedule(receipt);
  const summary = readBookingConfirmationSummary(receipt);
  const appointment = summary ? formatBookingAppointment(summary) : null;
  const [copyResult, setCopyResult] = useState(null);
  const copyStatus = copyResult?.bookingId === receipt?.bookingId ? copyResult?.message || "" : "";
  const copy = async () => {
    const bookingId = receipt.bookingId;
    try {
      await navigator.clipboard.writeText(bookingId);
      setCopyResult({ bookingId, message: "Copied." });
    } catch {
      setCopyResult({ bookingId, message: "Couldn't copy. Select and copy the reference." });
    }
  };
  return (
    <section className="booking-confirmation-panel w-full text-center text-ink max-w-lg mx-auto">
      {receipt && <BookingEmailDispatchEffect />}
      <h1 key={receipt ? "confirmation-heading" : "neutral-heading"} className="min-h-10 text-4xl font-bold text-accent drop-shadow-[0_0_20px_rgba(56,189,248,0.5)]">
        {receipt ? free ? "Thank You!" : "Payment Successful" : "Looking for your booking?"}
      </h1>
      <p key={receipt ? "confirmation-body" : "neutral-body"} className="mt-4 min-h-12 text-ink-secondary">
        {!receipt ? "This page shows your confirmation right after checkout. If you've booked with us, your confirmation email has the details." : requiresReschedule ? "Your payment went through, but we couldn't confirm the time you selected. Reply to our email or contact us and we'll arrange another time." : free ? "Your booking has been confirmed. You'll receive a confirmation email shortly." : "Your payment was processed and your booking is confirmed. You'll receive a confirmation email shortly."}
      </p>
      <div className="mt-6 min-h-[25rem] text-left">
        {receipt && <>
          <div className="rounded-xl border border-line-input bg-surface-input p-4">
            <dl className="space-y-4">
              <div>
                <dt className="text-sm text-ink-secondary">Order ID</dt>
                <dd className="mt-1 flex items-start gap-3">
                  <code className="min-w-0 flex-1 select-text break-all">{receipt.bookingId}</code>
                  <button type="button" onClick={copy} className="min-h-11 min-w-11 shrink-0 rounded-lg border border-line-input px-3">Copy</button>
                </dd>
              </div>
              {summary ? <>
                <div>
                  <dt className="text-sm text-ink-secondary">Package</dt>
                  <dd>{summary.packageTitle}</dd>
                </div>
                <div>
                  <dt className="text-sm text-ink-secondary">Appointment</dt>
                  <dd>
                    <span className="block">{appointment.dateTime}</span>
                    <span className="block text-sm text-ink-secondary">{appointment.zone}</span>
                  </dd>
                </div>
              </> : <div>
                <dt className="sr-only">Booking details</dt>
                <dd className="text-ink-secondary">Check your confirmation email for the package and appointment details.</dd>
              </div>}
            </dl>
          </div>
          <p role="status" className="mt-2 min-h-12 text-sm text-ink-secondary">{copyStatus}</p>
        </>}
      </div>
      <div className="mt-8 gap-4" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", height: 72 }}>
        {(receipt ? [{ to: "/", label: "Back to Home" }, { to: "/contact", label: "Contact us" }] : [{ to: "/booking", label: "Book a session" }, { to: "/contact", label: "Contact us" }]).map(({ to, label }) => (
          <Link key={to} to={to} className="glow-button inline-flex h-full min-w-0 items-center justify-center gap-2 py-3 px-6 rounded-lg font-semibold transition-all">
            {label}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        ))}
      </div>
    </section>
  );
}

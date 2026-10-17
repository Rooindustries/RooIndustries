import React from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import BookingEmailDispatchEffect from "./BookingEmailDispatchEffect";
import { useConfirmationReceipt } from "../lib/confirmationReceipt";

export default function PaymentSuccess() {
  const receipt = useConfirmationReceipt();
  const containerVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] },
    },
    exit: { opacity: 0, y: -10, transition: { duration: 0.2 } },
  };

  return (
    <motion.section
      className="booking-confirmation-panel text-center text-ink max-w-lg mx-auto"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {receipt && <BookingEmailDispatchEffect />}
      <motion.h1
        key={receipt ? "confirmation-heading" : "neutral-heading"}
        className="min-h-10 text-4xl font-bold text-accent drop-shadow-[0_0_20px_rgba(56,189,248,0.5)]"
        variants={containerVariants}
      >
        {receipt ? "Payment Successful" : "Looking for your booking?"}
      </motion.h1>
      <motion.p key={receipt ? "confirmation-body" : "neutral-body"} className="mt-4 min-h-12 text-ink-secondary" variants={containerVariants}>
        {receipt ? (
          <>
            Your payment was processed and your booking is confirmed. You&apos;ll
            receive a confirmation email shortly.
          </>
        ) : (
          <>
            This page shows your confirmation right after checkout. If you&apos;ve
            booked with us, your confirmation email has the details.
          </>
        )}
      </motion.p>
      <motion.div
        className={receipt ? "mt-8" : "mt-8 min-h-[3.375rem] flex flex-wrap items-center justify-center gap-4"}
        variants={containerVariants}
      >
        {(receipt ? [{ to: "/", label: "Back to Home" }] : [
          { to: "/booking", label: "Book a session" },
          { to: "/contact", label: "Contact us" },
        ]).map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className="glow-button inline-flex items-center justify-center gap-2 py-3 px-6 rounded-lg font-semibold transition-all"
          >
            {label}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        ))}
      </motion.div>
    </motion.section>
  );
}

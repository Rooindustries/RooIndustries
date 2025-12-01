import React from "react";
import { Link } from "react-router-dom";

export default function PaymentSuccess() {
  return (
    <section className="pt-40 text-center text-white max-w-lg mx-auto">
      <h1 className="text-4xl font-bold text-sky-300 drop-shadow-[0_0_20px_rgba(56,189,248,0.5)]">
        Payment Successful ✅
      </h1>
      <p className="mt-4 text-slate-300">
        Your booking has been confirmed. You’ll receive a confirmation email
        shortly.
      </p>
      <Link
        to="/"
        className="glow-button mt-8 inline-flex items-center justify-center gap-2 py-3 px-6 rounded-lg font-semibold transition-all"
      >
        Back to Home
        <span className="glow-line glow-line-top" />
        <span className="glow-line glow-line-right" />
        <span className="glow-line glow-line-bottom" />
        <span className="glow-line glow-line-left" />
      </Link>
    </section>
  );
}

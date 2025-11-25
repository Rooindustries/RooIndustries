import React from "react";
import { Link } from "react-router-dom";

export default function ThankYou() {
  return (
    <section className="pt-40 text-center text-white max-w-lg mx-auto">
      <h1 className="text-4xl font-bold text-sky-300 drop-shadow-[0_0_20px_rgba(56,189,248,0.5)]">
        Thank You! ✅
      </h1>
      <p className="mt-4 text-slate-300">
        Your booking has been confirmed. You’ll receive a confirmation email
        shortly.
      </p>
      <Link
        to="/"
        className="mt-8 inline-block bg-gradient-to-r from-sky-500 to-blue-700 hover:from-sky-400 hover:to-blue-600 py-3 px-6 rounded-lg font-semibold shadow-[0_0_20px_rgba(14,165,233,0.4)] transition-all"
      >
        Back to Home
      </Link>
    </section>
  );
}

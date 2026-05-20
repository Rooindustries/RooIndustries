import React from "react";
import { Link } from "react-router-dom";
import indiaLaunchGate from "../lib/indiaLaunchGate";

export default function BookingComingSoon({
  compact = false,
  title,
  body,
  showHomeLink = true,
}) {
  const copy = indiaLaunchGate.INDIA_BOOKING_COMING_SOON_COPY;

  return (
    <section
      className={`relative z-10 ${
        compact ? "pt-8 pb-10" : "pt-32 pb-24"
      } px-6 text-white`}
    >
      <div className="mx-auto max-w-2xl rounded-2xl border border-sky-500/40 bg-[#071427]/95 px-6 py-8 text-center shadow-[0_0_35px_rgba(14,165,233,0.22)] backdrop-blur-md">
        <div className="mx-auto mb-4 inline-flex items-center rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-cyan-100">
          {copy.button}
        </div>
        <h2 className="text-3xl font-extrabold text-sky-200 sm:text-4xl">
          {title || copy.title}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300 sm:text-base">
          {body || copy.body}
        </p>
        {showHomeLink && (
          <Link
            to="/"
            className="glow-button mt-6 inline-flex items-center justify-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold text-white"
          >
            Return Home
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        )}
      </div>
    </section>
  );
}

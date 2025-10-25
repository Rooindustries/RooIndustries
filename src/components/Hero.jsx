import React from "react";
import { Link } from "react-router-dom";

export default function Hero() {
  return (
    <header className="pt-28" id="top">
      <section className="mx-auto max-w-3xl px-6 text-center">
        {/* Tagline */}
        <div
          className="inline-flex items-center rounded-full border border-slate-700/80 
                     bg-slate-900/70 px-4 sm:px-5 py-1.5 sm:py-2
                     shadow-[0_0_10px_rgba(0,255,255,0.6),0_0_20px_rgba(0,255,255,0.4)]"
        >
          <span className="text-[11px] sm:text-sm font-medium text-slate-200">
            Servi – Professional PC Optimizer
          </span>
        </div>

        {/* Headings */}
        <h1 className="mt-8 text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight">
          Get Your PC Running
        </h1>
        <div
          className="mt-1 text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight 
                     bg-gradient-to-r from-sky-400 to-blue-500 text-transparent 
                     bg-clip-text drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]"
        >
          Better Than New
        </div>

        {/* Description */}
        <p className="mt-4 text-xs sm:text-sm text-slate-300/80 leading-relaxed">
          I fix lag, boost gaming performance, and solve the issues other techs
          can't.
        </p>

        <p className="mt-6 text-[13px] sm:text-base font-semibold text-cyan-300">
          150+ PCs optimized. 100% satisfaction.
        </p>

        {/* Buttons */}
        <div className="mt-7 flex items-center justify-center gap-3 sm:gap-4 flex-wrap">
          <Link
            to="/packages"
            className="rounded-md bg-gradient-to-r from-sky-400 to-sky-600 
                       px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                       ring-1 ring-sky-700/50 hover:from-cyan-400 hover:to-sky-500 
                       hover:shadow-[0_0_20px_rgba(56,189,248,0.6)] 
                       active:translate-y-px transition-all duration-300"
          >
            Supercharge Your Performance Now
          </Link>

          <Link
            to="/faq"
            className="rounded-md bg-gradient-to-r from-sky-600 to-blue-700 
                       px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                       hover:from-sky-500 hover:to-blue-600 
                       hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] 
                       active:translate-y-px transition-all duration-300"
          >
            Got Questions? We Have Answers
          </Link>
        </div>

        {/* Bullets */}
        <div className="mt-8 flex items-center justify-center gap-5 sm:gap-8 text-[10px] sm:text-xs text-slate-300/90">
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-400"></span>
            <span>Same-Day Available</span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-400"></span>
            <span>Expert-Level Service</span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-400"></span>
            <span>150+ Happy Customers</span>
          </div>
        </div>
      </section>
      <div className="h-3" />
    </header>
  );
}

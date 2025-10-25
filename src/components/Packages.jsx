import React from "react";
import { Link } from "react-router-dom";

export default function Packages() {
  return (
    <section className="relative z-10 pt-32 pb-24 text-center text-white">
      {/* Heading */}
      <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Choose Your Package
      </h2>
      <p className="mt-3 text-slate-150 text-sm sm:text-base">
        Select the optimization package that best fits your needs
      </p>

      {/* Cards Container */}
      <div className="mt-12 flex flex-col sm:flex-row justify-center gap-10 px-6 flex-wrap">
        {/* Basic Package */}
        <div className="w-full sm:w-[420px] bg-[#0b1120]/90 border border-sky-600/40 rounded-xl p-6 shadow-[0_0_25px_rgba(14,165,233,0.25)] hover:shadow-[0_0_35px_rgba(14,165,233,0.4)] transition-all duration-500 flex flex-col justify-between">
          <div>
            <h3 className="text-2xl font-semibold">Basic Optimization</h3>
            <p className="text-slate-400 text-sm mt-1">
              Perfect for getting started with optimization
            </p>
            <p className="mt-6 text-5xl font-bold text-sky-400">$50</p>
            <p className="text-slate-400 text-xs font-semibold mt-1">USD</p>

            <ul className="mt-6 space-y-2 text-left text-sm text-slate-300 leading-relaxed">
              <li>✔ Servi choose pls </li>
              <li>✔ Servi choose pls</li>
              <li>✔ Servi choose pls</li>
              <li>✔ Servi choose pls</li>
              <li>✔ OServi choose plst</li>
            </ul>
          </div>

          <button className="mt-8 w-full bg-sky-600 hover:bg-sky-500 text-white py-3 rounded-md font-semibold shadow-[0_0_20px_rgba(56,189,248,0.4)] transition-all duration-300">
            Select Basic Optimization
          </button>
        </div>

        {/* Premium Package */}
        <div className="relative w-full sm:w-[420px] bg-[#0b1120]/90 border border-sky-400/60 rounded-xl p-6 shadow-[0_0_35px_rgba(56,189,248,0.4)] hover:shadow-[0_0_50px_rgba(56,189,248,0.6)] transition-all duration-500 flex flex-col justify-between">
          {/* Tag */}
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-sky-500 text-xs font-bold px-4 py-1 rounded-full shadow-[0_0_15px_rgba(56,189,248,0.6)]">
              Most Popular
            </span>
          </div>

          <div>
            <h3 className="text-2xl font-semibold">Premium Optimization</h3>
            <p className="text-slate-400 text-sm mt-1">
              Complete optimization solution for maximum results
            </p>
            <p className="mt-6 text-5xl font-bold text-sky-400">$100</p>
            <p className="text-slate-400 text-xs font-semibold mt-1">USD</p>

            <ul className="mt-6 space-y-2 text-left text-sm text-slate-300 leading-relaxed">
              <li>✔ Servi choose pls Servi choose pls</li>
              <li>✔ Servi choose pls Servi choose </li>
              <li>✔ Servi choose pls Servi </li>
              <li>✔ Servi choose pls </li>
              <li>✔ Servi choose pls Servi </li>
              <li>✔ Servi choose Servi choose </li>
              <li>✔ Servi choose pls Servi choose pls </li>
            </ul>
          </div>

          <button className="mt-8 w-full bg-gradient-to-r from-sky-500 to-blue-700 hover:from-sky-400 hover:to-blue-600 text-white py-3 rounded-md font-semibold shadow-[0_0_25px_rgba(56,189,248,0.6)] transition-all duration-300">
            Select Premium Optimization
          </button>
        </div>
      </div>

      <Link
        to="/"
        className="inline-block mt-10 text-blue-200 hover:text-sky-400 transition-colors text-sm"
      >
        ← Back to Home
      </Link>
    </section>
  );
}

import React from "react";
import { Link } from "react-router-dom";

export default function Packages() {
  return (
    <section className="relative z-10 pt-32 pb-24 text-center text-white">
      {/* Heading */}
      <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Choose Your Package
      </h2>
      <p className="mt-3 text-slate-300/80 text-sm sm:text-base">
        Select the optimization package that best fits your needs
      </p>

      {/* Cards Container */}
      <div className="mt-12 flex flex-col sm:flex-row justify-center gap-10 px-6 flex-wrap">
        {/* Standard / Prime Optimization */}
        <div className="w-full sm:w-[520px] bg-[#0b1120]/90 border border-sky-600/40 rounded-xl p-6 shadow-[0_0_25px_rgba(14,165,233,0.25)] hover:shadow-[0_0_35px_rgba(14,165,233,0.4)] transition-all duration-500 flex flex-col justify-between">
          <div>
            <h3 className="text-2xl font-semibold">
              Standard Performance Optimization
            </h3>
            <p className="mt-6 text-5xl font-bold text-sky-400">$79.99</p>

            <ul className="mt-6 space-y-2 text-left text-sm text-slate-300 leading-relaxed">
              <li>
                ✔ Guaranteed boost in performance (latency, 1% lows, or average
                FPS)
              </li>
              <li>✔ 30 day warranty</li>
              <li>✔ 3–4 hour completion time</li>
              <li>✔ Same day availability</li>
              <li>✔ Overclocking of CPU, GPU, and RAM (Timings)</li>
              <li>
                ✔ Troubleshooting issues and full hardware/software inspection
              </li>
              <li>✔ Hidden BIOS optimizations</li>
              <li>✔ Smooth frametimes</li>
              <li>✔ Benchmark guaranteed results</li>
              <li>
                ✔ Fan curves, sound tuning, and input latency–based adjustments
              </li>
              <li>✔ Proper core allocation and game process prioritization</li>
              <li>✔ Network driver optimization</li>
              <li>✔ 30 day warranty plus future support at discretion</li>
            </ul>
          </div>

          <button className="mt-8 w-full bg-sky-600 hover:bg-sky-500 text-white py-3 rounded-md font-semibold shadow-[0_0_20px_rgba(56,189,248,0.4)] transition-all duration-300">
            Book Now
          </button>
        </div>

        {/* XOC / Extreme Overclocking */}
        <div className="relative w-full sm:w-[520px] bg-[#0b1120]/90 border border-sky-400/60 rounded-xl p-6 shadow-[0_0_35px_rgba(56,189,248,0.4)] hover:shadow-[0_0_50px_rgba(56,189,248,0.6)] transition-all duration-500 flex flex-col justify-between">
          {/* Tag */}
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-sky-500 text-xs font-bold px-4 py-1 rounded-full shadow-[0_0_15px_rgba(56,189,248,0.6)]">
              Most Popular
            </span>
          </div>

          <div>
            <h3 className="text-2xl font-semibold">
              XOC / Extreme Overclocking
            </h3>

            <p className="mt-6 text-5xl font-bold text-sky-400">$199.99</p>

            <ul className="mt-6 space-y-2 text-left text-sm text-slate-300 leading-relaxed">
              <li>✔ Includes everything from Prime Performance Optimization</li>
              <li>
                ✔ 3 days of extensive RAM overclocking (frequency & timings)
                with full stress testing
              </li>
              <li>
                ✔ 3 days of CPU overclocking using all high-end motherboard
                tools
              </li>
              <li>
                ✔ 1 full day of GPU overclocking, curve building, and voltage
                tuning
              </li>
              <li>✔ Lifetime warranty with 24h turn-around support</li>
              <li>
                ✔ Future upgrade path — upgrade a single component, multiple
                ones, or your entire PC every 6 months
              </li>
              <li>✔ Exclusively for Ryzen systems above AM5</li>
            </ul>
          </div>

          <button className="mt-8 w-full bg-gradient-to-r from-sky-500 to-blue-700 hover:from-sky-400 hover:to-blue-600 text-white py-3 rounded-md font-semibold shadow-[0_0_25px_rgba(56,189,248,0.6)] transition-all duration-300">
            Book Now
          </button>
        </div>
      </div>

      {/* Contact Us button */}
      <div className="mt-14 flex justify-center">
        <Link
          to="/contact"
          className="px-8 py-3 text-[15px] font-semibold rounded-md bg-gradient-to-r from-sky-400 to-blue-700 hover:from-sky-400 hover:to-blue-600 text-white shadow-[0_0_25px_rgba(56,189,248,0.6)] transition-all duration-300 hover:scale-105"
        >
          Contact Us For More Info
        </Link>
      </div>
    </section>
  );
}

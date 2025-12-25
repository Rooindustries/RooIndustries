import React from "react";
import { Link, useLocation } from "react-router-dom";
import { FaDiscord } from "react-icons/fa";

export default function Footer() {
  const location = useLocation();

  const searchParams = new URLSearchParams(location.search);
  const isXocBookingForm =
    location.pathname === "/booking" && searchParams.get("xoc") === "1";

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <footer className="relative mt-auto pt-8">
      <div className="relative border-t border-cyan-300/10 bg-gradient-to-b from-[#07162d]/95 to-[#061226]/95">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/35 to-transparent" />

        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4">
        <div className="flex flex-col md:flex-row items-center gap-3 pb-3 border-b border-cyan-300/10">
          <Link to="/" className="flex items-center gap-3 select-none">
            <img
              src="/favicon.svg"
              alt="Roo Industries"
              className="h-14 w-14 sm:h-16 sm:w-16 object-contain drop-shadow-[0_0_14px_rgba(34,211,238,0.30)]"
              loading="lazy"
              decoding="async"
            />
          </Link>

          <div className="w-full md:w-auto md:ml-auto flex flex-col md:flex-row items-center md:items-center gap-4">
            <nav className="flex flex-wrap items-center justify-center md:justify-end gap-x-7 gap-y-2 text-xs font-semibold tracking-wide uppercase text-white/70">
              <Link
                to="/privacy"
                className="hover:text-cyan-400 transition-colors"
              >
                Privacy Policy
              </Link>
              <Link
                to="/terms"
                className="hover:text-cyan-400 transition-colors"
              >
                Terms of Service
              </Link>
              <Link
                to="/tools"
                className="hover:text-cyan-400 transition-colors"
              >
                Tools
              </Link>
              <a
                href="https://www.trustpilot.com/review/rooindustries.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide uppercase text-white/70 hover:text-cyan-400 transition-colors"
              >
                <img
                  src="/trustpilot-star.png"
                  alt="Trustpilot"
                  loading="lazy"
                  decoding="async"
                  className="h-[1.15em] w-auto -translate-y-[0.1em] object-contain"
                />
                Review on Trustpilot
              </a>
            </nav>

            <a
              href="https://discord.gg/M7nTkn9dxE"
              target="_blank"
              rel="noopener noreferrer"
              className="h-12 w-12 rounded-full border border-cyan-300/25 bg-cyan-400/10 flex items-center justify-center text-white/90 hover:text-cyan-200 hover:border-cyan-300/55 hover:bg-cyan-400/20 transition-all shadow-[0_0_18px_rgba(34,211,238,0.12)]"
              aria-label="Discord"
            >
              <FaDiscord className="text-[28px]" />
            </a>
          </div>
        </div>

        <div className="py-2 flex justify-center md:justify-end">
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md">
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-white/10 bg-[#0b1830]/60">
              <img
                src="/newVisa.png"
                alt="Visa"
                className="h-7 w-auto object-contain"
                loading="lazy"
                decoding="async"
              />
            </span>
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-white/10 bg-[#0b1830]/60">
              <img
                src="/mastercard.jpg"
                alt="Mastercard"
                className="h-7 w-auto object-contain"
                loading="lazy"
                decoding="async"
              />
            </span>
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-white/10 bg-[#0b1830]/60">
              <img
                src="/newAmex.png"
                alt="American Express"
                className="h-7 w-auto object-contain"
                loading="lazy"
                decoding="async"
              />
            </span>
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-white/10 bg-[#0b1830]/60">
              <img
                src="/newPaypal.png"
                alt="PayPal"
                className="h-7 w-auto object-contain"
                loading="lazy"
                decoding="async"
              />
            </span>
          </div>
        </div>

        <div className="flex flex-col md:flex-row items-center justify-between gap-3 pt-1">
          <div className="flex flex-col items-center md:items-start gap-1">
            <p className="text-[11px] text-white/45">
              © {new Date().getFullYear()} Roo Industries. All rights reserved.
            </p>

            <p className="text-[11px] text-white/35">
              Designed by{" "}
              <a
                href="https://discord.com/users/286457824081346570"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400/70 hover:text-cyan-400 transition-colors"
              >
                Nerky
              </a>{" "}
              &{" "}
              <a
                href="https://discord.com/users/1074948989083979837"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400/70 hover:text-cyan-400 transition-colors"
              >
                Exyy
              </a>
            </p>
          </div>

          <button
            onClick={scrollToTop}
            className="flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase text-white/45 hover:text-cyan-400 transition-colors group"
          >
            To the top
            <span className="text-cyan-400 group-hover:translate-y-[-2px] transition-transform">
              ▲
            </span>
          </button>
        </div>

        {isXocBookingForm && (
          <p className="mt-2 text-center text-[11px] text-cyan-400/50">
            Refunds will not be issued in case you proceed with
            unsupported/custom parts. Please join the Discord and open a ticket
            or DM <span className="font-semibold">serviroo</span> to check for
            eligibility or switch to one of our other specialized plans.
          </p>
        )}
        </div>
      </div>
    </footer>
  );
}

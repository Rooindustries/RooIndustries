"use client";

import { FaDiscord } from "react-icons/fa";

export default function TourneyFooter() {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <footer className="tourney-footer relative mt-auto">
      <div className="tourney-footer-surface relative">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-8 pb-4">
          <div className="tourney-footer-divider flex flex-col md:flex-row items-center gap-3 pb-3 border-b">
            <a href="/" className="flex items-center gap-3 select-none">
              <img
                src="/favicon-96x96.png"
                alt="Roo Industries"
                className="tourney-footer-logo h-14 w-14 sm:h-16 sm:w-16 object-contain"
                loading="lazy"
                decoding="async"
                width={64}
                height={64}
              />
            </a>

            <div className="w-full md:w-auto md:ml-auto flex flex-col md:flex-row items-center md:items-center gap-4">
              <nav className="flex flex-wrap items-center justify-center md:justify-end gap-x-7 gap-y-2 text-xs font-semibold tracking-wide uppercase">
                <a href="/privacy" className="tourney-footer-link transition-colors">
                  Privacy Policy
                </a>
                <a href="/terms" className="tourney-footer-link transition-colors">
                  Terms of Service
                </a>
                <a href="/tools" className="tourney-footer-link transition-colors">
                  Tools
                </a>
                <a
                  href="/referrals/register"
                  className="tourney-footer-link transition-colors"
                >
                  Referrals
                </a>
                <a
                  href="/meet-the-team"
                  className="tourney-footer-link transition-colors"
                >
                  Meet the team
                </a>
                <a
                  href="https://www.trustpilot.com/review/rooindustries.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tourney-footer-link inline-flex items-center gap-2 text-xs font-semibold tracking-wide uppercase transition-colors"
                >
                  <img
                    src="/trustpilot-star.png"
                    alt="Trustpilot"
                    loading="lazy"
                    decoding="async"
                    width={96}
                    height={96}
                    className="h-[1.15em] w-auto -translate-y-[0.1em] object-contain"
                  />
                  Review on Trustpilot
                </a>
              </nav>

              <a
                href="https://discord.com/invite/qs5HKNyazD"
                target="_blank"
                rel="noopener noreferrer"
                className="tourney-footer-discord h-12 w-12 rounded-full border flex items-center justify-center transition-all"
                aria-label="Discord"
              >
                <FaDiscord className="text-[28px]" />
              </a>
            </div>
          </div>

          <div className="py-2 flex justify-center md:justify-end">
            <div className="tourney-footer-payments inline-flex items-center gap-3 px-4 py-2 rounded-2xl border backdrop-blur-md">
              <span className="tourney-footer-payment-card grid place-items-center h-10 w-14 rounded-xl border">
                <img
                  src="/newVisa.png"
                  alt="Visa"
                  className="h-7 w-auto object-contain"
                  loading="lazy"
                  decoding="async"
                  width={240}
                  height={152}
                />
              </span>
              <span className="tourney-footer-payment-card grid place-items-center h-10 w-14 rounded-xl border">
                <img
                  src="/mastercard.jpg"
                  alt="Mastercard"
                  className="h-7 w-auto object-contain"
                  loading="lazy"
                  decoding="async"
                  width={220}
                  height={128}
                />
              </span>
              <span className="tourney-footer-payment-card grid place-items-center h-10 w-14 rounded-xl border">
                <img
                  src="/newAmex.png"
                  alt="American Express"
                  className="h-7 w-auto object-contain"
                  loading="lazy"
                  decoding="async"
                  width={50}
                  height={30}
                />
              </span>
              <span className="tourney-footer-payment-card grid place-items-center h-10 w-14 rounded-xl border">
                <img
                  src="/newPaypal.png"
                  alt="PayPal"
                  className="h-7 w-auto object-contain"
                  loading="lazy"
                  decoding="async"
                  width={50}
                  height={30}
                />
              </span>
            </div>
          </div>

          <div className="flex flex-col md:flex-row items-center justify-between gap-3 pt-1">
            <div className="flex flex-col items-center md:items-start gap-1">
              <p className="tourney-footer-muted text-[11px]">
                © {new Date().getFullYear()} Roo Industries. All rights reserved.
              </p>

              <p className="tourney-footer-subtle text-[11px]">
                Designed by{" "}
                <a
                  href="https://discord.com/users/286457824081346570"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tourney-footer-credit-link transition-colors"
                >
                  Nerky
                </a>{" "}
                &{" "}
                <a
                  href="https://discord.com/users/1074948989083979837"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tourney-footer-credit-link transition-colors"
                >
                  Exyy
                </a>
              </p>
            </div>

            <button
              onClick={scrollToTop}
              className="tourney-footer-top flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase transition-colors group"
              type="button"
            >
              To the top
              <span className="tourney-footer-top-arrow group-hover:translate-y-[-2px] transition-transform">
                ▲
              </span>
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}

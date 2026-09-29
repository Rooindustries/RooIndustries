import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { FaDiscord } from "react-icons/fa";
import packagePricing from "../lib/packagePricing";
import { readBookingPackageSelection } from "../lib/checkoutStorage";

const { isTopPackageTitle } = packagePricing;

export default function Footer() {
  const location = useLocation();

  const [storedPackage, setStoredPackage] = useState(null);
  useEffect(() => {
    setStoredPackage(readBookingPackageSelection());
  }, [location.key, location.pathname, location.state]);
  const navigationPackage =
    location.state?.bookingPackage || location.state?.bookingData || null;
  const isXocBookingForm =
    location.pathname === "/booking" &&
    isTopPackageTitle(
      navigationPackage?.title ||
        navigationPackage?.packageTitle ||
        storedPackage?.title
    );

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <footer className="relative mt-auto">
      <div className="relative bg-panel">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-8 pb-4">
        <div className="flex flex-col md:flex-row items-center gap-3 pb-3 border-b border-line-soft">
          <Link to="/" className="flex items-center gap-3 select-none">
            <img
              src="/favicon-96x96.png"
              alt="Roo Industries"
              className="h-14 w-14 sm:h-16 sm:w-16 object-contain drop-shadow-[0_0_14px_rgba(34,211,238,0.30)]"
              loading="lazy"
              decoding="async"
              width={64}
              height={64}
            />
          </Link>

          <div className="w-full md:w-auto md:ml-auto flex flex-col md:flex-row items-center md:items-center gap-4">
            <nav className="flex flex-wrap items-center justify-center md:justify-end gap-x-7 gap-y-2 text-xs font-semibold tracking-wide uppercase text-ink-secondary">
              {[["/packages", "Packages"], ["/faq", "FAQ"], ["/contact", "Contact"], ["/BIOSGuide", "BIOS Guide"]].map(([href, label]) => (
                <a key={href} href={href} className="hover:text-[color:var(--color-link-hover)] transition-colors">{label}</a>
              ))}
              {[["/tools", "Tools"], ["/about", "About"]].map(([to, label]) => (
                <Link key={to} to={to} className="hover:text-[color:var(--color-link-hover)] transition-colors">{label}</Link>
              ))}
            </nav>

            <div className="flex items-center gap-3">
              <a
                href="https://www.trustpilot.com/review/rooindustries.com"
                target="_blank"
                rel="noopener noreferrer"
                className="h-12 w-12 rounded-full border border-line-accent bg-info-soft flex items-center justify-center hover:border-line-accent hover:bg-surface-hover-accent transition-all shadow-info-soft"
                aria-label="Review us on Trustpilot"
                title="Review us on Trustpilot"
              >
                <img
                  src="/trustpilot-star.png"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width={96}
                  height={96}
                  className="h-6 w-6 object-contain"
                />
              </a>
              <a
                href="https://discord.com/invite/qs5HKNyazD"
                target="_blank"
                rel="noopener noreferrer"
                className="h-12 w-12 rounded-full border border-line-accent bg-info-soft flex items-center justify-center text-ink-secondary hover:text-[color:var(--color-link-hover)] hover:border-line-accent hover:bg-surface-hover-accent transition-all shadow-info-soft"
                aria-label="Discord"
              >
                <FaDiscord className="text-[28px]" />
              </a>
            </div>
          </div>
        </div>

        <div className="py-2 flex justify-center md:justify-end">
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-2xl border border-line-soft bg-surface-veil backdrop-blur-md">
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-line-soft bg-surface-input">
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
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-line-soft bg-surface-input">
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
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-line-soft bg-surface-input">
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
            <span className="grid place-items-center h-10 w-14 rounded-xl border border-line-soft bg-surface-input">
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
            <p className="text-center md:text-left text-[11px] text-ink-muted">
              <span className="block md:inline">
                © {new Date().getFullYear()} Roo Industries. All rights reserved.
              </span>
              {[["/privacy", "Privacy Policy"], ["/terms", "Terms of Service"]].map(([to, label], index) => (
                <React.Fragment key={to}>
                  <span aria-hidden="true" className={`mx-2 ${index === 0 ? "hidden md:inline" : ""}`}>·</span>
                  <Link to={to} className="whitespace-nowrap hover:text-[color:var(--color-link-hover)] transition-colors">{label}</Link>
                </React.Fragment>
              ))}
            </p>

            <p className="text-[11px] text-ink-muted">
              Designed by{" "}
              <a
                href="https://discord.com/users/286457824081346570"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-[color:var(--color-link-hover)] transition-colors"
              >
                Nerky
              </a>{" "}
              &{" "}
              <a
                href="https://discord.com/users/1074948989083979837"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-[color:var(--color-link-hover)] transition-colors"
              >
                Exyy
              </a>
            </p>
          </div>

          <button
            onClick={scrollToTop}
            className="flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase text-ink-muted hover:text-[color:var(--color-link-hover)] transition-colors group"
          >
            To the top
            <span className="text-accent group-hover:translate-y-[-2px] transition-transform">
              ▲
            </span>
          </button>
        </div>

        {isXocBookingForm && (
          <p className="mt-2 text-center text-[11px] text-ink-muted">
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

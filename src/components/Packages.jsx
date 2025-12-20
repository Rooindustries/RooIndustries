import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { client } from "../sanityClient";
import PackageDetailsModal from "./PackageDetailsModal";

export default function Packages() {
  const [packages, setPackages] = useState([]);
  const [globalBullets, setGlobalBullets] = useState([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPkg, setDetailsPkg] = useState(null);

  const location = useLocation();
  const bookingState = {
    backgroundLocation: location.state?.backgroundLocation || location,
  };
  const UPGRADE_FAQ_HASH = "upgrade-path";

  const openDetails = (pkg) => {
    setDetailsPkg(pkg);
    setDetailsOpen(true);
  };

  const closeDetails = () => {
    setDetailsOpen(false);
    setDetailsPkg(null);
  };

  const renderFeatureText = (text) => {
    if (!text) return null;

    const linkRegex = /(Future Upgrade Path)/i;
    const boldRegex = /(Lifetime)/i;

    return text.split(boldRegex).map((part, i) => {
      if (boldRegex.test(part)) {
        return (
          <span key={i} className="font-bold text-white">
            {part}
          </span>
        );
      }
      return part.split(linkRegex).map((subPart, j) => {
        if (linkRegex.test(subPart)) {
          return (
            <Link
              key={`${i}-${j}`}
              to={`/#${UPGRADE_FAQ_HASH}`}
              className="underline underline-offset-2 transition"
              style={{ color: "#22D3EE" }}
            >
              {subPart}
            </Link>
          );
        }
        return subPart;
      });
    });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");

    if (ref) {
      try {
        localStorage.setItem("referral", ref);
      } catch (e) {
        console.error("Failed to store referral from link:", e);
      }
    }

    const packagesQuery = `*[_type == "package"] | order(coalesce(order, 999) asc, _createdAt asc) {
      _id,
      title,
      price,
      tag,
      description,
      includedBullets[]->{ _id },
      features,
      buttonText,
      isHighlighted,
      order
    }`;

    const bulletsQuery = `*[_type == "packageBullet"] | order(coalesce(order, 999) asc, _createdAt asc) {
      _id,
      label,
      order
    }`;

    Promise.all([client.fetch(packagesQuery), client.fetch(bulletsQuery)])
      .then(([pkgs, bullets]) => {
        setPackages(Array.isArray(pkgs) ? pkgs : []);
        setGlobalBullets(Array.isArray(bullets) ? bullets : []);
      })
      .catch(console.error);
  }, []);

  const hasGlobalBullets = globalBullets.length > 0;

  return (
    <section
      id="packages"
      className="relative z-10 pt-32 pb-24 text-center text-white"
    >
      <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Choose Your Package
      </h2>

      <div className="mt-4 flex justify-center">
        <span className="inline-flex items-center gap-2.5 px-5 py-2 rounded-full text-sm sm:text-[0.95rem] font-semibold bg-slate-900/80 text-cyan-100 border border-cyan-400/40 shadow-[0_0_18px_rgba(56,189,248,0.7)]">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
          Fully Online
        </span>
      </div>

      <p className="mt-3 text-slate-300/80 text-sm sm:text-base">
        Select the tuning package that best fits your needs
      </p>

      <div className="mt-12 flex flex-col sm:flex-row justify-center gap-10 px-6 flex-wrap">
        {packages.map((p, i) => {
          const isXoc = p.title === "XOC / Extreme Overclocking";

          const includedSet = new Set(
            (p.includedBullets || []).map((b) => b?._id).filter(Boolean)
          );
          const orderedBullets = hasGlobalBullets
            ? [
                ...globalBullets.filter((b) => includedSet.has(b._id)),
                ...globalBullets.filter((b) => !includedSet.has(b._id)),
              ]
            : [];

          return (
            <div
              key={p._id || i}
              className={`relative w-full sm:w-[500px] border rounded-xl px-7 py-7 transition-all duration-500 flex flex-col bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 text-base sm:text-lg ${
                p.isHighlighted
                  ? "border-sky-400/60 shadow-[0_0_35px_rgba(56,189,248,0.4)] hover:shadow-[0_0_50px_rgba(56,189,248,0.6)]"
                  : "border-sky-600/40 shadow-[0_0_25px_rgba(14,165,233,0.25)] hover:shadow-[0_0_35px_rgba(14,165,233,0.4)]"
              } min-h-[620px]`}
            >
              {p.tag && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-block whitespace-nowrap bg-sky-500 text-sm font-bold px-4 py-1 rounded-full shadow-[0_0_15px_rgba(56,189,248,0.6)]">
                    {p.tag}
                  </span>
                </div>
              )}

              {/* Top content */}
              <div>
                <h3 className="text-3xl font-semibold">{p.title}</h3>

                <p className="mt-6 text-6xl font-bold text-sky-400">
                  {p.price}
                </p>

                {p.description && (
                  <p className="mt-4 text-left text-base sm:text-lg leading-relaxed text-slate-300/85">
                    {p.description}
                  </p>
                )}

                <div className="mt-5 border-t border-white/10" />

                <div className="mt-5">
                  <ul className="w-full space-y-2.5 text-left text-base sm:text-lg text-slate-300 leading-relaxed">
                    {hasGlobalBullets ? (
                      orderedBullets.map((b) => {
                        const on = includedSet.has(b._id);
                        return (
                          <li
                            key={b._id}
                            className={`flex items-start gap-2 transition ${
                              on ? "opacity-100" : "opacity-35"
                            }`}
                          >
                            <span
                              className={`mt-0.5 inline-flex h-5 w-6 shrink-0 items-center justify-center ${
                                on ? "text-sky-400" : "text-slate-500"
                              }`}
                            >
                              {on ? "✓" : "○"}
                            </span>
                            <span className="flex-1">{b.label}</span>
                          </li>
                        );
                      })
                    ) : (
                      <li className="text-sm text-slate-400/70">
                        (No global bullets yet — create 6 “Package Bullet
                        (Global)” items in Sanity.)
                      </li>
                    )}
                  </ul>
                </div>
              </div>

              {/* Bottom buttons pinned to bottom */}
              <div className="mt-auto pt-7 flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={() => openDetails(p)}
                  className="w-full sm:w-1/2 rounded-md border border-sky-500/40 bg-slate-900/40 py-3 text-base font-semibold text-sky-100 shadow-[0_0_15px_rgba(56,189,248,0.2)] transition hover:bg-slate-900/70 hover:text-white"
                >
                  Full Breakdown
                </button>

                <Link
                  to={`/booking?title=${encodeURIComponent(
                    p.title
                  )}&price=${encodeURIComponent(
                    p.price
                  )}&tag=${encodeURIComponent(p.tag || "")}&xoc=${
                    isXoc ? "1" : "0"
                  }`}
                  state={bookingState}
                  className="glow-button w-full sm:w-1/2 text-white text-lg py-3 rounded-md font-semibold shadow-[0_0_20px_rgba(56,189,248,0.4)] transition-all duration-300 text-center inline-flex items-center justify-center gap-2"
                >
                  {p.buttonText || "Book Now"}
                  <span className="glow-line glow-line-top" />
                  <span className="glow-line glow-line-right" />
                  <span className="glow-line glow-line-bottom" />
                  <span className="glow-line glow-line-left" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <PackageDetailsModal
        open={detailsOpen}
        onClose={closeDetails}
        pkg={detailsPkg}
        renderFeature={renderFeatureText}
      />
    </section>
  );
}

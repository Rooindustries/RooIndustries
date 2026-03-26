import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import PackageDetailsModal from "./PackageDetailsModal";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
  readHomeSectionData,
} from "../lib/homeSectionData";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";

const REFERRAL_STORAGE_KEY = "referral_session";

const MINOR_WORDS = new Set([
  "a","an","and","as","at","but","by","for","if","in","nor","of","on","or","so","that","the","to","up","via","yet",
]);

const capitalizeWord = (w) => w.charAt(0).toUpperCase() + w.slice(1);

const toTitleCase = (str) =>
  str.replace(/\S+/g, (word, idx) => {
    if (idx > 0 && MINOR_WORDS.has(word.toLowerCase())) return word.toLowerCase();
    return word.split("-").map(capitalizeWord).join("-");
  });

export default function Packages({
  initialPackages = null,
  initialSectionCopy = null,
}) {
  const handleHomeSectionLink = useHomeSectionLinkHandler();
  const [packages, setPackages] = useState(() =>
    initialPackages !== null
      ? Array.isArray(initialPackages)
        ? initialPackages
        : []
      : []
  );
  const [sectionCopy, setSectionCopy] = useState(() => initialSectionCopy);

  useEffect(() => {
    if (initialPackages !== null) {
      setPackages(Array.isArray(initialPackages) ? initialPackages : []);
    }

    if (initialSectionCopy !== null) {
      setSectionCopy(initialSectionCopy);
    }
  }, [initialPackages, initialSectionCopy]);
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
              onClick={(event) =>
                handleHomeSectionLink(event, `#${UPGRADE_FAQ_HASH}`)
              }
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

  const normalizeBullets = (items) =>
    Array.isArray(items)
      ? items
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
      : [];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");

    if (ref) {
      try {
        sessionStorage.setItem(REFERRAL_STORAGE_KEY, ref);
        localStorage.setItem("referral", ref);
      } catch (e) {
        console.error("Failed to store referral from link:", e);
      }
    }

    if (packages.length === 0) {
      const cachedPackages = readHomeSectionData(HOME_SECTION_DATA_KEYS.packagesList);
      if (Array.isArray(cachedPackages)) {
        setPackages(cachedPackages);
      } else {
        fetchHomeSectionData(HOME_SECTION_DATA_KEYS.packagesList)
          .then((pkgs) => {
            setPackages(Array.isArray(pkgs) ? pkgs : []);
          })
          .catch(console.error);
      }
    }

    if (sectionCopy === null) {
      const cachedSectionCopy = readHomeSectionData(
        HOME_SECTION_DATA_KEYS.packagesSettings
      );
      if (cachedSectionCopy !== null) {
        setSectionCopy(cachedSectionCopy);
      } else {
        fetchHomeSectionData(HOME_SECTION_DATA_KEYS.packagesSettings)
          .then(setSectionCopy)
          .catch(console.error);
      }
    }
  }, [packages.length, sectionCopy]);

  const headingText = sectionCopy?.heading ?? "Choose Your Package";
  const badgeText = sectionCopy?.badgeText ?? "Remote Sessions";
  const subheadingText =
    sectionCopy?.subheading ?? "Select the tuning package that best fits your needs";
  const dividerText = sectionCopy?.dividerText;
  const isLoading = !sectionCopy && packages.length === 0;

  if (isLoading) {
    return (
      <section className="relative z-10 pt-32 pb-24 text-center text-white" aria-hidden="true">
        <div className="mt-12 px-6">
          <div className="mx-auto max-w-6xl min-h-[1320px] rounded-3xl border border-sky-700/20 bg-gradient-to-b from-[#0d1526]/70 to-[#08101d]/80" />
        </div>
      </section>
    );
  }

  return (
    <section className="relative z-10 pt-32 pb-24 text-center text-white">
      {headingText && (
        <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          {headingText}
        </h2>
      )}

      {badgeText && (
        <div className="mt-4 flex justify-center">
          <span className="inline-flex items-center gap-2.5 px-5 py-2 rounded-full text-sm sm:text-[0.95rem] font-semibold bg-slate-900 text-cyan-50 border border-cyan-400/40 shadow-[0_0_18px_rgba(56,189,248,0.7)]">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
            {badgeText}
          </span>
        </div>
      )}

      {subheadingText && (
        <p className="mt-3 text-slate-300/80 text-sm sm:text-base">
          {subheadingText}
        </p>
      )}

      <Link
        to="/reviews"
        className="mt-3 inline-flex items-center justify-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
      >
        <span className="text-amber-400">{"★".repeat(5)}</span>
        <span>5.0 avg from 89+ verified reviews</span>
      </Link>

      <div className="mt-12 px-4 sm:px-6">
        <div className="mx-auto w-fit max-w-full">
          <div className="flex flex-col sm:flex-row justify-center gap-6 sm:gap-10 flex-wrap">
            {packages.map((p, i) => {
              const isXoc = /^xoc/i.test(p.title);

              const checkedBullets = normalizeBullets(p.checkedBullets);
              const uncheckedBullets = normalizeBullets(p.uncheckedBullets);
              const orderedBullets = [
                ...checkedBullets.map((label) => ({ label, checked: true })),
                ...uncheckedBullets.map((label) => ({ label, checked: false })),
              ];
              const hasBullets = orderedBullets.length > 0;

              return (
                <div
                  key={p._id || i}
                  className={`relative w-full sm:w-[500px] border rounded-xl px-5 sm:px-7 py-6 sm:py-7 transition-all duration-500 flex flex-col bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 text-base sm:text-lg ${
                    p.isHighlighted
                      ? "border-sky-400/60 shadow-[0_0_35px_rgba(56,189,248,0.4)] hover:shadow-[0_0_50px_rgba(56,189,248,0.6)]"
                      : "border-sky-600/40 shadow-[0_0_25px_rgba(14,165,233,0.25)] hover:shadow-[0_0_35px_rgba(14,165,233,0.4)]"
                  } sm:min-h-[620px]`}
                >
                  {p.tag && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span
                        className={`inline-flex items-center whitespace-nowrap text-sm font-bold px-4 py-1 rounded-full ${
                          p.tagGoldGlow
                            ? "border border-amber-300/70 gold-flair-pill"
                            : "bg-sky-700 shadow-[0_0_15px_rgba(56,189,248,0.6)]"
                        }`}
                      >
                        {p.tagGoldGlow ? (
                          <span className="gold-flair-text">{p.tag}</span>
                        ) : (
                          p.tag
                        )}
                      </span>
                    </div>
                  )}

                  {/* Top content */}
                  <div>
                    <h3 className="text-3xl font-semibold">{p.title}</h3>

                    <p className="mt-6 text-6xl font-bold text-sky-400">
                      {p.price}
                    </p>

                    {p.description && (() => {
                      const bestForMatch = p.description.match(/Best for:\s*(.+)/i);
                      const mainDesc = bestForMatch
                        ? p.description.slice(0, bestForMatch.index).trim()
                        : p.description;
                      const bestFor = bestForMatch ? bestForMatch[1].trim().replace(/\.+$/, "") : null;
                      return (
                        <>
                          <p className="mt-4 text-center text-base sm:text-lg leading-relaxed text-slate-300/85">
                            {mainDesc}
                          </p>
                          {bestFor && (
                            <div className="mt-3 flex flex-col items-center gap-1.5">
                              <span className="text-xs font-bold text-white">Suitable for:</span>
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-600/40 bg-sky-900/30 px-3 py-1 text-xs font-semibold text-sky-200">
                                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                                {toTitleCase(bestFor)}
                              </span>
                            </div>
                          )}
                        </>
                      );
                    })()}

                    <div className="mt-5 border-t border-white/10" />

                    <div className="mt-5">
                      <ul className="w-full space-y-2.5 text-left text-base sm:text-lg text-slate-300 leading-relaxed">
                        {hasBullets ? (
                          orderedBullets.map((b, index) => {
                            const on = b.checked;
                            return (
                              <li
                                key={`${on ? "on" : "off"}-${index}`}
                                className={`flex items-start gap-2 transition ${
                                  on ? "opacity-100" : "opacity-35"
                                }`}
                              >
                                <span
                                  className={`mt-0.5 inline-flex h-5 w-6 shrink-0 items-center justify-center ${
                                    on ? "text-sky-400" : "text-slate-500"
                                  }`}
                                >
                                  {on ? "\u2713" : "\u25CB"}
                                </span>
                                <span className="flex-1">{b.label}</span>
                              </li>
                            );
                          })
                        ) : (
                          <li className="text-sm text-slate-400/70">
                            (No package bullets yet)
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
                      {p.detailsButtonText || "See What's Included"}
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
                      {p.buttonText && p.buttonText !== "Book Now"
                        ? p.buttonText
                        : isXoc ? "Book XOC" : "Get Started"}
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

          {dividerText && (
            <div className="mt-8 flex w-full flex-col items-stretch text-center text-slate-300/85 gap-[0.5em]">
              <p className="w-full text-[1.1875rem] sm:text-[1.1875rem] font-bold leading-relaxed whitespace-pre-line break-words text-slate-100">
                {dividerText}
              </p>
              <div className="glow-button packages-divider-line h-[6px] w-full rounded-full opacity-90 shadow-[0_0_30px_rgba(56,189,248,0.8)]" />
            </div>
          )}
        </div>
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

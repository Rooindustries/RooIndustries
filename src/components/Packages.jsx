import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import PackageDetailsModal from "./PackageDetailsModal";
import PriceDisplay from "./PriceDisplay";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
  readHomeSectionData,
} from "../lib/homeSectionData";
import packagePricing from "../lib/packagePricing";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";

const REFERRAL_STORAGE_KEY = "referral_session";
const { applyPackagesPricing } = packagePricing;

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
      ? applyPackagesPricing(Array.isArray(initialPackages) ? initialPackages : [])
      : []
  );
  const [sectionCopy, setSectionCopy] = useState(() => initialSectionCopy);

  useEffect(() => {
    if (initialPackages !== null) {
      setPackages(
        applyPackagesPricing(Array.isArray(initialPackages) ? initialPackages : [])
      );
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
              style={{ color: "var(--color-accent)" }}
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
        setPackages(applyPackagesPricing(cachedPackages));
      } else {
        fetchHomeSectionData(HOME_SECTION_DATA_KEYS.packagesList)
          .then((pkgs) => {
            setPackages(applyPackagesPricing(Array.isArray(pkgs) ? pkgs : []));
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
      <section className="ri-packages-section relative z-10 pt-16 pb-24 text-center text-ink" aria-hidden="true">
        <div className="mt-12 px-6">
          <div className="ri-packages-skeleton mx-auto max-w-6xl min-h-[1320px] rounded-3xl border border-line-input bg-skeleton" />
        </div>
      </section>
    );
  }

  return (
    <section className="ri-packages-section relative z-10 pt-8 pb-24 text-center text-ink">
      {headingText && (
        <h2 className="ri-packages-heading text-4xl sm:text-5xl font-extrabold tracking-tight text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          {headingText}
        </h2>
      )}

      {badgeText && (
        <div className="mt-4 flex justify-center">
          <span className="ri-packages-badge inline-flex items-center gap-2.5 px-5 py-2 rounded-full text-sm sm:text-[0.95rem] font-semibold bg-info-soft text-info-text border border-info-border shadow-info-soft">
            <span className="ri-packages-badge-dot h-2.5 w-2.5 rounded-full bg-success shadow-success-soft" />
            {badgeText}
          </span>
        </div>
      )}

      {subheadingText && (
        <p className="ri-packages-subheading mt-3 text-ink-secondary text-sm sm:text-base">
          {subheadingText}
        </p>
      )}

      <Link
        to="/reviews"
        className="ri-packages-review-link mt-3 inline-flex items-center justify-center gap-2 text-sm font-semibold text-ink-secondary hover:text-[color:var(--color-link-hover)] transition-colors"
      >
        <span className="ri-packages-review-stars text-warning-text">{"★".repeat(5)}</span>
        <span className="ri-packages-review-text underline underline-offset-2 decoration-[color:var(--color-accent)]">5.0 avg from 89+ verified reviews</span>
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
                  className={`ri-package-card relative w-full sm:w-[500px] border rounded-xl px-5 sm:px-7 py-6 sm:py-7 transition-all duration-500 flex flex-col bg-panel text-base sm:text-lg ${
                    p.isHighlighted
                      ? "ri-package-card-highlighted border-info-border shadow-glow-strong hover:shadow-glow-strong"
                      : "ri-package-card-standard border-line-input shadow-glow-soft hover:shadow-glow-strong"
                  } sm:min-h-[620px]`}
                >
                  {p.tag && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span
                        className={`inline-flex items-center whitespace-nowrap text-sm font-bold px-4 py-1 rounded-full ${
                          p.tagGoldGlow
                            ? "ri-package-tag-gold border border-[color:var(--color-gold-border)] gold-flair-pill"
                            : "ri-package-tag-blue bg-info text-accent-contrast shadow-info-soft"
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

                    <PriceDisplay pkg={p} className="mt-6" />

                    {p.description && (() => {
                      const bestForMatch = p.description.match(/Best for:\s*(.+)/i);
                      const mainDesc = bestForMatch
                        ? p.description.slice(0, bestForMatch.index).trim()
                        : p.description;
                      const bestFor = bestForMatch ? bestForMatch[1].trim().replace(/\.+$/, "") : null;
                      return (
                        <>
                          <p className="ri-package-description mt-4 text-center text-base sm:text-lg leading-relaxed text-ink-secondary">
                            {mainDesc}
                          </p>
                          {bestFor && (
                            <div className="mt-3 flex flex-col items-center gap-1.5">
                              <span className="ri-package-suitable-label text-xs font-bold text-ink">Suitable for:</span>
                              <span className="ri-package-suitable-pill inline-flex items-center gap-1.5 rounded-full border border-info-border bg-info-soft px-3 py-1 text-xs font-semibold text-info-text">
                                <span className="ri-package-suitable-dot h-1.5 w-1.5 rounded-full bg-info" />
                                {toTitleCase(bestFor)}
                              </span>
                            </div>
                          )}
                        </>
                      );
                    })()}

                    <div className="ri-package-divider mt-5 border-t border-line-soft" />

                    <div className="mt-5">
                      <ul className="ri-package-bullets w-full space-y-2.5 text-left text-base sm:text-lg text-ink-secondary leading-relaxed">
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
                                    on ? "ri-package-check text-accent" : "ri-package-empty text-ink-muted"
                                  }`}
                                >
                                  {on ? "\u2713" : "\u25CB"}
                                </span>
                                <span className="flex-1">{b.label}</span>
                              </li>
                            );
                          })
                        ) : (
                          <li className="ri-package-empty-note text-sm text-ink-muted">
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
                      className="ri-package-details-button w-full sm:w-1/2 rounded-md border border-info-border bg-surface-input py-3 text-base font-semibold text-info-text shadow-info-soft transition hover:bg-surface-hover-accent hover:text-[color:var(--color-link-hover)]"
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
                      className="ri-package-book-button glow-button w-full sm:w-1/2 text-white text-lg py-3 rounded-md font-semibold shadow-[var(--shadow-button-accent)] transition-all duration-300 text-center inline-flex items-center justify-center gap-2"
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

          {dividerText && (
            <div className="ri-packages-divider-wrap mt-8 flex w-full flex-col items-stretch text-center text-ink-secondary gap-[0.5em]">
              <p className="ri-packages-divider-text w-full text-[1.1875rem] sm:text-[1.1875rem] font-bold leading-relaxed whitespace-pre-line break-words text-ink">
                {dividerText}
              </p>
              <div className="ri-packages-divider-line glow-button packages-divider-line h-[6px] w-full rounded-full opacity-90 shadow-[var(--shadow-divider-extra)]" />
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

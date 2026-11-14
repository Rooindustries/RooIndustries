import React, { useState, useEffect, lazy, Suspense, startTransition } from "react";
import { Link, useLocation } from "react-router-dom";
import { getWarrantyCallout } from "../lib/packageWarranty";
import PriceDisplay from "./PriceDisplay";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
  readHomeSectionData,
} from "../lib/homeSectionData";
import homeCopy from "../lib/homeCopy";
import packageContent from "../lib/packageContent";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";
import { persistBookingPackageSelection } from "../lib/checkoutStorage";
import { trackEvent } from "../lib/analytics";
import { getSessionAvailability } from "../lib/sessionAvailability";
import { reportRequestError, requestDeadline } from "../lib/clientRequest";

const loadPackageDetails = () => import("./PackageDetailsModal");
const PackageDetailsModal = lazy(loadPackageDetails);

const REFERRAL_STORAGE_KEY = "referral_session";
const AVAILABILITY_REFRESH_INTERVAL_MS = 60_000;
const { buildPackageOffers } = packageContent;
const { HOME_COPY } = homeCopy;

export { getWarrantyCallout };

export default function Packages({
  initialPackages = null,
  initialSectionCopy = null,
}) {
  const handleHomeSectionLink = useHomeSectionLinkHandler();
  const [packages, setPackages] = useState(() =>
    initialPackages !== null
      ? buildPackageOffers(initialPackages)
      : []
  );
  const [sectionCopy, setSectionCopy] = useState(() => initialSectionCopy);
  const [sessionAvailability, setSessionAvailability] = useState(null);

  useEffect(() => {
    if (initialPackages !== null) {
      setPackages(buildPackageOffers(initialPackages));
    }

    if (initialSectionCopy !== null) {
      setSectionCopy(initialSectionCopy);
    }
  }, [initialPackages, initialSectionCopy]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [detailsPkg, setDetailsPkg] = useState(null);

  const location = useLocation();
  const bookingState = {
    backgroundLocation: location.state?.backgroundLocation || location,
  };
  const UPGRADE_FAQ_HASH = "upgrade-path";

  const openDetails = (pkg) => {
    trackEvent("view_item", { package: pkg.title, surface: "packages" });
    startTransition(() => {
      setDetailsLoaded(true);
      setDetailsPkg(pkg);
      setDetailsOpen(true);
    });
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");

    if (ref) {
      try {
        sessionStorage.setItem(REFERRAL_STORAGE_KEY, ref);
      } catch (e) {
        console.error("Failed to store referral from link:", e);
      }
    }

    if (packages.length === 0) {
      const cachedPackages = readHomeSectionData(HOME_SECTION_DATA_KEYS.packagesList);
      if (Array.isArray(cachedPackages)) {
        setPackages(buildPackageOffers(cachedPackages));
      } else {
        fetchHomeSectionData(HOME_SECTION_DATA_KEYS.packagesList)
          .then((pkgs) => {
            setPackages(buildPackageOffers(pkgs));
          })
          .catch(reportRequestError);
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
          .catch(reportRequestError);
      }
    }
  }, [packages.length, sectionCopy]);

  useEffect(() => {
    let active = true;

    const loadAvailability = async () => {
      try {
        const response = await fetch("/api/bookingAvailability", {
          cache: "no-store",
          signal: requestDeadline(),
        });
        const data = await response.json();
        if (!response.ok || data?.ok === false) throw new Error();
        if (active) setSessionAvailability(getSessionAvailability(data));
      } catch {
        if (active) setSessionAvailability(null);
      }
    };

    loadAvailability();
    const intervalId = window.setInterval(
      loadAvailability,
      AVAILABILITY_REFRESH_INTERVAL_MS
    );
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const headingText = sectionCopy?.heading ?? HOME_COPY.packagesSettings.heading;
  const subheadingText =
    sectionCopy?.subheading ?? HOME_COPY.packagesSettings.subheading;
  const dividerText = sectionCopy?.dividerText;
  const isLoading = !sectionCopy && packages.length === 0;

  if (isLoading) {
    return (
      <section className="ri-packages-section relative z-10 pt-16 pb-24 text-center text-ink" aria-hidden="true" data-section-placeholder="">
        <div className="mt-12 px-6">
          <div className="ri-packages-skeleton mx-auto max-w-6xl min-h-[1320px] rounded-3xl border border-line-input bg-skeleton" />
        </div>
      </section>
    );
  }

  return (
    <section className="ri-packages-section relative z-10 pt-8 pb-24 text-center text-ink">
      {headingText && (
        <h2 className="section-title px-4">
          {headingText}
        </h2>
      )}

      {sessionAvailability && (
        <div
          className="mt-4 flex items-center justify-center gap-2"
          role="status"
          aria-live="polite"
        >
          <span className="relative flex h-3 w-3" aria-hidden="true">
            <span
              className={`ri-engineer-status-pulse absolute inline-flex h-full w-full rounded-full opacity-80 ${
                sessionAvailability.isOnline ? "bg-success" : "bg-danger"
              }`}
            />
            <span
              className={`relative inline-flex h-3 w-3 rounded-full ${
                sessionAvailability.isOnline
                  ? "bg-success shadow-success-soft"
                  : "bg-danger shadow-danger-soft"
              }`}
            />
          </span>
          <span className="ri-packages-badge text-sm sm:text-[0.95rem] font-semibold tracking-wide text-info-text">
            {sessionAvailability.label}
          </span>
        </div>
      )}

      {subheadingText && (
        <p className="section-lede px-6">
          {subheadingText}
        </p>
      )}

      <Link
        to="/reviews"
        className="ri-packages-review-link mt-3 inline-flex items-center justify-center gap-2 text-sm font-semibold text-ink-secondary hover:text-[color:var(--color-link-hover)] transition-colors"
      >
        <span className="ri-packages-review-stars text-warning-text">{"★".repeat(5)}</span>
        <span className="ri-packages-review-text underline underline-offset-2 decoration-[color:var(--color-accent)]">5.0 avg from 139+ verified reviews</span>
      </Link>

      <div className="mt-12 px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[34rem] xl:max-w-[77rem]">
          <div className="grid gap-8 xl:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] xl:gap-6">
            {packages.map((p, i) => {
              const warranty = getWarrantyCallout(p);
              const WarrantyIcon = warranty.Icon;

              const orderedBullets = p.checklistItems.map((item) => ({
                label: item.label,
                checked: item.included !== false,
              }));
              const hasBullets = orderedBullets.length > 0;

              return (
                <div
                  key={p._id || i}
                  className={`ri-package-card relative w-full border rounded-2xl px-5 sm:px-7 py-7 transition-all duration-500 flex flex-col xl:row-span-6 xl:grid xl:grid-cols-[minmax(0,1fr)] xl:grid-rows-subgrid xl:gap-0 bg-panel text-base ${
                    p.tagGoldGlow
                      ? "ri-package-card-featured"
                      : "ri-package-card-secondary"
                  } ${
                    p.isHighlighted
                      ? "ri-package-card-highlighted border-line-accent"
                      : "ri-package-card-standard border-line-input"
                  }`}
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

                  <h3 className="text-2xl font-bold tracking-tight sm:text-[1.75rem] xl:self-end">
                    {p.title}
                  </h3>

                  <div>
                    <PriceDisplay pkg={p} className="mt-5" />

                    {warranty && (
                      <div
                        className="ri-package-warranty-callout"
                      >
                        <span className="ri-package-warranty-icon" aria-hidden="true">
                          <WarrantyIcon size={18} strokeWidth={2.4} />
                        </span>
                        <span className="ri-package-warranty-copy">
                          <span className="ri-package-warranty-title">
                            {warranty.title}
                          </span>
                          <span className="ri-package-warranty-note">
                            {warranty.note}
                          </span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="max-xl:order-last">
                    {p.descriptionText && (
                      <p className="ri-package-description mt-6 text-center xl:mt-4 text-base leading-relaxed text-ink-secondary">
                        {p.descriptionText}
                      </p>
                    )}
                    {p.suitableFor && (
                      <div className="mt-3 flex flex-wrap items-baseline justify-center gap-x-1.5 text-xs sm:text-sm">
                        <span className="ri-package-suitable-label text-ink-secondary">Suitable for:</span>
                        <span className="ri-package-suitable-value font-semibold text-ink">
                          {p.suitableFor}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="max-xl:order-last">
                    <div className="ri-package-divider mt-6 border-t border-line-soft" />

                    <div className="mt-5">
                      <ul className="ri-package-bullets w-full space-y-2.5 text-left text-base text-ink-secondary leading-relaxed">
                        {hasBullets ? (
                          orderedBullets.map((b, index) => {
                            const on = b.checked;
                            return (
                              <li
                                key={`${on ? "on" : "off"}-${index}`}
                                className={`items-start gap-2 transition ${
                                  on
                                    ? "flex text-ink-secondary"
                                    : "ri-package-bullet-excluded hidden text-ink-muted sm:flex"
                                }`}
                              >
                                <span
                                  className={`mt-0.5 inline-flex h-5 w-6 shrink-0 items-center justify-center ${
                                    on
                                      ? "ri-package-check text-accent"
                                      : "ri-package-empty text-ink-muted"
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

                  <div className="pt-7 flex flex-col sm:flex-row xl:flex-col gap-3 xl:self-end">
                    <Link
                      to="/booking"
                      state={{
                        ...bookingState,
                        bookingPackage: {
                          title: p.title,
                          price: p.price,
                          tag: p.tag || "",
                        },
                      }}
                      onClick={() => {
                        persistBookingPackageSelection(p);
                        trackEvent("package_selected", {
                          package: p.title,
                          surface: "packages",
                        });
                      }}
                      className="ri-package-book-button glow-button w-full sm:w-1/2 xl:w-full text-white text-base py-3 rounded-md font-semibold shadow-[var(--shadow-button-accent)] transition-all duration-300 text-center inline-flex items-center justify-center gap-2"
                    >
                      {p.buttonText || "Book Now"}
                      <span className="glow-line glow-line-top" />
                      <span className="glow-line glow-line-right" />
                      <span className="glow-line glow-line-bottom" />
                      <span className="glow-line glow-line-left" />
                    </Link>

                    <button
                      type="button"
                      onPointerEnter={() => { loadPackageDetails().catch(() => {}); }}
                      onFocus={() => { loadPackageDetails().catch(() => {}); }}
                      onClick={() => openDetails(p)}
                      className="ri-package-details-button w-full sm:w-1/2 xl:w-full rounded-md border border-info-border bg-surface-input py-3 text-base font-semibold text-info-text shadow-info-soft transition hover:bg-surface-hover-accent hover:text-[color:var(--color-link-hover)]"
                    >
                      {p.detailsButtonText || "See What's Included"}
                    </button>
                  </div>
                  <p className="ri-package-guarantee mt-3 text-center text-sm text-ink-secondary">
                    No gains? 3-day money-back guarantee.
                  </p>
                </div>
              );
            })}
          </div>

          {dividerText && (
            <div className="ri-packages-divider-wrap mt-8 flex w-full flex-col items-stretch text-center text-ink-secondary gap-[0.5em]">
              <p className="ri-packages-divider-text w-full text-[1.1875rem] sm:text-[1.1875rem] font-bold leading-relaxed whitespace-pre-line break-words text-ink">
                {dividerText}
              </p>
              <div className="ri-packages-divider-line h-px w-full bg-line-soft" />
            </div>
          )}
        </div>
      </div>

      <Suspense fallback={null}>
        {detailsLoaded && (
          <PackageDetailsModal
            open={detailsOpen}
            onClose={closeDetails}
            pkg={detailsPkg}
            renderFeature={renderFeatureText}
          />
        )}
      </Suspense>
    </section>
  );
}

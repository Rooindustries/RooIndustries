import React, { useEffect, useState, useRef, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { FaDiscord } from "react-icons/fa";
import BackButton from "./BackButton";
import DiscordGuideBanner from "./DiscordGuideBanner";
import {
  SECTION_HASHES,
  buildHomeSectionHref,
  clearPendingSectionTarget,
  clearRouteTransitionIntent,
  consumePendingSectionTarget,
  isHomeSectionHash,
  normalizeSectionHash,
  readPendingSectionTarget,
  writeRouteTransitionIntent,
  writePendingSectionTarget,
} from "../lib/sectionNavigation";
import { alignToHashTarget, getCssHeaderOffsetPx } from "../lib/scrollCoordinator";
import { useScrollRuntime } from "../lib/scrollRuntime";
import { HOME_SECTION_PREFETCH_BY_HASH, prefetchHomeSectionData, readHomeSectionData } from "../lib/homeSectionData";

const canAnimateLogo = () => {
  if (typeof window === "undefined") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    !navigator?.connection?.saveData;
};

export default function Navbar({ routeShell = "browser" }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [activeHomeHash, setActiveHomeHash] = useState("");
  // Keep initial server/client markup identical, then upgrade to animated mode on mount.
  const [smallLogoMode, setSmallLogoMode] = useState("static");
  const proofDropdownRef = useRef(null);
  const headerRef = useRef(null);
  const navRowRef = useRef(null);
  const activeScrollCleanupRef = useRef(null);
  const pendingSectionNavigationTimeoutRef = useRef(null);
  const sectionTransitionInFlightRef = useRef(false);
  const { scrollY } = useScrollRuntime();

  const scrolled = scrollY > 12;
  const bannerHidden = scrollY > 8;

  const isActive = (path) => location.pathname === path;

  const benefitsHashes = [SECTION_HASHES.benefits];
  const plansHashes = [SECTION_HASHES.plans];
  const faqHashes = [
    SECTION_HASHES.faq,
    SECTION_HASHES.upgradePath,
    SECTION_HASHES.trust,
  ];
  const isBenefitsActive =
    location.pathname === "/" && benefitsHashes.includes(activeHomeHash);
  const isPlansActive =
    location.pathname === "/packages" ||
    (location.pathname === "/" && plansHashes.includes(activeHomeHash));
  const isFaqActive =
    location.pathname === "/faq" ||
    (location.pathname === "/" && faqHashes.includes(activeHomeHash));
  const isProofActive = isActive("/benchmarks") || isActive("/reviews");
  const isTeamActive = isActive("/meet-the-team");

  const handleLogoAnimError = () => {
    setSmallLogoMode("static");
  };

  const getHeaderOffsetPx = useCallback(() => getCssHeaderOffsetPx(110), []);

  const runHashAlignment = useCallback(
    (hash, behavior = "auto", options = {}) => {
      if (activeScrollCleanupRef.current) {
        activeScrollCleanupRef.current();
      }
      activeScrollCleanupRef.current = alignToHashTarget({
        hash,
        behavior,
        getOffsetPx: getHeaderOffsetPx,
        stableFramesRequired: 8,
        preAlignStableFramesRequired:
          options.preAlignStableFramesRequired || 8,
        maxWaitMs: 4200,
        minRuntimeMs: options.minRuntimeMs || 0,
        observeMutations: options.observeMutations !== false,
      });
    },
    [getHeaderOffsetPx]
  );

  const cancelSectionTransition = useCallback(() => {
    if (pendingSectionNavigationTimeoutRef.current) {
      clearTimeout(pendingSectionNavigationTimeoutRef.current);
      pendingSectionNavigationTimeoutRef.current = null;
    }
    sectionTransitionInFlightRef.current = false;
    clearPendingSectionTarget();
    clearRouteTransitionIntent();
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("route-transition-out");
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("roo:cancel-route-transition"));
    }
    if (activeScrollCleanupRef.current) {
      activeScrollCleanupRef.current();
      activeScrollCleanupRef.current = null;
    }
  }, []);

  const handleSectionLinkClick = useCallback(
    async (event, hash) => {
      setOpen(false);
      setProofOpen(false);
      if (typeof window === "undefined") return;

      const normalizedHash = normalizeSectionHash(hash);
      if (!normalizedHash) return;
      const onHomePath = location.pathname === "/";
      const browserPath = window.location.pathname || "/";

      if (!onHomePath) {
        if (event?.preventDefault) {
          event.preventDefault();
        }

        writePendingSectionTarget(normalizedHash);
        writeRouteTransitionIntent({
          kind: "section",
          hash: normalizedHash,
          from: location.pathname,
        });
        document.documentElement.classList.add("route-transition-out");

        const requiredKeys = HOME_SECTION_PREFETCH_BY_HASH[normalizedHash] || [];
        const missingKeys = requiredKeys.filter((key) => readHomeSectionData(key) === null);

        if (missingKeys.length > 0) {
          prefetchHomeSectionData(missingKeys).catch(() => {});
        }

        if (sectionTransitionInFlightRef.current) {
          return;
        }

        sectionTransitionInFlightRef.current = true;
        if (pendingSectionNavigationTimeoutRef.current) {
          clearTimeout(pendingSectionNavigationTimeoutRef.current);
        }
        pendingSectionNavigationTimeoutRef.current = window.setTimeout(() => {
          pendingSectionNavigationTimeoutRef.current = null;
          const nextHref = buildHomeSectionHref(normalizedHash);
          if (routeShell === "memory") {
            if (window.history?.pushState) {
              window.history.pushState(window.history.state, "", nextHref);
            } else {
              window.location.hash = normalizedHash.slice(1);
            }
            navigate("/");
            return;
          }
          if (browserPath !== location.pathname) {
            window.location.assign(nextHref);
            return;
          }
          navigate(nextHref);
        }, 20);
        return;
      }

      if (event?.preventDefault) {
        event.preventDefault();
      }

      // Keep browser URL hash in sync even with MemoryRouter.
      const nextUrl = `${window.location.pathname}${window.location.search}${normalizedHash}`;
      if (window.location.hash !== normalizedHash) {
        if (window.history?.replaceState) {
          window.history.replaceState(window.history.state, "", nextUrl);
        } else {
          window.location.hash = normalizedHash.slice(1);
        }
      }

      // replaceState doesn't fire hashchange — update active nav state directly.
      setActiveHomeHash(normalizedHash);

      // Force scroll even when clicking the same hash repeatedly.
      runHashAlignment(normalizedHash, "auto", {
        minRuntimeMs: 900,
      });
    },
    [location.pathname, navigate, routeShell, runHashAlignment]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncHash = () => {
      const nextHash = normalizeSectionHash(
        window.location.hash || location.hash || ""
      );
      setActiveHomeHash(nextHash);
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [location.hash, location.pathname]);

  const updateHeaderOffset = useCallback(() => {
    if (typeof document === "undefined") return;
    const navHeight = navRowRef.current?.offsetHeight || 96;
    document.documentElement.style.setProperty(
      "--section-nav-offset",
      `${navHeight}px`
    );
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (canAnimateLogo()) {
      setSmallLogoMode("animated");
    }
  }, []);

  useEffect(() => {
    updateHeaderOffset();
    if (typeof ResizeObserver === "undefined" || !headerRef.current) {
      const handleResize = () => updateHeaderOffset();
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver(() => updateHeaderOffset());
    observer.observe(headerRef.current);

    return () => observer.disconnect();
  }, [updateHeaderOffset]);

  useEffect(() => {
    setOpen(false);
    setProofOpen(false);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    if (location.pathname === "/") {
      sectionTransitionInFlightRef.current = false;
      if (pendingSectionNavigationTimeoutRef.current) {
        clearTimeout(pendingSectionNavigationTimeoutRef.current);
        pendingSectionNavigationTimeoutRef.current = null;
      }
    }
  }, [location.pathname]);

  // Close dropdown when clicking outside (desktop only)
  useEffect(() => {
    if (!proofOpen || typeof window === "undefined") return;
    if (!window.matchMedia("(min-width: 768px)").matches) return;

    const handleClickOutside = (event) => {
      if (
        proofDropdownRef.current &&
        !proofDropdownRef.current.contains(event.target)
      ) {
        setProofOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [proofOpen]);

  useEffect(() => {
    if (location.pathname !== "/") return;

    const urlHash = normalizeSectionHash(activeHomeHash);
    const pendingHash = readPendingSectionTarget();
    const targetHash = isHomeSectionHash(urlHash)
      ? urlHash
      : isHomeSectionHash(pendingHash)
      ? consumePendingSectionTarget()
      : "";

    if (!isHomeSectionHash(targetHash)) return;

    const fromPending = Boolean(pendingHash && pendingHash === targetHash);
    if (fromPending && pendingHash === targetHash) {
      consumePendingSectionTarget();
    }

    if (typeof window !== "undefined") {
      const nextUrl = `${window.location.pathname}${window.location.search}${targetHash}`;
      if (window.location.hash !== targetHash && window.history?.replaceState) {
        window.history.replaceState(window.history.state, "", nextUrl);
      }
    }

    if (targetHash !== activeHomeHash) {
      setActiveHomeHash(targetHash);
    }

    runHashAlignment(targetHash, "auto", {
      minRuntimeMs: fromPending ? 60 : 420,
      preAlignStableFramesRequired: fromPending ? 1 : 5,
    });

    return () => {
      if (activeScrollCleanupRef.current) {
        activeScrollCleanupRef.current();
        activeScrollCleanupRef.current = null;
      }
    };
  }, [activeHomeHash, location.pathname, runHashAlignment]);

  useEffect(() => {
    return () => {
      cancelSectionTransition();
    };
  }, [cancelSectionTransition]);

  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#061226]";
  const linkBase = `px-3 sm:px-5 py-2 rounded-full text-base font-medium transition border border-white/10 hover:border-cyan-300/30 ${focusRing}`;
  const linkIdle = "text-white/85 hover:text-cyan-200";
  const linkActive = "bg-cyan-400 text-black border-cyan-400";
  const mobileLinkBase = `px-5 py-4 text-base transition ${focusRing}`;
  const mobileLinkIdle = "text-white/85 hover:text-cyan-200";
  const mobileLinkActive = "bg-cyan-400 text-black";
  const mobileSubLinkBase = `px-9 py-3 text-sm transition ${focusRing}`;
  const mobileSubLinkIdle = "text-white/85 hover:text-cyan-200";
  const mobileSubLinkActive = "bg-cyan-400 text-black";

  const smallLogoSizeClassName = "h-14 w-14 rounded-xl";
  const smallLogoGlowClassName =
    "drop-shadow-none sm:drop-shadow-[0_0_18px_rgba(34,211,238,0.25)]";
  const smallLogoStaticClassName = `${smallLogoSizeClassName} object-contain ${smallLogoGlowClassName}`;
  const smallLogoAnimatedClassName = `${smallLogoSizeClassName} object-contain ${smallLogoGlowClassName} transition-opacity duration-500`;

  return (
    <header
      ref={headerRef}
      className={`site-nav site-navbar-glass glass-premium glass-scroll-lite fixed top-0 left-0 right-0 z-50 overflow-visible border-b transition-all duration-300 ${
        scrolled ? "border-cyan-300/10" : "border-white/5"
      } ${
        scrolled
          ? "shadow-[0_10px_30px_rgba(0,0,0,0.25)]"
          : ""
      }`}
    >
      {/* subtle grid overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.14] z-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
        }}
      />

      {/* cyan glow line */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent z-0" />

      <div className="relative z-10">
        <DiscordGuideBanner hidden={bannerHidden} />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl overflow-visible px-4 sm:px-6">
        <div ref={navRowRef} className="flex h-20 items-center overflow-visible sm:h-24">
          {/* Left: Logo / Back */}
          <div className="flex items-center gap-4">
            {location.pathname !== "/" ? (
              <BackButton hidden={false} inline={true} />
            ) : null}

            <Link to="/" onClick={cancelSectionTransition} className="flex items-center gap-3 select-none">
              <div className="relative h-14 w-14 grid place-items-center overflow-hidden rounded-xl">
                <img
                  src="/favicon-96x96.png"
                  alt="Roo Industries"
                  className={smallLogoStaticClassName}
                  loading="eager"
                  fetchPriority="high"
                  width={56}
                  height={56}
                />
                {smallLogoMode === "animated" && (
                  <img
                    src="/logo-animated-small.apng"
                    alt=""
                    className={`absolute inset-0 ${smallLogoAnimatedClassName}`}
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    onError={handleLogoAnimError}
                  />
                )}
              </div>

              <div className="block leading-tight">
                <div className="text-white font-semibold tracking-wide text-lg">
                  Roo Industries
                </div>
                <div className="text-xs text-white/55">
                  Precision Performance Engineering
                </div>
              </div>
            </Link>
          </div>

          {/* Right: Links + CTA + Mobile */}
          <div className="ml-auto flex items-center gap-3">
            <nav className="hidden md:flex items-center gap-2">
              <a
                href={buildHomeSectionHref(SECTION_HASHES.benefits)}
                data-nav-surface="desktop"
                data-nav-target="benefits"
                onClick={(event) =>
                  handleSectionLinkClick(event, SECTION_HASHES.benefits)
                }
                className={`${linkBase} ${
                  isBenefitsActive ? linkActive : linkIdle
                }`}
              >
                Benefits
              </a>
              <a
                href={buildHomeSectionHref(SECTION_HASHES.plans)}
                data-nav-surface="desktop"
                data-nav-target="plans"
                onClick={(event) =>
                  handleSectionLinkClick(event, SECTION_HASHES.plans)
                }
                className={`${linkBase} ${
                  isPlansActive ? linkActive : linkIdle
                }`}
              >
                Plans
              </a>
              <div className="relative" ref={proofDropdownRef}>
                <button
                  type="button"
                  onClick={() => setProofOpen((v) => !v)}
                  className={`${linkBase} ${
                    isProofActive ? linkActive : linkIdle
                  } inline-flex items-center gap-1`}
                  aria-haspopup="menu"
                  aria-expanded={proofOpen}
                >
                  Proof
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className={`h-4 w-4 opacity-70 transition-transform duration-200 ${
                      proofOpen ? "rotate-180" : ""
                    }`}
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
                {proofOpen ? (
                  <div className="glass-premium glass-menu-surface absolute right-0 top-full z-[80] mt-2 w-44 overflow-hidden rounded-2xl transition-all duration-200">
                    <Link
                      to="/benchmarks"
                      onClick={() => {
                        cancelSectionTransition();
                        setProofOpen(false);
                      }}
                      className={`block px-4 py-3 text-sm transition ${
                        isActive("/benchmarks")
                          ? "bg-cyan-400 text-black"
                          : "text-white/85 hover:text-cyan-200 hover:bg-white/5"
                      }`}
                    >
                      Benchmarks
                    </Link>
                    <Link
                      to="/reviews"
                      onClick={() => {
                        cancelSectionTransition();
                        setProofOpen(false);
                      }}
                      className={`block px-4 py-3 text-sm transition ${
                        isActive("/reviews")
                          ? "bg-cyan-400 text-black"
                          : "text-white/85 hover:text-cyan-200 hover:bg-white/5"
                      }`}
                    >
                      Reviews
                    </Link>
                  </div>
                ) : null}
              </div>
              <a
                href={buildHomeSectionHref(SECTION_HASHES.faq)}
                data-nav-surface="desktop"
                data-nav-target="faq"
                onClick={(event) =>
                  handleSectionLinkClick(event, SECTION_HASHES.faq)
                }
                className={`${linkBase} ${isFaqActive ? linkActive : linkIdle}`}
              >
                FAQ
              </a>
              <Link
                to="/meet-the-team"
                onClick={cancelSectionTransition}
                className={`${linkBase} ${isTeamActive ? linkActive : linkIdle}`}
              >
                Meet the Team
              </Link>
            </nav>

            <a
              href="https://discord.gg/M7nTkn9dxE"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2.5 text-base font-semibold whitespace-nowrap rounded-full max-[820px]:px-3 max-[820px]:text-sm max-[820px]:gap-1.5 text-white/70 hover:text-white transition"
            >
              <FaDiscord className="text-[1.1em]" aria-hidden="true" />
              Discord
            </a>
            <a
              href="/#packages"
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2.5 text-base font-semibold whitespace-nowrap rounded-full max-[820px]:px-3 max-[820px]:text-sm max-[820px]:gap-1.5 text-white border border-cyan-300/30 bg-cyan-400/10 hover:bg-cyan-400/15 hover:border-cyan-300/50 shadow-[0_0_18px_rgba(34,211,238,0.14)] transition"
            >
              Packages
            </a>

            {/* Mobile menu button */}
            <button
              onClick={() =>
                setOpen((v) => {
                  const next = !v;
                  if (!next) setProofOpen(false);
                  return next;
                })
              }
              className="
                  md:hidden
                  h-12 w-12 grid place-items-center
                  text-white/90 hover:text-cyan-200
                  border border-white/15 hover:border-cyan-300/30
                  bg-white/5 hover:bg-cyan-400/10
                  transition
                "
              aria-label="Open menu"
            >
              <div className="space-y-1.5">
                <div className="h-[2px] w-6 bg-current" />
                <div className="h-[2px] w-6 bg-current opacity-80" />
                <div className="h-[2px] w-6 bg-current opacity-60" />
              </div>
            </button>
          </div>
        </div>

        {/* Mobile dropdown */}
        <div
          className={`md:hidden overflow-hidden transition-all duration-300 ease-out ${
            open
              ? "pb-4 max-h-[520px] opacity-100 translate-y-0"
              : "max-h-0 opacity-0 -translate-y-2 pointer-events-none"
          }`}
          aria-hidden={!open}
        >
          <div className="glass-premium glass-menu-surface mt-2 transition-all duration-300">
            <div className="flex flex-col">
              <a
                href={buildHomeSectionHref(SECTION_HASHES.benefits)}
                data-nav-surface="mobile"
                data-nav-target="benefits"
                onClick={(event) =>
                  handleSectionLinkClick(event, SECTION_HASHES.benefits)
                }
                className={`${mobileLinkBase} ${
                  isBenefitsActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                Benefits
              </a>
              <a
                href={buildHomeSectionHref(SECTION_HASHES.plans)}
                data-nav-surface="mobile"
                data-nav-target="plans"
                onClick={(event) =>
                  handleSectionLinkClick(event, SECTION_HASHES.plans)
                }
                className={`${mobileLinkBase} ${
                  isPlansActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                Plans
              </a>
              <button
                type="button"
                onClick={() => setProofOpen((v) => !v)}
                className={`${mobileLinkBase} flex w-full items-center justify-between ${
                  isProofActive ? mobileLinkActive : mobileLinkIdle
                }`}
                aria-expanded={proofOpen}
                aria-controls="mobile-proof-menu"
              >
                Proof
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`h-4 w-4 transition ${
                    proofOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <div
                id="mobile-proof-menu"
                className={`flex flex-col bg-[#071a33]/60 overflow-hidden transition-all duration-300 ${
                  proofOpen
                    ? "max-h-40 opacity-100"
                    : "max-h-0 opacity-0 pointer-events-none"
                }`}
              >
                <Link
                  to="/benchmarks"
                  onClick={() => {
                    cancelSectionTransition();
                    setProofOpen(false);
                    setOpen(false);
                  }}
                  className={`${mobileSubLinkBase} ${
                    isActive("/benchmarks")
                      ? mobileSubLinkActive
                      : mobileSubLinkIdle
                  }`}
                >
                  Benchmarks
                </Link>
                <Link
                  to="/reviews"
                  onClick={() => {
                    cancelSectionTransition();
                    setProofOpen(false);
                    setOpen(false);
                  }}
                  className={`${mobileSubLinkBase} ${
                    isActive("/reviews")
                      ? mobileSubLinkActive
                      : mobileSubLinkIdle
                  }`}
                >
                  Reviews
                </Link>
              </div>
              <a
                href={buildHomeSectionHref(SECTION_HASHES.faq)}
                data-nav-surface="mobile"
                data-nav-target="faq"
                onClick={(event) =>
                  handleSectionLinkClick(event, SECTION_HASHES.faq)
                }
                className={`${mobileLinkBase} ${
                  isFaqActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                FAQ
              </a>
              <Link
                to="/meet-the-team"
                onClick={cancelSectionTransition}
                className={`${mobileLinkBase} ${
                  isTeamActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                Meet the Team
              </Link>

              <a
                href="https://discord.gg/M7nTkn9dxE"
                target="_blank"
                rel="noreferrer"
                className={`${mobileLinkBase} ${mobileLinkIdle} inline-flex items-center gap-2`}
              >
                <FaDiscord aria-hidden="true" />
                Discord
              </a>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

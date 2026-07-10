import React, { useEffect, useState, useRef, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { FaDiscord } from "react-icons/fa";
import { Moon, Tv } from "lucide-react";
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

// Two themes only: "default" (Roo Blue, the existing site) and "dark"
// (Blackout). There is no light mode. Legacy stored values normalize
// to "default".
const THEME_STORAGE_KEY = "roo-theme";
const THEME_LABELS = {
  default: "Roo Blue",
  dark: "Blackout",
};

const normalizeTheme = (value) => (value === "dark" ? "dark" : "default");

const updateThemeMeta = (theme) => {
  if (typeof document === "undefined") return;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (!themeMeta) return;
  themeMeta.setAttribute(
    "content",
    theme === "dark" ? "#070707" : "#000040"
  );
};

const readTheme = () => {
  if (typeof window === "undefined") return "default";
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "default";
  }
};

const applyTheme = (theme, { persist = true } = {}) => {
  const normalized = normalizeTheme(theme);

  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = normalized;
    updateThemeMeta(normalized);
  }

  if (persist && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {}

    window.dispatchEvent(
      new CustomEvent("roo:theme-change", {
        detail: { theme: normalized },
      })
    );
  }

  return normalized;
};

export default function Navbar({ routeShell = "browser" }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [referralsOpen, setReferralsOpen] = useState(false);
  const [activeHomeHash, setActiveHomeHash] = useState("");
  const [theme, setTheme] = useState("default");
  // Keep initial server/client markup identical, then upgrade to animated mode on mount.
  const [smallLogoMode, setSmallLogoMode] = useState("static");
  const proofDropdownRef = useRef(null);
  const referralsDropdownRef = useRef(null);
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
  const isReferralsActive = location.pathname.startsWith("/referrals");
  const isTeamActive = isActive("/meet-the-team");
  const navMenuOpen = open || proofOpen || referralsOpen;

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

  const handleHomeClick = useCallback(
    (event) => {
      setOpen(false);
      setProofOpen(false);
      setReferralsOpen(false);
      cancelSectionTransition();

      if (typeof window === "undefined") return;

      if (location.pathname !== "/") {
        return;
      }

      event?.preventDefault?.();

      const nextUrl = `${window.location.pathname}${window.location.search}`;
      if (window.location.hash && window.history?.replaceState) {
        window.history.replaceState(window.history.state, "", nextUrl);
      }

      setActiveHomeHash("");

      if (activeScrollCleanupRef.current) {
        activeScrollCleanupRef.current();
        activeScrollCleanupRef.current = null;
      }

      window.scrollTo({
        top: 0,
        behavior: "auto",
      });
    },
    [cancelSectionTransition, location.pathname]
  );

  const handleSectionLinkClick = useCallback(
    async (event, hash) => {
      setOpen(false);
      setProofOpen(false);
      setReferralsOpen(false);
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
    if (typeof window === "undefined") return undefined;

    setTheme(applyTheme(readTheme(), { persist: false }));

    const handleThemeChange = (event) => {
      const next = event?.detail?.theme;
      setTheme(
        next
          ? normalizeTheme(next)
          : applyTheme(readTheme(), { persist: false })
      );
    };

    const handleStorage = (event) => {
      if (event.key === THEME_STORAGE_KEY) {
        setTheme(applyTheme(readTheme(), { persist: false }));
      }
    };

    window.addEventListener("roo:theme-change", handleThemeChange);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("roo:theme-change", handleThemeChange);
      window.removeEventListener("storage", handleStorage);
    };
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
    setReferralsOpen(false);
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

  // Close dropdowns when clicking outside (desktop only)
  useEffect(() => {
    if ((!proofOpen && !referralsOpen) || typeof window === "undefined") return;
    if (!window.matchMedia("(min-width: 768px)").matches) return;

    const handleClickOutside = (event) => {
      if (
        proofOpen &&
        proofDropdownRef.current &&
        !proofDropdownRef.current.contains(event.target)
      ) {
        setProofOpen(false);
      }
      if (
        referralsOpen &&
        referralsDropdownRef.current &&
        !referralsDropdownRef.current.contains(event.target)
      ) {
        setReferralsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [proofOpen, referralsOpen]);

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

  // Theme-token interaction states — values per theme in src/index.css.
  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-deep)]";
  const linkBase = `px-3 sm:px-5 py-2 rounded-full text-base font-medium transition border border-line-soft hover:border-line-accent ${focusRing}`;
  const linkIdle =
    "text-ink-secondary hover:text-[color:var(--color-link-hover)]";
  const linkActive = "bg-accent text-accent-contrast border-accent";
  const mobileLinkBase = `px-5 py-4 text-base transition ${focusRing}`;
  const mobileLinkIdle =
    "text-ink-secondary hover:text-[color:var(--color-link-hover)]";
  const mobileLinkActive = "bg-accent text-accent-contrast";
  const mobileSubLinkBase = `px-9 py-3 text-sm transition ${focusRing}`;
  const mobileSubLinkIdle =
    "text-ink-secondary hover:text-[color:var(--color-link-hover)]";
  const mobileSubLinkActive = "bg-accent text-accent-contrast";
  const menuItemIdle =
    "text-ink-secondary hover:text-[color:var(--color-link-hover)] hover:bg-[color:var(--color-surface-hover)]";
  const menuItemActive = "bg-accent text-accent-contrast";
  const nextTheme = theme === "dark" ? "default" : "dark";
  const themeLabel = THEME_LABELS[theme] || THEME_LABELS.default;
  const nextThemeLabel = THEME_LABELS[nextTheme];

  const handleThemeToggle = () => {
    setTheme(applyTheme(nextTheme));
  };

  const smallLogoSizeClassName = "h-14 w-14 rounded-xl";
  const smallLogoGlowClassName =
    "drop-shadow-none sm:drop-shadow-[0_0_18px_rgba(34,211,238,0.25)]";
  const smallLogoStaticClassName = `${smallLogoSizeClassName} object-contain ${smallLogoGlowClassName}`;
  const smallLogoAnimatedClassName = `${smallLogoSizeClassName} object-contain ${smallLogoGlowClassName} transition-opacity duration-500`;

  return (
    <header
      ref={headerRef}
      className={`site-nav site-navbar-glass glass-premium glass-scroll-lite fixed top-0 left-0 right-0 z-50 overflow-visible border-b transition-all duration-300 ${
        scrolled
          ? "border-[color:var(--navbar-border-scrolled)]"
          : "border-[color:var(--navbar-border-rest)]"
      } ${scrolled ? "shadow-[var(--shadow-navbar-scrolled)]" : ""} ${
        navMenuOpen ? "nav-menu-open" : ""
      }`}
    >
      {/* subtle grid overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.14] z-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--navbar-grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--navbar-grid-line) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
        }}
      />

      {/* cyan glow line */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[color:var(--color-accent-soft)] to-transparent z-0" />

      <div className="relative z-10 hidden md:block">
        <DiscordGuideBanner hidden={bannerHidden} />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl overflow-visible px-4 sm:px-6">
        <div ref={navRowRef} className="flex h-20 items-center overflow-visible sm:h-24">
          {/* Left: Logo / Back */}
          <div className="hidden min-w-0 flex-1 items-center gap-4 md:flex">
            {location.pathname !== "/" ? (
              <BackButton hidden={false} inline={true} />
            ) : null}

            <Link to="/"
              onClick={handleHomeClick}
              className="flex min-w-0 items-center gap-3 select-none"
              aria-label="Go to Roo Industries home"
            >
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

              <div className="block leading-tight min-w-0">
                <div className="text-ink font-semibold tracking-wide text-sm sm:text-lg truncate">
                  Roo Industries
                </div>
                <div className="text-[9px] sm:text-xs text-ink-muted whitespace-nowrap truncate">
                  Precision Performance Engineering
                </div>
              </div>
            </Link>
          </div>

          {/* Right: Links + CTA + Mobile */}
          <div className="ml-0 flex w-full min-w-0 items-center gap-2 md:ml-auto md:w-auto md:justify-end md:gap-3">
            <Link
              to="/"
              onClick={handleHomeClick}
              className="flex min-w-0 flex-1 items-center gap-1.5 select-none md:hidden min-[360px]:gap-2"
              aria-label="Go to Roo Industries home"
            >
              <div className="relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg min-[360px]:h-10 min-[360px]:w-10 sm:h-12 sm:w-12 sm:rounded-xl">
                <img
                  src="/favicon-96x96.png"
                  alt="Roo Industries"
                  className="h-8 w-8 rounded-lg object-contain drop-shadow-none min-[360px]:h-10 min-[360px]:w-10 sm:h-12 sm:w-12 sm:rounded-xl"
                  loading="eager"
                  fetchPriority="high"
                  width={48}
                  height={48}
                />
                {smallLogoMode === "animated" && (
                  <img
                    src="/logo-animated-small.apng"
                    alt=""
                    className="absolute inset-0 h-8 w-8 rounded-lg object-contain drop-shadow-none transition-opacity duration-500 min-[360px]:h-10 min-[360px]:w-10 sm:h-12 sm:w-12 sm:rounded-xl"
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    onError={handleLogoAnimError}
                  />
                )}
              </div>

              <div className="min-w-0 leading-tight">
                <div className="truncate text-sm font-semibold tracking-wide text-ink sm:text-base">
                  Roo Industries
                </div>
                <div className="whitespace-nowrap text-[8px] leading-tight text-ink-muted min-[340px]:text-[8.6px] min-[360px]:text-[9.2px] min-[375px]:text-[10px] sm:text-xs">
                  Precision Performance Engineering
                </div>
              </div>
            </Link>

            <div className="ml-auto flex shrink-0 items-center gap-1 min-[360px]:gap-2 sm:gap-3">
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
              <div className="relative" ref={proofDropdownRef}>
                <button
                  type="button"
                  onClick={() =>
                    setProofOpen((v) => {
                      const next = !v;
                      if (next) setReferralsOpen(false);
                      return next;
                    })
                  }
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
                          ? menuItemActive
                          : menuItemIdle
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
                          ? menuItemActive
                          : menuItemIdle
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
              <div className="relative" ref={referralsDropdownRef}>
                <button
                  type="button"
                  onClick={() =>
                    setReferralsOpen((v) => {
                      const next = !v;
                      if (next) setProofOpen(false);
                      return next;
                    })
                  }
                  className={`${linkBase} ${
                    isReferralsActive ? linkActive : linkIdle
                  } inline-flex items-center gap-1`}
                  aria-haspopup="menu"
                  aria-expanded={referralsOpen}
                  aria-controls={referralsOpen ? "desktop-referrals-menu" : undefined}
                >
                  Referrals
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className={`h-4 w-4 opacity-70 transition-transform duration-200 ${
                      referralsOpen ? "rotate-180" : ""
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
                {referralsOpen ? (
                  <div id="desktop-referrals-menu" className="glass-premium glass-menu-surface absolute right-0 top-full z-[80] mt-2 w-44 overflow-hidden rounded-2xl transition-all duration-200">
                    <Link
                      to="/referrals/register"
                      onClick={() => {
                        cancelSectionTransition();
                        setReferralsOpen(false);
                      }}
                      className={`block px-4 py-3 text-sm transition ${
                        isActive("/referrals/register")
                          ? menuItemActive
                          : menuItemIdle
                      }`}
                    >
                      Sign Up
                    </Link>
                    <Link
                      to="/referrals/login"
                      onClick={() => {
                        cancelSectionTransition();
                        setReferralsOpen(false);
                      }}
                      className={`block px-4 py-3 text-sm transition ${
                        isReferralsActive && !isActive("/referrals/register")
                          ? menuItemActive
                          : menuItemIdle
                      }`}
                    >
                      Dashboard
                    </Link>
                  </div>
                ) : null}
              </div>
            </nav>

            <a
              href="/#packages"
              data-nav-surface="desktop"
              data-nav-target="plans"
              onClick={(event) => handleSectionLinkClick(event, SECTION_HASHES.plans)}
              className="nav-cta inline-flex items-center gap-2 px-2 py-1.5 text-[11px] min-[360px]:px-2.5 min-[360px]:text-xs sm:px-5 sm:py-3 sm:text-base font-semibold whitespace-nowrap rounded-full text-white transition"
            >
              Packages
            </a>

            {/* Mobile menu button */}
            <button
              type="button"
              onClick={() =>
                setOpen((v) => {
                  const next = !v;
                  if (!next) {
                    setProofOpen(false);
                    setReferralsOpen(false);
                  }
                  return next;
                })
              }
              className="
                  md:hidden
                  h-9 w-9 min-[360px]:h-10 min-[360px]:w-10 sm:h-12 sm:w-12 grid place-items-center rounded-full
                  text-ink-secondary hover:text-[color:var(--color-link-hover)]
                  border border-line-soft hover:border-line-accent
                  bg-[color:var(--color-surface-hover)] hover:bg-[color:var(--color-surface-hover-accent)]
                  transition
                "
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="mobile-site-menu"
            >
              <div className="space-y-1.5">
                <div className="h-[2px] w-5 bg-current min-[360px]:w-6" />
                <div className="h-[2px] w-5 bg-current opacity-80 min-[360px]:w-6" />
                <div className="h-[2px] w-5 bg-current opacity-60 min-[360px]:w-6" />
              </div>
            </button>

            {/* Theme switch: CRT/retro-PC side = Roo Blue, moon side =
                Blackout. Last child + extra margin keeps it pinned to the
                far right, clear of the primary buttons. */}
            <button
              type="button"
              role="switch"
              aria-checked={theme === "dark"}
              onClick={handleThemeToggle}
              className={`theme-switch hidden shrink-0 md:inline-flex md:ml-3 ${focusRing}`}
              aria-label={`Switch to ${nextThemeLabel} theme. Current theme: ${themeLabel}`}
              title={`Theme: ${themeLabel}, switch to ${nextThemeLabel}`}
            >
              <span className="theme-switch-track" aria-hidden="true">
                <span className="theme-switch-icon theme-switch-icon-default">
                  <Tv />
                </span>
                <span className="theme-switch-icon theme-switch-icon-dark">
                  <Moon />
                </span>
                <span className="theme-switch-thumb" />
              </span>
              <span className="sr-only">{`Switch to ${nextThemeLabel} theme`}</span>
            </button>
            </div>
          </div>
        </div>

        {/* Mobile dropdown */}
        <div
          id="mobile-site-menu"
          className={`md:hidden overflow-hidden transition-all duration-300 ease-out ${
            open
              ? "pb-4 max-h-[680px] opacity-100 translate-y-0"
              : "max-h-0 opacity-0 -translate-y-2 pointer-events-none"
          }`}
          aria-hidden={!open}
        >
          <div className="glass-premium glass-menu-surface mt-2 transition-all duration-300">
            <div className="flex flex-col">
              <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
                <span className="text-base font-medium text-ink-secondary">
                  Theme
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={theme === "dark"}
                  onClick={handleThemeToggle}
                  className={`theme-switch inline-flex ${focusRing}`}
                  aria-label={`Switch to ${nextThemeLabel} theme. Current theme: ${themeLabel}`}
                  title={`Theme: ${themeLabel}, switch to ${nextThemeLabel}`}
                >
                  <span className="theme-switch-track" aria-hidden="true">
                    <span className="theme-switch-icon theme-switch-icon-default">
                      <Tv />
                    </span>
                    <span className="theme-switch-icon theme-switch-icon-dark">
                      <Moon />
                    </span>
                    <span className="theme-switch-thumb" />
                  </span>
                  <span className="sr-only">{`Switch to ${nextThemeLabel} theme`}</span>
                </button>
              </div>
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
              <button
                type="button"
                onClick={() =>
                  setProofOpen((v) => {
                    const next = !v;
                    if (next) setReferralsOpen(false);
                    return next;
                  })
                }
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
                className={`flex flex-col bg-[color:var(--color-surface-veil)] overflow-hidden transition-all duration-300 ${
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
              <button
                type="button"
                onClick={() =>
                  setReferralsOpen((v) => {
                    const next = !v;
                    if (next) setProofOpen(false);
                    return next;
                  })
                }
                className={`${mobileLinkBase} flex w-full items-center justify-between ${
                  isReferralsActive ? mobileLinkActive : mobileLinkIdle
                }`}
                aria-expanded={referralsOpen}
                aria-controls="mobile-referrals-menu"
              >
                Referrals
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`h-4 w-4 transition ${
                    referralsOpen ? "rotate-180" : ""
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
                id="mobile-referrals-menu"
                className={`flex flex-col bg-[color:var(--color-surface-veil)] overflow-hidden transition-all duration-300 ${
                  referralsOpen
                    ? "max-h-32 opacity-100"
                    : "max-h-0 opacity-0 pointer-events-none"
                }`}
              >
                <Link
                  to="/referrals/register"
                  onClick={() => {
                    cancelSectionTransition();
                    setReferralsOpen(false);
                    setOpen(false);
                  }}
                  className={`${mobileSubLinkBase} ${
                    isActive("/referrals/register")
                      ? mobileSubLinkActive
                      : mobileSubLinkIdle
                  }`}
                >
                  Sign Up
                </Link>
                <Link
                  to="/referrals/login"
                  onClick={() => {
                    cancelSectionTransition();
                    setReferralsOpen(false);
                    setOpen(false);
                  }}
                  className={`${mobileSubLinkBase} ${
                    isReferralsActive && !isActive("/referrals/register")
                      ? mobileSubLinkActive
                      : mobileSubLinkIdle
                  }`}
                >
                  Dashboard
                </Link>
              </div>
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
                href="https://discord.com/invite/qs5HKNyazD"
                target="_blank"
                rel="noopener noreferrer"
                className={`${mobileLinkBase} ${mobileLinkIdle} inline-flex items-center gap-2`}
              >
                Discord
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
                Packages
              </a>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

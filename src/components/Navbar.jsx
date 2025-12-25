import React, { useEffect, useState, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { FaDiscord } from "react-icons/fa";
import BackButton from "./BackButton";
import CanvasVideo from "./CanvasVideo";

const isIOSDevice = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
};

const canPlayWebm = () => {
  if (typeof document === "undefined") return false;
  const video = document.createElement("video");
  if (!video.canPlayType) return false;
  const canPlay =
    video.canPlayType('video/webm; codecs="vp9, opus"') ||
    video.canPlayType('video/webm; codecs="vp8, vorbis"') ||
    video.canPlayType("video/webm");
  return canPlay === "probably" || canPlay === "maybe";
};

const getInitialSmallLogoMode = () => {
  if (isIOSDevice()) return "apng";
  return canPlayWebm() ? "webm" : "apng";
};

export default function Navbar() {
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [smallLogoMode, setSmallLogoMode] = useState(() =>
    getInitialSmallLogoMode()
  );
  const [smallApngLoaded, setSmallApngLoaded] = useState(false);
  const proofDropdownRef = useRef(null);

  const isActive = (path) => location.pathname === path;

  const benefitsHashes = ["#services"];
  const plansHashes = ["#packages"];
  const faqHashes = ["#faq", "#upgrade-path", "#trust"];
  const isBenefitsActive =
    location.pathname === "/" && benefitsHashes.includes(location.hash || "");
  const isPlansActive =
    location.pathname === "/packages" ||
    (location.pathname === "/" && plansHashes.includes(location.hash || ""));
  const isFaqActive =
    location.pathname === "/faq" ||
    (location.pathname === "/" && faqHashes.includes(location.hash || ""));
  const isProofActive = isActive("/benchmarks") || isActive("/reviews");

  const handleSmallWebmError = () => {
    setSmallApngLoaded(false);
    setSmallLogoMode((current) => (current === "webm" ? "apng" : "static"));
  };

  const handleSmallApngError = () => {
    setSmallLogoMode("static");
  };

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 12);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
    setProofOpen(false);
  }, [location.pathname, location.hash]);

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
    const { hash } = location;
    if (!hash) return;

    let retry;
    let attempts = 0;

    const scrollToHashTarget = () => {
      const targetId = hash.replace("#", "");
      const el = document.getElementById(targetId);
      if (el) {
        const elementTop = el.getBoundingClientRect().top + window.scrollY;
        const targetY = Math.max(0, elementTop - 100);
        window.scrollTo({ top: targetY, behavior: "smooth" });
        return;
      }
      if (attempts < 8) {
        attempts += 1;
        retry = setTimeout(scrollToHashTarget, 100);
      }
    };

    scrollToHashTarget();
    return () => retry && clearTimeout(retry);
  }, [location]);

  const linkBase =
    "px-3 sm:px-5 py-2 rounded-full text-base font-medium transition border border-white/10 hover:border-cyan-300/30";
  const linkIdle = "text-white/85 hover:text-cyan-200";
  const linkActive = "bg-cyan-400 text-black border-cyan-400";
  const dropdownItemBase =
    "block w-full text-left px-4 py-3 text-sm transition first:rounded-t-xl last:rounded-b-xl";
  const dropdownItemIdle = "text-white/85 hover:text-cyan-200 hover:bg-white/5";
  const dropdownItemActive = "bg-cyan-400 text-black";
  const mobileLinkBase = "px-5 py-4 text-base transition";
  const mobileLinkIdle = "text-white/85 hover:text-cyan-200";
  const mobileLinkActive = "bg-cyan-400 text-black";
  const mobileSubLinkBase = "px-9 py-3 text-sm transition";
  const mobileSubLinkIdle = "text-white/85 hover:text-cyan-200";
  const mobileSubLinkActive = "bg-cyan-400 text-black";

  const smallLogoSizeClassName = "h-14 w-14";
  const smallLogoStaticClassName = `${smallLogoSizeClassName} object-contain drop-shadow-[0_0_18px_rgba(34,211,238,0.25)]`;
  const smallLogoAnimatedClassName = `${smallLogoSizeClassName} object-contain drop-shadow-[0_0_18px_rgba(34,211,238,0.25)] transition-all duration-500`;
  const smallLogoApngPlaceholderClassName = `${smallLogoStaticClassName} transition-opacity duration-300 ${
    smallApngLoaded ? "opacity-0" : "opacity-100"
  }`;
  const smallLogoApngClassName = `absolute inset-0 w-full h-full z-10 object-contain drop-shadow-[0_0_18px_rgba(34,211,238,0.25)] transition-all duration-500 ${
    smallApngLoaded ? "opacity-100" : "opacity-0"
  }`;

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 border-b backdrop-blur-md transition-all duration-300 ${
        scrolled ? "border-cyan-300/10" : "border-white/5"
      } ${
        scrolled
          ? "bg-gradient-to-b from-[#07162d]/92 to-[#061226]/75 shadow-[0_10px_30px_rgba(0,0,0,0.25)]"
          : "bg-gradient-to-b from-[#07162d]/80 to-[#061226]/60"
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

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex items-center h-20 sm:h-24">
          {/* Left: Logo / Back */}
          <div className="flex items-center gap-4">
            {location.pathname !== "/" ? (
              <BackButton hidden={false} inline={true} />
            ) : null}

            <Link to="/" className="flex items-center gap-3 select-none">
              <div className="relative h-14 w-14 grid place-items-center">
                {smallLogoMode === "static" ? (
                  <img
                    src="/favicon.svg"
                    alt="Roo Industries"
                    className={smallLogoStaticClassName}
                    loading="eager"
                    fetchPriority="high"
                  />
                ) : smallLogoMode === "apng" ? (
                  <>
                    <img
                      src="/favicon.svg"
                      alt=""
                      aria-hidden="true"
                      className={smallLogoApngPlaceholderClassName}
                      loading="eager"
                      fetchPriority="high"
                    />
                    <img
                      src="/logo-animated-small.png"
                      alt="Roo Industries"
                      className={smallLogoApngClassName}
                      loading="eager"
                      fetchPriority="high"
                      decoding="async"
                      onLoad={() => setSmallApngLoaded(true)}
                      onError={handleSmallApngError}
                    />
                  </>
                ) : (
                  <CanvasVideo
                    src="/logo-animated-small.webm"
                    poster="/favicon.svg"
                    alt="Roo Industries"
                    onError={handleSmallWebmError}
                    className={`${smallLogoAnimatedClassName} roo-logo-video`}
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
              <Link
                to="/#services"
                className={`${linkBase} ${
                  isBenefitsActive ? linkActive : linkIdle
                }`}
              >
                Benefits
              </Link>
              <Link
                to="/#packages"
                className={`${linkBase} ${
                  isPlansActive ? linkActive : linkIdle
                }`}
              >
                Plans
              </Link>
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
                <div
                  className={`absolute right-0 mt-2 w-44 rounded-2xl border border-white/10 bg-[#061226]/95 backdrop-blur-md shadow-[0_12px_30px_rgba(0,0,0,0.35)] overflow-hidden transition-all duration-200 ${
                    proofOpen
                      ? "opacity-100 visible translate-y-0"
                      : "opacity-0 invisible translate-y-1 pointer-events-none"
                  }`}
                >
                  <Link
                    to="/benchmarks"
                    onClick={() => setProofOpen(false)}
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
                    onClick={() => setProofOpen(false)}
                    className={`block px-4 py-3 text-sm transition ${
                      isActive("/reviews")
                        ? "bg-cyan-400 text-black"
                        : "text-white/85 hover:text-cyan-200 hover:bg-white/5"
                    }`}
                  >
                    Reviews
                  </Link>
                </div>
              </div>
              <Link
                to="/#faq"
                className={`${linkBase} ${isFaqActive ? linkActive : linkIdle}`}
              >
                FAQ
              </Link>
            </nav>

            <a
              href="https://discord.gg/M7nTkn9dxE"
              target="_blank"
              rel="noreferrer"
              className="
                  hidden sm:inline-flex items-center gap-2
                  px-4 py-2.5 text-base font-semibold whitespace-nowrap rounded-full
                  max-[820px]:px-3 max-[820px]:text-sm max-[820px]:gap-1.5
                  text-white
                  border border-cyan-300/30
                  bg-cyan-400/10 hover:bg-cyan-400/15
                  hover:border-cyan-300/50
                  shadow-[0_0_18px_rgba(34,211,238,0.14)]
                  transition
                "
            >
              <FaDiscord className="text-[1.1em]" aria-hidden="true" />
              Discord
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
          <div className="mt-2 border border-white/10 bg-[#061226]/55 backdrop-blur-md transition-all duration-300">
            <div className="flex flex-col">
              <Link
                to="/#services"
                className={`${mobileLinkBase} ${
                  isBenefitsActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                Benefits
              </Link>
              <Link
                to="/#packages"
                className={`${mobileLinkBase} ${
                  isPlansActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                Plans
              </Link>
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
              <Link
                to="/#faq"
                className={`${mobileLinkBase} ${
                  isFaqActive ? mobileLinkActive : mobileLinkIdle
                }`}
              >
                FAQ
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

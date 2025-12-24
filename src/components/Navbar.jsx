import React, { useEffect, useRef, useState } from "react";
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
  const [isVisible, setIsVisible] = useState(true);
  const [isPastLogo, setIsPastLogo] = useState(false);
  const [smallLogoMode, setSmallLogoMode] = useState(() =>
    getInitialSmallLogoMode()
  );
  const [smallApngLoaded, setSmallApngLoaded] = useState(false);
  const [isNotchInView, setIsNotchInView] = useState(true);
  const [useNotchVisibility, setUseNotchVisibility] = useState(false);
  const lastScrollYRef = useRef(0);
  const floatingNavRef = useRef(null);

  const isActive = (path) => location.pathname === path;

  const faqHashes = ["#faq", "#upgrade-path", "#trust"];
  const isFaqActive =
    location.pathname === "/faq" ||
    (location.pathname === "/" && faqHashes.includes(location.hash || ""));

  const handleSmallWebmError = () => {
    setSmallApngLoaded(false);
    setSmallLogoMode((current) => (current === "webm" ? "apng" : "static"));
  };

  const handleSmallApngError = () => {
    setSmallLogoMode("static");
  };

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const lastScrollY = lastScrollYRef.current;
      const logoEl = document.querySelector(".roo-logo");
      const viewportHeight =
        window.innerHeight || document.documentElement.clientHeight;
      const logoRect = logoEl ? logoEl.getBoundingClientRect() : null;
      const isLogoInView = logoRect
        ? logoRect.bottom > 0 && logoRect.top < viewportHeight
        : false;
      const logoStyle = logoEl ? window.getComputedStyle(logoEl) : null;
      const nextUseNotchVisibility = logoStyle
        ? logoStyle.position === "fixed" ||
          logoStyle.position === "absolute" ||
          logoStyle.position === "sticky"
        : false;
      const nextIsPastLogo = !isLogoInView;
      const nextIsVisible =
        !nextIsPastLogo || !(currentScrollY > lastScrollY && currentScrollY > 50);

      setIsVisible(nextIsVisible);
      setScrolled(currentScrollY > 12);
      lastScrollYRef.current = currentScrollY;
      setIsPastLogo(nextIsPastLogo);
      setUseNotchVisibility(nextUseNotchVisibility);

      const floatingEl = floatingNavRef.current;
      let nextIsNotchInView = false;
      if (floatingEl) {
        const rect = floatingEl.getBoundingClientRect();
        const inView = rect.bottom > 0 && rect.top < viewportHeight;
        const style = window.getComputedStyle(floatingEl);
        const opacity = Number(style.opacity || 0);
        const isRendered =
          style.display !== "none" && style.visibility !== "hidden";
        nextIsNotchInView = inView && isRendered && opacity > 0.05;
      }
      setIsNotchInView(nextIsNotchInView);

    };

    handleScroll();

    const handleResize = () => {
      handleScroll();
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [location.pathname]);

  useEffect(() => {
    if (!isPastLogo) setOpen(false);
  }, [isPastLogo]);

  // close mobile menu on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.hash]);

  // Hash smooth scroll
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
        const targetY = Math.max(0, elementTop - 84); // offset for fixed navbar
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
    "px-2 sm:px-4 py-1.5 rounded-full text-sm font-medium transition";
  const linkIdle = "text-white/85 hover:text-cyan-200";
  const linkActive = "bg-cyan-400 text-black";
  const showFloating = !isPastLogo && isVisible;
  const showFixed = useNotchVisibility ? !isNotchInView : isPastLogo;
  const smallLogoSizeClassName = "h-11 w-11";
  const smallLogoStaticClassName = `${smallLogoSizeClassName} object-contain drop-shadow-[0_0_18px_rgba(34,211,238,0.25)]`;
  const smallLogoAnimatedClassName = `${smallLogoSizeClassName} object-contain drop-shadow-[0_0_18px_rgba(34,211,238,0.25)] transition-all duration-500`;
  const smallLogoApngPlaceholderClassName = `${smallLogoStaticClassName} transition-opacity duration-300 ${
    smallApngLoaded ? "opacity-0" : "opacity-100"
  }`;
  const smallLogoApngClassName = `absolute inset-0 w-full h-full z-10 object-contain drop-shadow-[0_0_18px_rgba(34,211,238,0.25)] transition-all duration-500 ${
    smallApngLoaded ? "opacity-100" : "opacity-0"
  }`;

  return (
    <>
      {/* Floating nav (Nav 1) */}
      <nav
        ref={floatingNavRef}
        className={`
          site-nav
          w-full z-40 px-2 sm:px-8 transition-all duration-500 ease-in-out
          ${showFloating ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0 pointer-events-none"}
          ${
            isPastLogo
              ? "fixed top-5"
              : "absolute top-[2.8rem] max-[639px]:top-[6.5rem] max-[479px]:top-[3rem]"
          }
        `}
        aria-hidden={!showFloating}
      >
        <div
          className="
            relative mx-auto 
            max-w-md sm:max-w-3xl 
            md:max-w-[80%] xl:max-w-3xl
            flex items-center justify-center
            px-3 sm:px-6 md:px-4 py-2 sm:py-3 md:py-2
            rounded-full bg-[#0f172a]/80 backdrop-blur-md
            shadow-[0_0_25px_rgba(0,255,255,0.2)]
            border border-cyan-400/10 overflow-hidden
            transition-all duration-300
          "
        >
          {/* Back Button */}
          {location.pathname !== "/" && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 scale-90 sm:scale-95 z-[60]">
              <BackButton hidden={false} inline={true} />
            </div>
          )}

          {/* Nav Links */}
          <div
            className={`flex justify-center space-x-2 sm:space-x-4 text-white text-xs sm:text-sm md:text-[13px] font-medium transition-all duration-300
              ${location.pathname !== "/" ? "max-sm:translate-x-8" : ""}
            `}
          >
            <Link
              to="/#faq"
              className={`hidden sm:inline px-2 sm:px-4 py-1.5 rounded-full transition ${
                isFaqActive ? "bg-cyan-400 text-black" : "hover:text-cyan-400"
              }`}
            >
              FAQ
            </Link>
            <Link
              to="/benchmarks"
              className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
                isActive("/benchmarks")
                  ? "bg-cyan-400 text-black"
                  : "hover:text-cyan-400"
              }`}
            >
              Benchmarks
            </Link>

            <Link
              to="/reviews"
              className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
                isActive("/reviews")
                  ? "bg-cyan-400 text-black"
                  : "hover:text-cyan-400"
              }`}
            >
              Reviews
            </Link>

            <Link
              to="/#packages"
              className="px-2 sm:px-4 py-1.5 rounded-full transition hover:text-cyan-400"
            >
              Plans
            </Link>
            <Link
              to="/tools"
              className={`px-2 sm:px-4 py-1.5 rounded-full transition max-[850px]:hidden ${
                isActive("/tools")
                  ? "bg-cyan-400 text-black"
                  : "hover:text-cyan-400"
              }`}
            >
              Tools
            </Link>
            <a
              href="https://discord.gg/M7nTkn9dxE"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 sm:px-4 py-1.5 rounded-full transition hover:text-cyan-400"
            >
              <FaDiscord
                className="text-[1.1em] relative top-[-0.25px] flex-shrink-0"
                aria-hidden="true"
              />
              <span className="leading-none">Discord</span>
            </a>
          </div>
        </div>
      </nav>

      {/* Fixed header (Nav 2 - after main logo) */}
      <header
        className={`fixed top-0 left-0 right-0 z-50 border-b backdrop-blur-md transition-[opacity,transform] duration-500 ease-in-out will-change-transform ${
          scrolled ? "border-cyan-300/10" : "border-white/5"
        } ${
          scrolled
            ? "bg-gradient-to-b from-[#07162d]/92 to-[#061226]/75 shadow-[0_10px_30px_rgba(0,0,0,0.25)]"
            : "bg-gradient-to-b from-[#07162d]/65 to-[#061226]/35"
        } ${showFixed ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2 pointer-events-none"}`}
        aria-hidden={!showFixed}
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
          <div className="flex items-center justify-between py-2 sm:h-16 sm:py-0">
              {/* Left: Logo / Back */}
              <div className="flex items-center gap-3">
                {location.pathname !== "/" ? (
                  <BackButton hidden={false} inline={true} />
                ) : null}

                <Link to="/" className="flex items-center gap-2 select-none">
                  <div className="relative h-11 w-11 grid place-items-center">
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
                    <div className="text-white font-semibold tracking-wide">
                      Roo Industries
                    </div>
                    <div className="text-[11px] text-white/55">
                      Precision Performance Engineering
                    </div>
                  </div>
                </Link>
              </div>

              {/* Center: Links (desktop) */}
              <nav className="hidden md:flex items-center gap-1">
                <Link
                  to="/#faq"
                  className={`${linkBase} ${
                    isFaqActive ? linkActive : linkIdle
                  }`}
                >
                  FAQ
                </Link>
                <Link
                  to="/benchmarks"
                  className={`${linkBase} ${
                    isActive("/benchmarks") ? linkActive : linkIdle
                  }`}
                >
                  Benchmarks
                </Link>
                <Link
                  to="/reviews"
                  className={`${linkBase} ${
                    isActive("/reviews") ? linkActive : linkIdle
                  }`}
                >
                  Reviews
                </Link>
                <Link to="/#packages" className={`${linkBase} ${linkIdle}`}>
                  Plans
                </Link>
                <Link
                  to="/tools"
                  className={`${linkBase} ${
                    isActive("/tools") ? linkActive : linkIdle
                  }`}
                >
                  Tools
                </Link>
              </nav>

              {/* Right: CTA + Mobile */}
              <div className="flex items-center gap-2">
                <a
                  href="https://discord.gg/M7nTkn9dxE"
                  target="_blank"
                  rel="noreferrer"
                  className="
                    hidden sm:inline-flex items-center gap-2
                    px-3 py-2 text-sm font-semibold whitespace-nowrap
                    max-[820px]:px-2 max-[820px]:text-xs max-[820px]:gap-1
                    text-white
                    border border-cyan-300/15
                    bg-cyan-400/10 hover:bg-cyan-400/15
                    shadow-[0_0_18px_rgba(34,211,238,0.14)]
                    transition
                  "
                >
                  <FaDiscord className="text-[1.05em]" aria-hidden="true" />
                  Join Discord
                </a>

                {/* Mobile menu button */}
                <button
                  onClick={() => setOpen((v) => !v)}
                  className="
                    md:hidden
                    h-10 w-10 grid place-items-center
                    text-white/90 hover:text-cyan-200
                    border border-white/10 hover:border-cyan-300/20
                    bg-white/5 hover:bg-cyan-400/10
                    transition
                  "
                  aria-label="Open menu"
                >
                  <div className="space-y-1">
                    <div className="h-[2px] w-5 bg-current" />
                    <div className="h-[2px] w-5 bg-current opacity-80" />
                    <div className="h-[2px] w-5 bg-current opacity-60" />
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
                  to="/#faq"
                  className={`px-4 py-3 text-sm ${
                    isFaqActive ? "bg-cyan-400 text-black" : "text-white/85"
                  } hover:text-cyan-200 transition`}
                >
                  FAQ
                </Link>
                <Link
                  to="/benchmarks"
                  className={`px-4 py-3 text-sm ${
                    isActive("/benchmarks")
                      ? "bg-cyan-400 text-black"
                      : "text-white/85"
                  } hover:text-cyan-200 transition`}
                >
                  Benchmarks
                </Link>
                <Link
                  to="/reviews"
                  className={`px-4 py-3 text-sm ${
                    isActive("/reviews")
                      ? "bg-cyan-400 text-black"
                      : "text-white/85"
                  } hover:text-cyan-200 transition`}
                >
                  Reviews
                </Link>
                <Link
                  to="/#packages"
                  className="px-4 py-3 text-sm text-white/85 hover:text-cyan-200 transition"
                >
                  Plans
                </Link>
                <Link
                  to="/tools"
                  className={`px-4 py-3 text-sm ${
                    isActive("/tools")
                      ? "bg-cyan-400 text-black"
                      : "text-white/85"
                  } hover:text-cyan-200 transition`}
                >
                  Tools
                </Link>

                <a
                  href="https://discord.gg/M7nTkn9dxE"
                  target="_blank"
                  rel="noreferrer"
                  className="px-4 py-3 text-sm text-white/85 hover:text-cyan-200 transition inline-flex items-center gap-2"
                >
                  <FaDiscord aria-hidden="true" />
                  Join Discord
                </a>
              </div>
            </div>
          </div>
        </div>
      </header>
    </>
  );
}

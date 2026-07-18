import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import useHomeSectionLinkHandler from "../../lib/useHomeSectionLinkHandler";

const HeroScene3D = lazy(() => import("./HeroScene3D"));

const FPS_FROM = 96;
const FPS_TO = 244;
const TEMP_FROM = 84;
const TEMP_TO = 66;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const smoothstep = (value, edge0, edge1) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function supportsWebgl() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") || canvas.getContext("webgl")
    );
  } catch {
    return false;
  }
}

export default function Hero3DSection() {
  const handleHomeSectionLink = useHomeSectionLinkHandler();
  const [enabled, setEnabled] = useState(false);
  const [near, setNear] = useState(false);
  const [active, setActive] = useState(false);

  const wrapperRef = useRef(null);
  const viewportRef = useRef(null);
  const progressRef = useRef(0);
  const hintRef = useRef(null);
  const payoffRef = useRef(null);
  const fpsRef = useRef(null);
  const tempRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const force = new URLSearchParams(window.location.search).has("hero3d");
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const desktop =
      window.innerWidth >= 1024 &&
      window.matchMedia("(pointer: fine)").matches;
    setEnabled((force || (!reducedMotion && desktop)) && supportsWebgl());
  }, []);

  const syncFromScroll = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return;
    const p = clamp01(-rect.top / total);
    progressRef.current = p;

    // Ancestors use overflow hidden, which breaks position sticky, so the
    // viewport is pinned manually from the same scroll frame.
    if (viewportRef.current) {
      const pin = Math.min(Math.max(-rect.top, 0), total);
      viewportRef.current.style.transform = `translate3d(0, ${pin}px, 0)`;
    }

    if (hintRef.current) {
      hintRef.current.style.opacity = (1 - smoothstep(p, 0.04, 0.14)).toFixed(3);
    }

    const payoff = smoothstep(p, 0.74, 0.94);
    if (payoffRef.current) {
      payoffRef.current.style.opacity = payoff.toFixed(3);
      payoffRef.current.style.pointerEvents = payoff > 0.6 ? "auto" : "none";
      payoffRef.current.style.transform = `translateY(${(1 - payoff) * 18}px)`;
    }
    if (fpsRef.current) {
      fpsRef.current.textContent = String(
        Math.round(FPS_FROM + (FPS_TO - FPS_FROM) * payoff)
      );
    }
    if (tempRef.current) {
      tempRef.current.textContent = String(
        Math.round(TEMP_FROM - (TEMP_FROM - TEMP_TO) * payoff)
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(syncFromScroll);
    };
    syncFromScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, syncFromScroll]);

  useEffect(() => {
    if (!enabled) return undefined;
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === "undefined") {
      setNear(true);
      setActive(true);
      return undefined;
    }
    const nearObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          nearObserver.disconnect();
        }
      },
      { rootMargin: "900px 0px" }
    );
    const activeObserver = new IntersectionObserver((entries) => {
      setActive(entries.some((entry) => entry.isIntersecting));
    });
    nearObserver.observe(wrapper);
    activeObserver.observe(wrapper);
    return () => {
      nearObserver.disconnect();
      activeObserver.disconnect();
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <section
      ref={wrapperRef}
      aria-label="What a Roo Industries optimization touches"
      className="relative"
      style={{ height: "260vh" }}
    >
      <div
        ref={viewportRef}
        className="absolute inset-x-0 top-0 h-screen overflow-hidden"
        style={{ willChange: "transform" }}
      >
        {near && (
          <Suspense fallback={null}>
            <HeroScene3D progressRef={progressRef} active={active} />
          </Suspense>
        )}

        <div
          ref={hintRef}
          className="pointer-events-none absolute inset-x-0 top-14 text-center"
        >
          <p className="text-sm sm:text-base font-semibold tracking-wide text-ink-secondary">
            Scroll. We take it apart.
          </p>
        </div>

        <div
          ref={payoffRef}
          className="absolute inset-x-0 bottom-14 flex flex-col items-center gap-4"
          style={{ opacity: 0, pointerEvents: "none" }}
        >
          <p className="text-2xl sm:text-3xl font-extrabold tracking-tight text-ink">
            Same hardware. More frames.
          </p>
          <div className="flex items-end gap-10">
            <div className="text-center">
              <p
                className="text-5xl font-extrabold text-accent tabular-nums"
                style={{ textShadow: "0 0 14px var(--color-accent-glow)" }}
              >
                <span ref={fpsRef}>{FPS_FROM}</span>
              </p>
              <p className="mt-1 text-xs uppercase tracking-widest text-ink-secondary">
                avg FPS
              </p>
            </div>
            <div className="text-center">
              <p className="text-5xl font-extrabold text-ink tabular-nums">
                <span ref={tempRef}>{TEMP_FROM}</span>
                <span className="text-2xl align-top">°C</span>
              </p>
              <p className="mt-1 text-xs uppercase tracking-widest text-ink-secondary">
                GPU temp
              </p>
            </div>
          </div>
          <Link
            to="/#packages"
            onClick={(event) => handleHomeSectionLink(event, "#packages")}
            className="glow-button book-optimization-button relative inline-flex items-center justify-center gap-2 rounded-md px-6 py-3 text-sm sm:text-base font-semibold text-white ring-2 ring-line-accent hover:text-white active:translate-y-px transition-all duration-300"
          >
            See what we tune
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </div>
      </div>
    </section>
  );
}

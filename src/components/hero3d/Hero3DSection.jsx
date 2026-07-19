import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import Hero from "../Hero";
import HeroSplitCopy from "./HeroSplitCopy";
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

// Must match the remap in HeroScene3D.
const scenePhase = (rawP) => clamp01((rawP - 0.16) / 0.84);

function supportsWebgl() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const VARIANT_KEYS = ["v1", "v2", "v3", "v4", "v5", "v6"];
const VARIANT_SCRIM = { v1: 1.0, v2: 0.75, v3: 0.45, v4: 0.3, v5: 0.9, v6: 0 };

export default function Hero3DSection() {
  const handleHomeSectionLink = useHomeSectionLinkHandler();
  const [enabled, setEnabled] = useState(false);
  const [variantKey, setVariantKey] = useState("v6");
  const [near, setNear] = useState(false);
  const [active, setActive] = useState(false);

  const wrapperRef = useRef(null);
  const viewportRef = useRef(null);
  const scrimRef = useRef(null);
  const copyRef = useRef(null);
  const pinModeRef = useRef("before");
  const variantRef = useRef("v6");
  const progressRef = useRef(0);
  const topFracRef = useRef(0);
  const hintRef = useRef(null);
  const payoffRef = useRef(null);
  const fpsRef = useRef(null);
  const tempRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const force = params.has("hero3d");
    const requested = params.get("hero3d");
    if (VARIANT_KEYS.includes(requested)) {
      setVariantKey(requested);
      variantRef.current = requested;
    }
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const desktop =
      window.innerWidth >= 1024 && window.matchMedia("(pointer: fine)").matches;
    setEnabled((force || (!reducedMotion && desktop)) && supportsWebgl());
  }, []);

  const syncFromScroll = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return;
    const rawP = clamp01(-rect.top / total);
    progressRef.current = rawP;
    topFracRef.current = Math.max(0, rect.top) / window.innerHeight;
    const p = scenePhase(rawP);

    document.documentElement.classList.toggle(
      "hero3d-stage-active",
      rect.bottom > 0
    );

    // Ancestors use overflow hidden, which breaks position sticky, and a
    // transform pin lags scroll by a frame. Fixed-position pinning holds the
    // stage without any per-frame movement.
    if (viewportRef.current) {
      const vh = window.innerHeight;
      const mode =
        rect.top > 0 ? "before" : rect.bottom < vh ? "after" : "pinned";
      if (mode !== pinModeRef.current) {
        pinModeRef.current = mode;
        const style = viewportRef.current.style;
        if (mode === "pinned") {
          style.position = "fixed";
          style.top = "0";
          style.bottom = "auto";
        } else if (mode === "before") {
          style.position = "absolute";
          style.top = "0";
          style.bottom = "auto";
        } else {
          style.position = "absolute";
          style.top = "auto";
          style.bottom = "0";
        }
        style.left = "0";
        style.right = "0";
        style.transform = "none";
      }
    }

    if (scrimRef.current) {
      const heroP = 1 - smoothstep(rawP, 0.02, 0.2);
      const strength =
        variantRef.current === "v6" ? 0.9 : VARIANT_SCRIM[variantRef.current] || 1;
      scrimRef.current.style.opacity = (heroP * strength).toFixed(3);
    }

    if (copyRef.current) {
      const heroP = 1 - smoothstep(rawP, 0.02, 0.18);
      copyRef.current.style.opacity = heroP.toFixed(3);
      copyRef.current.style.pointerEvents = heroP > 0.5 ? "auto" : "none";
    }

    if (hintRef.current) {
      hintRef.current.style.opacity = (
        smoothstep(rawP, 0.01, 0.05) * (1 - smoothstep(p, 0.08, 0.16))
      ).toFixed(3);
    }

    const payoff =
      variantRef.current === "v6"
        ? smoothstep(p, 0.93, 0.985)
        : smoothstep(p, 0.7, 0.9);
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
      document.documentElement.classList.remove("hero3d-stage-active");
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

  useEffect(() => {
    if (!enabled || variantKey !== "v6") return undefined;
    document.documentElement.dataset.hero3dBenefits = "on";
    window.dispatchEvent(new Event("hero3d:benefits"));
    return () => {
      delete document.documentElement.dataset.hero3dBenefits;
      window.dispatchEvent(new Event("hero3d:benefits"));
    };
  }, [enabled, variantKey]);

  // Gated environments keep the plain hero, untouched.
  if (!enabled) return <Hero />;

  return (
    <section
      ref={wrapperRef}
      aria-label="What a Roo Industries optimization touches"
      className="relative"
      style={{
        height: variantKey === "v6" ? "380vh" : "210vh",
        contain: "none",
      }}
    >
      <div
        ref={viewportRef}
        className="absolute inset-x-0 top-0 h-screen overflow-hidden"
        style={{ willChange: "transform" }}
      >
        {near && (
          <Suspense fallback={null}>
            <HeroScene3D progressRef={progressRef} topFracRef={topFracRef} active={active} variantKey={variantKey} />
          </Suspense>
        )}

        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 52%, rgba(2, 6, 14, 0.42) 100%)",
          }}
        />

        <div
          ref={scrimRef}
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              variantKey === "v6"
                ? "linear-gradient(90deg, rgba(4, 8, 16, 0.85) 0%, rgba(4, 8, 16, 0.55) 40%, transparent 64%)"
                : "linear-gradient(180deg, rgba(4, 8, 16, 0.78) 0%, rgba(4, 8, 16, 0.5) 42%, transparent 72%)",
          }}
        />

        <div
          ref={hintRef}
          className="pointer-events-none absolute inset-x-0 bottom-8 text-center"
          style={{ opacity: 0 }}
        >
          <p className="text-sm sm:text-base font-semibold tracking-wide text-ink-secondary">
            Keep scrolling. We take it apart.
          </p>
        </div>

        <div
          ref={payoffRef}
          className="absolute inset-x-0 bottom-12 flex flex-col items-center gap-4"
          style={{ opacity: 0, pointerEvents: "none" }}
        >
          <p className="text-2xl sm:text-3xl font-extrabold tracking-tight text-ink">
            Same hardware. More frames.
          </p>
          <p className="text-sm text-ink-secondary">
            OBS, encoder, and capture settings set up around your games too.
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

      <div ref={copyRef} className="relative z-10">
        {variantKey === "v6" ? <HeroSplitCopy /> : <Hero />}
      </div>
    </section>
  );
}

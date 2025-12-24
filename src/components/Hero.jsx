import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../sanityClient";
import {
  getPreloadedState,
  isReactSnap,
  setSnapState,
} from "../utils/prerenderState";

export default function Hero() {
  const [preloaded] = useState(() => getPreloadedState("home.hero"));
  const hasPreloaded = typeof preloaded !== "undefined";
  const [heroData, setHeroData] = useState(() => preloaded ?? null);
  const [line2NoWrap, setLine2NoWrap] = useState(false);
  const headingRef = useRef(null);
  const line2MeasureRef = useRef(null);

  useEffect(() => {
    if (hasPreloaded) return; // react-snap preloaded this content.
    client
      .fetch(
        `*[_type == "hero"][0]{
          tagline,
          headingLine1,
          headingLine2,
          description,
          subtext,
          ctaPrimaryText,
          ctaSecondaryText,
          ctaNote,
          ctaNoteIcon,
          bullets
        }`
      )
      .then((data) => {
        setHeroData(data);
        if (isReactSnap()) {
          setSnapState("home.hero", data);
        }
      })
      .catch(console.error);
  }, [hasPreloaded]);

  const tagline = heroData?.tagline;
  const headingLine1 = heroData?.headingData1 || heroData?.headingLine1;
  const headingLine2 = heroData?.headingLine2;
  const description = heroData?.description;
  const subtext = heroData?.subtext;
  const bullets = heroData?.bullets || [];
  const primaryCtaText = heroData?.ctaPrimaryText || "Tune My Rig";
  const secondaryCtaText = heroData?.ctaSecondaryText || "See the Proof";
  const headingLine2BaseClass =
    "bg-gradient-to-r from-sky-400 to-blue-500 text-transparent bg-clip-text drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]";

  const normalizeText = (s = "") =>
    String(s)
      .replace(/\\u00a0/g, " ")
      .replace(/\u00a0/g, " ");

  const renderWithGlow110 = (text) => {
    const cleaned = normalizeText(text);
    const target = "110% FPS";
    if (!cleaned || !cleaned.includes(target)) return cleaned;

    const parts = cleaned.split(target);

    return (
      <>
        {parts[0]}
        <span className="text-cyan-200 drop-shadow-[0_0_10px_rgba(34,211,238,0.95)]">
          {target}
        </span>
        {parts.slice(1).join(target)}
      </>
    );
  };

  const renderHeadingLine1 = (text) => {
    if (!text) return null;

    const cleaned = normalizeText(text);

    if (cleaned.includes("-")) {
      const parts = cleaned.split("-");
      const firstPart = parts[0].trim();
      const secondPart = parts.slice(1).join("-").trim();

      return (
        <>
          <span className="text-white">
            {renderWithGlow110(`${firstPart} - `)}
          </span>
          <span className="bg-gradient-to-r from-sky-400 to-blue-500 text-transparent bg-clip-text drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]">
            {renderWithGlow110(secondPart)}
          </span>
        </>
      );
    }

    return <span className="text-white">{renderWithGlow110(cleaned)}</span>;
  };

  useEffect(() => {
    if (!headingLine2) {
      setLine2NoWrap(false);
      return;
    }

    const container = headingRef.current;
    const measureEl = line2MeasureRef.current;
    if (!container || !measureEl) return;

    let frame = 0;

    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const containerWidth = container.clientWidth;
        const textWidth = measureEl.offsetWidth;
        const totalBuffer = Math.max(24, Math.round(containerWidth * 0.08));
        const maxLineWidth = containerWidth - totalBuffer;
        const next =
          textWidth > 0 && maxLineWidth > 0 && textWidth <= maxLineWidth;
        setLine2NoWrap((prev) => (prev === next ? prev : next));
      });
    };

    update();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (frame) cancelAnimationFrame(frame);
      };
    }

    const ro = new ResizeObserver(update);
    ro.observe(container);
    ro.observe(measureEl);

    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [headingLine2]);

  const headingLine2Node = useMemo(() => {
    if (!headingLine2) return null;

    return (
      <span
        className={`block ${headingLine2BaseClass} ${
          line2NoWrap ? "whitespace-nowrap" : "whitespace-normal"
        }`}
      >
        {renderWithGlow110(headingLine2)}
      </span>
    );
  }, [headingLine2, headingLine2BaseClass, line2NoWrap]);

  const ctaNote = heroData?.ctaNote;
  const ctaNoteIcon = heroData?.ctaNoteIcon;

  return (
    <header id="top" className="py-16 flex justify-center">
      <section className="mx-auto max-w-4xl px-6 text-center">
        <div className="h-[30px] sm:h-[36px] flex justify-center items-center">
          {tagline && (
            <div className="inline-flex items-center rounded-full border border-slate-700/80 bg-slate-900/70 px-4 sm:px-5 py-1.5 sm:py-2 shadow-[0_0_10px_rgba(0,255,255,0.6),0_0_20px_rgba(0,255,255,0.4)]">
              <span className="text-[11px] sm:text-sm font-medium text-slate-200">
                {renderWithGlow110(tagline)}
              </span>
            </div>
          )}
        </div>

        <div className="mt-8 w-full">
          <h1
            ref={headingRef}
            className="relative text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight text-center"
          >
            {headingLine1 && (
              <span className="block">{renderHeadingLine1(headingLine1)}</span>
            )}
            {headingLine2Node}

            {headingLine2 && (
              <span
                ref={line2MeasureRef}
                aria-hidden="true"
                className={`absolute left-0 top-0 inline-block ${headingLine2BaseClass} pointer-events-none opacity-0 whitespace-nowrap`}
              >
                {renderWithGlow110(headingLine2)}
              </span>
            )}
          </h1>
        </div>

        <div className="min-h-[48px] sm:min-h-[60px]">
          {description && (
            <p className="mt-4 text-sm sm:text-base md:text-lg text-slate-200/90 leading-relaxed max-w-2xl mx-auto">
              {renderWithGlow110(description)}
            </p>
          )}
        </div>

        <div className="min-h-[32px] sm:min-h-[36px]">
          {subtext && (
            <p className="mt-6 text-[14px] sm:text-lg font-semibold text-cyan-300">
              {renderWithGlow110(subtext)}
            </p>
          )}
        </div>

        <div className="mt-7 flex items-center justify-center gap-3 sm:gap-4 flex-wrap min-h-[56px]">
          <Link
            to="/#packages"
            className="glow-button book-optimization-button relative inline-flex items-center justify-center gap-2 rounded-md px-4 sm:px-6 py-2.5 sm:py-3.5 text-sm sm:text-base font-semibold text-white ring-2 ring-cyan-300/70 hover:text-white active:translate-y-px transition-all duration-300"
          >
            {renderWithGlow110(primaryCtaText)}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>

          <Link
            to="/benchmarks"
            className="glow-button fps-boosts-button inline-flex items-center justify-center gap-2 rounded-md px-4 sm:px-6 py-2.5 sm:py-3.5 text-sm sm:text-base font-semibold text-white ring-1 ring-sky-700/50 active:translate-y-px transition-all duration-300"
          >
            {renderWithGlow110(secondaryCtaText)}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </div>

        {ctaNote && (
          <p className="mt-5 text-sm sm:text-base font-extrabold tracking-wide relative inline-flex items-center gap-2">
            {ctaNoteIcon && (
              <span className="text-slate-100" aria-hidden="true">
                {ctaNoteIcon}
              </span>
            )}
            <span
              className="bg-gradient-to-r from-amber-200 via-orange-300 to-amber-100 text-transparent bg-clip-text
        [text-shadow:
          0_0_10px_rgba(245,158,11,0.90),
          0_0_22px_rgba(217,119,6,0.85),
          0_0_44px_rgba(180,83,9,0.70),
          0_0_80px_rgba(124,45,18,0.55)
        ]"
            >
              {ctaNote}
            </span>
          </p>
        )}

        <div className="mt-5 w-full">
          {bullets.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 sm:gap-x-6">
              {bullets.map((text, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-400 shrink-0" />
                  <span className="text-s sm:text-s font-medium text-slate-200 whitespace-nowrap">
                    {renderWithGlow110(text)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </header>
  );
}

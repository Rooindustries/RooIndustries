import React, { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { client } from "../sanityClient";

export default function Hero() {
  const [heroData, setHeroData] = useState(null);
  const containerRef = useRef(null);
  const line1Ref = useRef(null);
  const line2Ref = useRef(null);
  const [line1FontSize, setLine1FontSize] = useState(null);
  const [line2FontSize, setLine2FontSize] = useState(null);

  // Base font sizes in pixels for different breakpoints
  const getBaseFontSize = useCallback(() => {
    if (typeof window === "undefined") return 48;
    const width = window.innerWidth;
    if (width >= 1024) return 60; // lg:text-6xl = 3.75rem = 60px
    if (width >= 640) return 48; // sm:text-5xl = 3rem = 48px
    return 30; // text-3xl = 1.875rem = 30px
  }, []);

  useEffect(() => {
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
      .then(setHeroData)
      .catch(console.error);
  }, []);

  const tagline = heroData?.tagline;
  const headingLine1 = heroData?.headingData1 || heroData?.headingLine1;
  const headingLine2 = heroData?.headingLine2;
  const description = heroData?.description;
  const subtext = heroData?.subtext;
  const bullets = heroData?.bullets || [];
  const primaryCtaText = heroData?.ctaPrimaryText || "Tune My Rig";
  const secondaryCtaText = heroData?.ctaSecondaryText || "See the Proof";
  const ctaNote = heroData?.ctaNote;
  const ctaNoteIcon = heroData?.ctaNoteIcon;

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

  // Calculate optimal font size to fit container
  const calculateFontSizes = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const padding = 16;
    const maxWidth = containerWidth - padding;
    const baseFontSize = getBaseFontSize();

    // Helper function to find optimal font size
    const findOptimalFontSize = (element, baseSize) => {
      if (!element) return baseSize;

      // Reset to base size to measure
      element.style.fontSize = `${baseSize}px`;

      // Force reflow
      void element.offsetWidth;

      const naturalWidth = element.scrollWidth;

      if (naturalWidth <= maxWidth) {
        return baseSize;
      }

      // Calculate the ratio and apply it to font size
      const ratio = maxWidth / naturalWidth;
      const newSize = Math.floor(baseSize * ratio);

      // Set minimum font size (don't go below 50% of base)
      return Math.max(newSize, baseFontSize * 0.5);
    };

    // Calculate for line 1
    if (line1Ref.current && headingLine1) {
      const optimalSize = findOptimalFontSize(line1Ref.current, baseFontSize);
      setLine1FontSize(optimalSize);
    } else {
      setLine1FontSize(null);
    }

    // Calculate for line 2
    if (line2Ref.current && headingLine2) {
      const optimalSize = findOptimalFontSize(line2Ref.current, baseFontSize);
      setLine2FontSize(optimalSize);
    } else {
      setLine2FontSize(null);
    }
  }, [getBaseFontSize, headingLine1, headingLine2]);

  // Recalculate on resize
  useEffect(() => {
    calculateFontSizes();

    const handleResize = () => {
      // Reset font sizes first so we can measure fresh
      setLine1FontSize(null);
      setLine2FontSize(null);

      requestAnimationFrame(() => {
        requestAnimationFrame(calculateFontSizes);
      });
    };

    window.addEventListener("resize", handleResize);

    let resizeObserver;
    if (typeof ResizeObserver !== "undefined" && containerRef.current) {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [calculateFontSizes]);

  // Recalculate when hero data loads
  useEffect(() => {
    if (heroData) {
      requestAnimationFrame(() => {
        requestAnimationFrame(calculateFontSizes);
      });
    }
  }, [heroData, calculateFontSizes]);

  // Get font size style or fall back to Tailwind classes
  const getLine1Style = () => {
    if (line1FontSize !== null) {
      return { fontSize: `${line1FontSize}px`, textAlign: "center" };
    }
    return {};
  };

  const getLine2Style = () => {
    if (line2FontSize !== null) {
      return { fontSize: `${line2FontSize}px`, textAlign: "center" };
    }
    return {};
  };

  return (
    <header id="top" className="py-16 flex justify-center">
      <section className="mx-auto max-w-4xl px-6 text-center w-full">
        {/* Tagline Badge */}
        <div className="h-[30px] sm:h-[36px] flex justify-center items-center">
          {tagline && (
            <div className="inline-flex items-center rounded-full border border-slate-700/80 bg-slate-900/70 px-4 sm:px-5 py-1.5 sm:py-2 shadow-[0_0_10px_rgba(0,255,255,0.6),0_0_20px_rgba(0,255,255,0.4)]">
              <span className="text-[11px] sm:text-sm font-medium text-slate-200">
                {renderWithGlow110(tagline)}
              </span>
            </div>
          )}
        </div>

        {/* Main Heading - Never Wraps */}
        <div className="mt-8 w-full" ref={containerRef}>
          <h1 className="font-extrabold leading-tight tracking-tight text-center">
            {headingLine1 && (
              <span
                ref={line1Ref}
                className="block w-full whitespace-nowrap text-center text-3xl sm:text-5xl lg:text-6xl"
                style={getLine1Style()}
              >
                {renderHeadingLine1(headingLine1)}
              </span>
            )}

            {headingLine2 && (
              <span
                ref={line2Ref}
                className={`block w-full whitespace-nowrap text-center text-3xl sm:text-5xl lg:text-6xl ${headingLine2BaseClass}`}
                style={getLine2Style()}
              >
                {renderWithGlow110(headingLine2)}
              </span>
            )}
          </h1>
        </div>

        {/* Description */}
        <div className="min-h-[48px] sm:min-h-[60px]">
          {description && (
            <p className="mt-4 text-sm sm:text-base md:text-lg text-slate-200/90 leading-relaxed max-w-2xl mx-auto">
              {renderWithGlow110(description)}
            </p>
          )}
        </div>

        {/* Subtext */}
        <div className="min-h-[32px] sm:min-h-[36px]">
          {subtext && (
            <p className="mt-6 text-[14px] sm:text-lg font-semibold text-cyan-300">
              {renderWithGlow110(subtext)}
            </p>
          )}
        </div>

        {/* CTA Buttons */}
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

        {/* CTA Note */}
        {ctaNote && (
          <p className="mt-5 text-sm sm:text-base font-extrabold tracking-wide relative inline-flex items-center gap-2">
            {ctaNoteIcon && (
              <span className="text-slate-100" aria-hidden="true">
                {ctaNoteIcon}
              </span>
            )}
            <span className="gold-flair-text">{ctaNote}</span>
          </p>
        )}

        {/* Bullet Points */}
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

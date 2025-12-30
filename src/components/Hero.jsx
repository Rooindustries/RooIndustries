import React, { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { client } from "../sanityClient";

export default function Hero() {
  const [heroData, setHeroData] = useState(null);
  const containerRef = useRef(null);
  const measure1Ref = useRef(null);
  const measure2Ref = useRef(null);
  const [line1FontSize, setLine1FontSize] = useState(null);
  const [line2FontSize, setLine2FontSize] = useState(null);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  const getBaseFontSize = useCallback(() => {
    if (typeof window === "undefined") return 48;
    const width = window.innerWidth;
    if (width >= 1024) return 60;
    if (width >= 640) return 48;
    return 30;
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
  const secondaryCtaText = heroData?.ctaSecondaryText || "See how it works";
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

  const calculateFontSizes = useCallback(() => {
    const container = containerRef.current;
    const measure1 = measure1Ref.current;
    const measure2 = measure2Ref.current;

    if (
      !container ||
      !measure1 ||
      !measure2 ||
      !headingLine1 ||
      !headingLine2
    ) {
      return;
    }

    const containerWidth = container.clientWidth;
    const padding = 16;
    const maxWidth = containerWidth - padding;
    const baseFontSize = getBaseFontSize();

    measure1.style.fontSize = `${baseFontSize}px`;
    measure2.style.fontSize = `${baseFontSize}px`;

    const width1AtBase = measure1.getBoundingClientRect().width;
    const width2AtBase = measure2.getBoundingClientRect().width;

    const longerWidth = Math.max(width1AtBase, width2AtBase);
    const targetWidth = Math.min(longerWidth, maxWidth);

    let size1 = baseFontSize * (targetWidth / width1AtBase);
    let size2 = baseFontSize * (targetWidth / width2AtBase);

    measure1.style.fontSize = `${size1}px`;
    measure2.style.fontSize = `${size2}px`;

    const width1After = measure1.getBoundingClientRect().width;
    const width2After = measure2.getBoundingClientRect().width;

    if (Math.abs(width1After - width2After) > 0.5) {
      const actualMax = Math.max(width1After, width2After);
      const finalTarget = Math.min(actualMax, maxWidth);

      size1 = size1 * (finalTarget / width1After);
      size2 = size2 * (finalTarget / width2After);

      measure1.style.fontSize = `${size1}px`;
      measure2.style.fontSize = `${size2}px`;

      const width1Final = measure1.getBoundingClientRect().width;
      const width2Final = measure2.getBoundingClientRect().width;

      const finalMax2 = Math.max(width1Final, width2Final);
      size1 = size1 * (finalMax2 / width1Final);
      size2 = size2 * (finalMax2 / width2Final);
    }

    const minSize = baseFontSize * 0.5;
    const maxSize = baseFontSize * 1.5;

    setLine1FontSize(Math.max(minSize, Math.min(maxSize, size1)));
    setLine2FontSize(Math.max(minSize, Math.min(maxSize, size2)));

    if (!initialLoadDone) {
      setInitialLoadDone(true);
    }
  }, [getBaseFontSize, headingLine1, headingLine2, initialLoadDone]);

  useEffect(() => {
    let resizeTimeout;

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        calculateFontSizes();
      }, 100);
    };

    window.addEventListener("resize", handleResize);

    let resizeObserver;
    if (typeof ResizeObserver !== "undefined" && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          calculateFontSizes();
        }, 100);
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(resizeTimeout);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [calculateFontSizes]);

  useEffect(() => {
    if (heroData && headingLine1 && headingLine2) {
      requestAnimationFrame(() => {
        calculateFontSizes();
      });
    }
  }, [heroData, headingLine1, headingLine2, calculateFontSizes]);

  const getLine1Style = () => {
    if (line1FontSize !== null) {
      return {
        fontSize: `${line1FontSize}px`,
        lineHeight: 1.1,
        opacity: 1,
      };
    }
    return {
      fontSize: `${getBaseFontSize()}px`,
      lineHeight: 1.1,
      opacity: 0,
    };
  };

  const getLine2Style = () => {
    if (line2FontSize !== null) {
      return {
        fontSize: `${line2FontSize}px`,
        lineHeight: 1.1,
        opacity: 1,
      };
    }
    return {
      fontSize: `${getBaseFontSize()}px`,
      lineHeight: 1.1,
      opacity: 0,
    };
  };

  return (
    <header id="top" className="py-16 flex justify-center">
      <section className="mx-auto max-w-4xl px-6 text-center w-full">
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            visibility: "hidden",
            height: 0,
            overflow: "hidden",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <span
            ref={measure1Ref}
            className="font-extrabold tracking-tight"
            style={{ lineHeight: 1.1 }}
          >
            {normalizeText(headingLine1)}
          </span>
          <span
            ref={measure2Ref}
            className="font-extrabold tracking-tight"
            style={{ lineHeight: 1.1 }}
          >
            {normalizeText(headingLine2)}
          </span>
        </div>

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

        {/* Main Heading - Both Lines Same Width */}
        <div className="mt-8 w-full" ref={containerRef}>
          <h1 className="font-extrabold tracking-tight text-center">
            {headingLine1 && (
              <span
                className="block w-full whitespace-nowrap text-center transition-opacity duration-150"
                style={getLine1Style()}
              >
                {renderHeadingLine1(headingLine1)}
              </span>
            )}

            {headingLine2 && (
              <span
                className={`block w-full whitespace-nowrap text-center transition-opacity duration-150 ${headingLine2BaseClass}`}
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
            to="/#how-it-works"
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

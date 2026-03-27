import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { publicClient } from "../sanityClient";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";

const fallbackHeroData = {
  tagline: "",
  headingLine1: "More FPS. Less Input Lag.",
  headingLine2: "Tuned for Your Exact Hardware.",
  description:
    "We optimize your BIOS, memory timings, Windows, and game configs remotely. You keep using your PC while we make it faster.",
  subtext: "Measurable gains. Competitive standard. No guesswork.",
  ctaPrimaryText: "Optimize My PC",
  ctaSecondaryText: "See How It Works",
  ctaNote: "Top 20 3DMark Hall of Fame · 150+ rigs optimized · Plans from $49.95",
  ctaNoteIcon: "🏆",
  bullets: [
    "20–92% FPS Boost",
    "10–76% Latency Reduction",
    "Up to Lifetime Warranty",
    "Same-Day Sessions Available",
  ],
};
const enableLiveHeroContent = true;

export default function Hero() {
  const [heroData, setHeroData] = useState(fallbackHeroData);
  const handleHomeSectionLink = useHomeSectionLinkHandler();

  useEffect(() => {
    if (!enableLiveHeroContent) return;

    publicClient
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
        if (!data || typeof data !== "object") return;
        setHeroData((prev) => ({
          ...prev,
          ...data,
        }));
      })
      .catch(() => {});
  }, []);

  const tagline = heroData?.tagline || fallbackHeroData.tagline;
  const headingLine1 =
    heroData?.headingData1 ||
    heroData?.headingLine1 ||
    fallbackHeroData.headingLine1;
  const headingLine2 = heroData?.headingLine2 || fallbackHeroData.headingLine2;
  const description = heroData?.description || fallbackHeroData.description;
  const subtext = heroData?.subtext || fallbackHeroData.subtext;
  const bullets = Array.isArray(heroData?.bullets)
    ? heroData.bullets.filter(Boolean)
    : fallbackHeroData.bullets;
  const primaryCtaText =
    heroData?.ctaPrimaryText || fallbackHeroData.ctaPrimaryText;
  const secondaryCtaText =
    heroData?.ctaSecondaryText || fallbackHeroData.ctaSecondaryText;
  const ctaNote = heroData?.ctaNote || fallbackHeroData.ctaNote;
  const ctaNoteIcon = heroData?.ctaNoteIcon || fallbackHeroData.ctaNoteIcon;

  const headingLine2BaseClass =
    "bg-gradient-to-r from-sky-400 to-blue-500 text-transparent bg-clip-text";

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
        <span className="text-cyan-200" style={{ textShadow: "0 0 10px rgba(34,211,238,0.95)" }}>
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
          <span className="bg-gradient-to-r from-sky-400 to-blue-500 text-transparent bg-clip-text">
            {renderWithGlow110(secondPart)}
          </span>
        </>
      );
    }

    return <span className="text-white">{renderWithGlow110(cleaned)}</span>;
  };

  const heroHeadingStyle = {
    fontSize: "clamp(1.75rem, 0.5rem + 5vw, 3.75rem)",
    lineHeight: 1.08,
  };

  const line1Ref = useRef(null);
  const line2Ref = useRef(null);

  useEffect(() => {
    const el1 = line1Ref.current;
    const el2 = line2Ref.current;
    if (!el1 || !el2 || !headingLine1 || !headingLine2) return;

    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;pointer-events:none";
    document.body.appendChild(probe);
    let rafId;

    const measureWidth = (text, fontSize, style) => {
      probe.style.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      probe.style.letterSpacing = style.letterSpacing;
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    };

    const adjust = () => {
      el2.style.fontSize = "clamp(1.75rem, 0.5rem + 5vw, 3.75rem)";

      const s = getComputedStyle(el2);
      const base = parseFloat(s.fontSize);
      const container = el2.parentElement?.parentElement;
      const avail = container
        ? container.getBoundingClientRect().width
        : window.innerWidth - 48;

      const text1 = normalizeText(headingLine1);
      const text2 = normalizeText(headingLine2);
      const nw1 = measureWidth(text1, base, s);
      const nw2 = measureWidth(text2, base, s);
      if (nw1 <= 0 || nw2 <= 0) return;

      const bothFit = nw1 <= avail && nw2 <= avail;
      const neitherFits = nw1 > avail && nw2 > avail;

      if (bothFit) {
        el1.style.fontSize = `${base * (nw2 / nw1)}px`;
      } else if (neitherFits) {
        el1.style.fontSize = `${base}px`;
      } else {
        const longer = Math.max(nw1, nw2);
        const shrunk = base * (avail / longer) * 0.97;
        const sNw1 = measureWidth(text1, shrunk, s);
        const sNw2 = measureWidth(text2, shrunk, s);
        const target = Math.min(sNw2, avail * 0.99);
        el1.style.fontSize = `${shrunk * (target / sNw1)}px`;
        el2.style.fontSize = `${shrunk}px`;
      }
    };

    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(adjust);
    };

    (document.fonts?.ready ?? Promise.resolve()).then(adjust);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(rafId);
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    };
  }, [headingLine1, headingLine2]);

  return (
    <header id="top" className="py-12 sm:py-14 flex justify-center">
      <section className="mx-auto max-w-4xl px-6 text-center w-full">
        <div className="w-full">
          <h1 className="font-extrabold tracking-tight text-center">
            {headingLine1 && (
              <span
                ref={line1Ref}
                className="block w-full text-center text-white"
                style={heroHeadingStyle}
              >
                {renderHeadingLine1(headingLine1)}
              </span>
            )}

            {headingLine2 && (
              <span
                ref={line2Ref}
                className={`block w-full text-center ${headingLine2BaseClass}`}
                style={heroHeadingStyle}
              >
                {renderWithGlow110(headingLine2)}
              </span>
            )}
          </h1>
        </div>

        <div className="min-h-[36px] sm:min-h-[60px]">
          {description && (
            <p className="mt-4 text-sm sm:text-base md:text-lg text-slate-200/90 leading-relaxed max-w-2xl mx-auto">
              {renderWithGlow110(description)}
            </p>
          )}
        </div>

        <div className="min-h-[24px] sm:min-h-[36px]">
          {subtext && (
            <p className="mt-4 sm:mt-6 text-[14px] sm:text-lg font-semibold text-cyan-300">
              {renderWithGlow110(subtext)}
            </p>
          )}
        </div>

        <div className="mt-5 sm:mt-7 flex items-center justify-center gap-3 sm:gap-4 flex-wrap min-h-[56px]">
          <Link
            to="/#packages"
            onClick={(event) => handleHomeSectionLink(event, "#packages")}
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
            onClick={(event) =>
              handleHomeSectionLink(event, "#how-it-works")
            }
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
          <p className="mt-3 sm:mt-5 text-sm sm:text-base font-extrabold tracking-wide relative inline-flex items-center gap-2">
            {ctaNoteIcon && (
              <span className="text-slate-100" aria-hidden="true">
                {ctaNoteIcon}
              </span>
            )}
            <span className="gold-flair-text">{ctaNote}</span>
          </p>
        )}

        <div className="mt-3 sm:mt-5 w-full">
          {bullets.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 sm:gap-y-2 sm:gap-x-6">
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

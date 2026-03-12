import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../sanityClient";

const fallbackHeroData = {
  tagline: "Roo Industries - Precision Performance Engineering",
  headingLine1: "Your PC Isn't Maxed Out.",
  headingLine2: "We Unlock Full Performance.",
  description:
    "Factory settings are generic - not dialed for your exact hardware and goals. That's why \"good PCs\" still suffer from frametime spikes, weak 1% lows, input lag, and a floaty mouse. We tune your BIOS, Windows, and game configs for consistent smoothness, faster responses and 1:1 input registration.",
  subtext: "Measurable gains. Competitive standard. No guesswork.",
  ctaPrimaryText: "Tune My Rig",
  ctaSecondaryText: "See How It Works",
  ctaNote: "Top 20 3DMark Hall of Fame - 150+ rigs optimized - Plans from $49.95",
  ctaNoteIcon: "🏆",
  bullets: [
    "Benchmark Verified Results",
    "150+ PCs Optimized",
    "Up to Lifetime Warranty",
    "Same-Day Service Available",
  ],
};
const enableLiveHeroContent = process.env.NEXT_PUBLIC_ENABLE_HERO_CMS === "1";

export default function Hero() {
  const [heroData, setHeroData] = useState(fallbackHeroData);

  useEffect(() => {
    if (!enableLiveHeroContent) return;

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

  const line1Ref = useRef(null);
  const line2Ref = useRef(null);

  const heroLine1Style = {
    fontSize: "var(--hero-line1-size)",
    lineHeight: 1.08,
  };
  const heroLine2Style = {
    fontSize: "var(--hero-line2-size)",
    lineHeight: 1.08,
  };

  useEffect(() => {
    const el1 = line1Ref.current;
    const el2 = line2Ref.current;
    if (!el1 || !el2 || !headingLine1 || !headingLine2) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let rafId;

    const adjust = () => {
      const s = getComputedStyle(el2);
      const base = parseFloat(s.fontSize);
      ctx.font = `${s.fontWeight} ${base}px ${s.fontFamily}`;
      const w1 = ctx.measureText(normalizeText(headingLine1)).width;
      const w2 = ctx.measureText(normalizeText(headingLine2)).width;
      if (w1 > 0 && w2 > 0) {
        el1.style.fontSize = `${base * (w2 / w1)}px`;
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
    };
  }, [headingLine1, headingLine2]);

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

        {/* Main Heading */}
        <div className="mt-8 w-full">
          <h1 className="font-extrabold tracking-tight text-center">
            {headingLine1 && (
              <span
                ref={line1Ref}
                className="block w-full text-center text-white"
                style={heroLine1Style}
              >
                {renderHeadingLine1(headingLine1)}
              </span>
            )}

            {headingLine2 && (
              <span
                ref={line2Ref}
                className={`block w-full text-center ${headingLine2BaseClass}`}
                style={heroLine2Style}
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

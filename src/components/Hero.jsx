import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { client } from "../sanityClient";

export default function Hero() {
  const [heroData, setHeroData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "hero"][0]{
          tagline,
          headingLine1,
          headingLine2,
          description,
          subtext,
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

  const headingLine2Node = useMemo(() => {
    if (!headingLine2) return null;

    return (
      <span className="block bg-gradient-to-r from-sky-400 to-blue-500 text-transparent bg-clip-text drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]">
        {renderWithGlow110(headingLine2)}
      </span>
    );
  }, [headingLine2]);

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
          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight text-center">
            {headingLine1 && (
              <span className="block">{renderHeadingLine1(headingLine1)}</span>
            )}
            {headingLine2Node}
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
            className="glow-button relative inline-flex items-center justify-center gap-2 rounded-md px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-cyan-300 ring-1 ring-cyan-500/60 hover:text-cyan-100 active:translate-y-px transition-all duration-300"
            style={{
              background: "#0a1d3d",
              backgroundImage: "none",
              boxShadow:
                "0 0 26px rgba(56,189,248,0.30), 0 0 38px rgba(56,189,248,0.18)",
              animation: "none",
            }}
          >
            Book Optimization
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>

          <Link
            to="/benchmarks"
            className="glow-button inline-flex items-center justify-center gap-2 rounded-md px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white ring-1 ring-sky-700/50 active:translate-y-px transition-all duration-300"
          >
            See FPS Boosts
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </div>

        <div className="mt-8 w-full">
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

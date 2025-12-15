import React, { useEffect, useState } from "react";
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
  const headingLine1 = heroData?.headingLine1;
  const headingLine2 = heroData?.headingLine2;
  const description = heroData?.description;
  const subtext = heroData?.subtext;
  const bullets = heroData?.bullets || [];

  return (
    <header id="top" className="py-16 flex justify-center">
      <section className="mx-auto max-w-3xl px-6 text-center">
        <div className="h-[30px] sm:h-[36px] flex justify-center items-center">
          {tagline && (
            <div
              className="inline-flex items-center rounded-full border border-slate-700/80 
                          bg-slate-900/70 px-4 sm:px-5 py-1.5 sm:py-2
                          shadow-[0_0_10px_rgba(0,255,255,0.6),0_0_20px_rgba(0,255,255,0.4)]"
            >
              <span className="text-[11px] sm:text-sm font-medium text-slate-200">
                {tagline}
              </span>
            </div>
          )}
        </div>

        <div className="mt-8 min-h-[120px] sm:min-h-[160px] flex flex-col justify-start">
          {headingLine1 && (
            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight">
              {headingLine1}
            </h1>
          )}
          {headingLine2 && (
            <div
              className="mt-1 text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight 
                          bg-gradient-to-r from-sky-400 to-blue-500 text-transparent 
                          bg-clip-text drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]"
            >
              {headingLine2}
            </div>
          )}
        </div>

        <div className="min-h-[48px] sm:min-h-[60px]">
          {description && (
            <p className="mt-4 text-sm sm:text-base md:text-lg text-slate-200/90 leading-relaxed">
              {description}
            </p>
          )}
        </div>

        <div className="min-h-[32px] sm:min-h-[36px]">
          {subtext && (
            <p className="mt-6 text-[14px] sm:text-lg font-semibold text-cyan-300">
              {subtext}
            </p>
          )}
        </div>

        <div className="mt-7 flex items-center justify-center gap-3 sm:gap-4 flex-wrap min-h-[56px]">
          <Link
            to="/packages"
            className="glow-button inline-flex items-center justify-center gap-2 rounded-md 
                        px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                        ring-1 ring-sky-700/50 active:translate-y-px transition-all duration-300"
          >
            <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-white drop-shadow-[0_0_6px_rgba(56,189,248,0.8)]" />
            Supercharge Your Performance Now
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>

          <Link
            to="/benchmarks"
            className="glow-button inline-flex items-center justify-center gap-2 rounded-md 
                        px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                        ring-1 ring-sky-700/50 active:translate-y-px transition-all duration-300"
          >
            View Results
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </div>

        {/* UPDATED BULLET SECTION: Tighter spacing to keep them on one line */}
        <div className="mt-8 w-full">
          {bullets.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 sm:gap-x-6">
              {bullets.map((text, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-400 shrink-0" />
                  <span className="text-s sm:text-s font-medium text-slate-200 whitespace-nowrap">
                    {text}
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

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

  return (
    <header
      id="top"
      className="pt-28 min-h-[70vh] flex items-start justify-center"
    >
      <section className="mx-auto max-w-3xl px-6 text-center">
        {/* Tagline placeholder to prevent layout jump */}
        <div className="h-[30px] sm:h-[36px] flex justify-center items-center">
          {heroData?.tagline && (
            <div
              className="inline-flex items-center rounded-full border border-slate-700/80 
                       bg-slate-900/70 px-4 sm:px-5 py-1.5 sm:py-2
                       shadow-[0_0_10px_rgba(0,255,255,0.6),0_0_20px_rgba(0,255,255,0.4)]"
            >
              <span className="text-[11px] sm:text-sm font-medium text-slate-200">
                {heroData.tagline}
              </span>
            </div>
          )}
        </div>

        {/* Headings */}
        <div className="mt-8 min-h-[120px] sm:min-h-[160px] flex flex-col justify-start">
          {heroData?.headingLine1 && (
            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight">
              {heroData.headingLine1}
            </h1>
          )}

          {heroData?.headingLine2 && (
            <div
              className="mt-1 text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-tight 
                       bg-gradient-to-r from-sky-400 to-blue-500 text-transparent 
                       bg-clip-text drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]"
            >
              {heroData.headingLine2}
            </div>
          )}
        </div>

        {/* Description placeholder */}
        <div className="min-h-[40px] sm:min-h-[45px]">
          {heroData?.description && (
            <p className="mt-4 text-xs sm:text-sm text-slate-300/80 leading-relaxed">
              {heroData.description}
            </p>
          )}
        </div>

        {/* Subtext placeholder */}
        <div className="min-h-[32px] sm:min-h-[36px]">
          {heroData?.subtext && (
            <p className="mt-6 text-[13px] sm:text-base font-semibold text-cyan-300">
              {heroData.subtext}
            </p>
          )}
        </div>

        {/* Buttons */}
        <div className="mt-7 flex items-center justify-center gap-3 sm:gap-4 flex-wrap min-h-[56px]">
          <Link
            to="/packages"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-gradient-to-r from-sky-400 to-sky-600 
                       px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                       ring-1 ring-sky-700/50 hover:from-cyan-400 hover:to-sky-500 
                       hover:shadow-[0_0_20px_rgba(56,189,248,0.6)] 
                       active:translate-y-px transition-all duration-300"
          >
            <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-white drop-shadow-[0_0_6px_rgba(56,189,248,0.8)]" />
            Supercharge Your Performance Now
          </Link>

          <Link
            to="/faq"
            className="rounded-md bg-gradient-to-r from-sky-600 to-blue-700 
                       px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                       hover:from-sky-500 hover:to-blue-600 
                       hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] 
                       active:translate-y-px transition-all duration-300"
          >
            Got Questions? We Have Answers
          </Link>
        </div>

        {/* Bullets */}
        <div className="min-h-[40px]">
          {heroData?.bullets?.length > 0 && (
            <div className="mt-8 flex items-center justify-center gap-5 sm:gap-8 text-[12px] sm:text-sm font-medium text-slate-200 flex-wrap">
              {heroData.bullets.map((text, i) => (
                <div key={i} className="flex items-center gap-1.5 sm:gap-2">
                  <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-400"></span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="h-3" />
    </header>
  );
}

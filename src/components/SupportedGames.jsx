import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { client, urlFor } from "../sanityClient";

function GameCard({ game, index }) {
  const title = game?.title || "Game";
  const image = game?.coverImage;
  const width = 450;
  const height = 600;
  const imageUrl = image
    ? urlFor(image).width(width).height(height).fit("crop").url()
    : "";

  return (
    <figure
      className="game-card group relative overflow-hidden rounded-xl cursor-pointer"
      style={{
        animationDelay: `${index * 80}ms`,
      }}
    >
      {/* Card container */}
      <div className="relative h-full w-full rounded-xl overflow-hidden bg-slate-900/90 ring-1 ring-white/10 group-hover:ring-sky-500/40 transition-all duration-500">
        {/* Slightly wider portrait aspect ratio (3:4) */}
        <div className="aspect-[3/4] relative">
          {imageUrl ? (
            <>
              <img
                src={imageUrl}
                alt={title}
                width={width}
                height={height}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover transition-all duration-500 ease-out group-hover:scale-105"
                sizes="(min-width: 1280px) 14vw, (min-width: 1024px) 18vw, (min-width: 640px) 26vw, 40vw"
              />
              {/* Subtle overlay on hover */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

              {/* Bottom glow line on hover */}
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-sky-500 via-sky-400 to-sky-500 opacity-0 group-hover:opacity-100 transition-opacity duration-500 shadow-[0_0_15px_rgba(56,189,248,0.8)]" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-slate-800 via-slate-900 to-slate-950" />
          )}
        </div>
      </div>
    </figure>
  );
}

export default function SupportedGames() {
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "supportedGames"][0]{
          title,
          subtitle,
          showAllLabel,
          showLessLabel,
          featuredGames[]{
            _key,
            title,
            coverImage{
              ...,
              "dimensions": asset->metadata.dimensions
            }
          },
          moreGames[]{
            _key,
            title,
            coverImage{
              ...,
              "dimensions": asset->metadata.dimensions
            }
          }
        }`
      )
      .then(setData)
      .catch(console.error);
  }, []);

  const featuredGames = useMemo(() => {
    if (!Array.isArray(data?.featuredGames)) return [];
    return data.featuredGames.slice(0, 5);
  }, [data]);

  const moreGames = useMemo(() => {
    if (!Array.isArray(data?.moreGames)) return [];
    return data.moreGames;
  }, [data]);

  const hasMore = moreGames.length > 0;
  const buttonLabel = showAll
    ? data?.showLessLabel || "Show Less"
    : data?.showAllLabel || "View All Games";

  if (!data || (featuredGames.length === 0 && !hasMore)) return null;

  return (
    <>
      {/* Component styles */}
      <style>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .game-card {
          animation: fadeInUp 0.5s ease-out both;
        }
        
        .expand-section {
          transition: max-height 0.7s cubic-bezier(0.4, 0, 0.2, 1), 
                      opacity 0.5s ease-out,
                      margin-top 0.5s ease-out;
        }
      `}</style>

      <section
        id="supported-games"
        className="relative z-10 py-16 sm:py-20 px-4 sm:px-6 text-center text-white"
      >
        <div className="max-w-5xl mx-auto">
          {/* Header - matching Packages style */}
          <div className="text-center mb-10 sm:mb-12">
            {data.title && (
              <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
                {data.title}
              </h2>
            )}
            {data.subtitle && (
              <p className="mt-3 text-slate-300/80 text-sm sm:text-base">
                {data.subtitle}
              </p>
            )}
          </div>

          {/* Games grid */}
          {featuredGames.length > 0 && (
            <div className="rounded-2xl bg-gradient-to-b from-slate-900/50 to-slate-950/50 ring-1 ring-white/10 backdrop-blur-sm p-4 sm:p-5 shadow-[0_0_30px_rgba(0,0,0,0.3)]">
              {/* Featured games grid - 5 columns on large screens */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                {featuredGames.map((game, index) => (
                  <GameCard
                    key={game?._key || index}
                    game={game}
                    index={index}
                  />
                ))}
              </div>

              {/* Expandable more games section */}
              {hasMore && (
                <div
                  id="supported-games-more"
                  className={
                    "expand-section overflow-hidden " +
                    (showAll
                      ? "max-h-[8000px] opacity-100 mt-4"
                      : "max-h-0 opacity-0 mt-0 pointer-events-none")
                  }
                  aria-hidden={!showAll}
                >
                  {/* Divider */}
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex-1 h-px bg-gradient-to-r from-transparent via-sky-500/30 to-transparent" />
                    <span className="text-xs font-medium text-slate-500 uppercase tracking-widest">
                      More Games
                    </span>
                    <div className="flex-1 h-px bg-gradient-to-r from-transparent via-sky-500/30 to-transparent" />
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                    {moreGames.map((game, index) => (
                      <GameCard
                        key={game?._key || index}
                        game={game}
                        index={index + featuredGames.length}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* CTA Button */}
          {hasMore && (
            <div className="mt-8 sm:mt-10 flex items-center justify-center">
              <button
                type="button"
                onClick={() => setShowAll((prev) => !prev)}
                aria-expanded={showAll}
                aria-controls="supported-games-more"
                className="glow-button relative inline-flex items-center justify-center gap-2 rounded-md px-5 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base font-semibold text-white ring-1 ring-sky-700/60 hover:text-white active:translate-y-px transition-all duration-300"
                style={{
                  background: "#0b63d1",
                  boxShadow:
                    "0 0 26px rgba(59,130,246,0.35), 0 0 38px rgba(59,130,246,0.2)",
                }}
              >
                {buttonLabel}
                <span
                  className={`transform transition-transform duration-400 ${
                    showAll ? "rotate-180" : "rotate-0"
                  }`}
                >
                  <ChevronDown className="h-4 w-4" />
                </span>
                <span className="glow-line glow-line-top" />
                <span className="glow-line glow-line-right" />
                <span className="glow-line glow-line-bottom" />
                <span className="glow-line glow-line-left" />
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

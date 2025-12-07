import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { client } from "../sanityClient";

const titleClass =
  "text-[48px] leading-tight font-extrabold text-center tracking-tight " +
  "text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]";

export default function StreamerYoutuberReviews() {
  const [entries, setEntries] = useState([]);

  const sectionClass =
    "py-24 px-4 sm:px-6 text-center text-white relative overflow-hidden";

  useEffect(() => {
    const query = `*[_type == "proReviewsCarousel"]{
      _id,
      slot,
      title,
      subtitle,
      glowEnabled,
      reviews[]{ name, profession, text }
    }`;
    let cancelled = false;

    const fetchData = async () => {
      const res = await client.fetch(query);
      if (cancelled) return;
      setEntries(Array.isArray(res) ? res : []);
    };

    fetchData();

    const subscription = client
      .listen(query, {}, { visibility: "query" })
      .subscribe((update) => {
        if (cancelled) return;
        const doc = Array.isArray(update.result)
          ? null
          : update.result?._type === "proReviewsCarousel"
          ? update.result
          : null;

        if (Array.isArray(update.result)) {
          setEntries(update.result);
        } else if (doc) {
          setEntries((prev) => {
            const filtered = prev.filter((item) => item._id !== doc._id);
            return [...filtered, doc];
          });
        }
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const normalizeReviews = (incoming) => {
    if (!incoming?.length) return [];
    return incoming;
  };

  const defaultTitle = "What professionals say about us";
  const defaultSubtitle = "Feedback from pros who rely on us.";

  const left = entries.find((item) => item.slot === "left");
  const right = entries.find((item) => item.slot === "right");

  const leftReviews = normalizeReviews(left?.reviews);
  const rightReviews = normalizeReviews(right?.reviews);

  return (
    <section className={sectionClass}>
      <div className="grid gap-6 md:grid-cols-2 max-w-6xl mx-auto px-4">
        <Carousel
          side="left"
          title={left?.title}
          subtitle={left?.subtitle}
          defaultTitle={defaultTitle}
          defaultSubtitle={defaultSubtitle}
          reviews={leftReviews}
          intervalMs={4000}
          transitionMs={1400}
          glowEnabled={left?.glowEnabled}
        />

        <Carousel
          side="right"
          title={right?.title}
          subtitle={right?.subtitle}
          defaultTitle={defaultTitle}
          defaultSubtitle={defaultSubtitle}
          reviews={rightReviews}
          intervalMs={4000}
          transitionMs={1400}
          glowEnabled={right?.glowEnabled}
        />
      </div>
    </section>
  );
}

function Carousel({
  side,
  title,
  subtitle,
  defaultTitle,
  defaultSubtitle,
  reviews,
  intervalMs,
  transitionMs,
  glowEnabled,
}) {
  const [index, setIndex] = useState(0);
  const containerRef = useRef(null);

  const handleNext = () => {
    if (!reviews?.length) return;
    setIndex((prev) => (prev + 1) % reviews.length);
  };

  const handlePrev = () => {
    if (!reviews?.length) return;
    setIndex((prev) => (prev - 1 + reviews.length) % reviews.length);
  };

  useEffect(() => {
    if (!reviews?.length || reviews.length < 2) return;
    const interval = setInterval(handleNext, intervalMs);
    return () => clearInterval(interval);
  }, [reviews, intervalMs]);

  const CornerSparkle = ({ className, delay }) => (
    <div className={`absolute z-30 pointer-events-none ${className}`}>
      <div
        className="absolute inset-0 bg-white blur-md opacity-80 rounded-full"
        style={{
          animation: `twinkle 6s linear infinite -${delay}s`,
          animationPlayState: "running",
        }}
      />
      <Sparkles
        size={32}
        className="text-cyan-100 sparkle-icon relative"
        style={{
          animationDelay: `-${delay}s`,
          animationPlayState: "running",
        }}
      />
    </div>
  );

  return (
    <div className="text-center text-white relative">
      <div className="w-full mx-auto px-4">
        {/* REMOVED 'truncate' CLASS BELOW */}
        <h3
          className={`${titleClass} mb-2 w-full`}
          title={title || defaultTitle}
        >
          {title || defaultTitle}
        </h3>
      </div>

      <p className="text-slate-300 mb-5 text-[14px]">
        {subtitle || defaultSubtitle}
      </p>

      {/* OUTER SHELL */}
      <div className="relative mx-auto max-w-[550px]">
        {glowEnabled && (
          <>
            {/* Moving glow border */}
            <div className="glow-box">
              <div className="glow-beam" />
            </div>

            {/* Sparkles layout based on side */}
            {side === "left" && (
              <>
                {/* top-left & bottom-right */}
                <CornerSparkle className="-top-2 -left-2" delay={0} />
                <CornerSparkle className="-bottom-2 -right-2" delay={1.5} />
              </>
            )}

            {side === "right" && (
              <>
                {/* bottom-left & top-right */}
                <CornerSparkle className="-bottom-2 -left-2" delay={0.5} />
                <CornerSparkle className="-top-2 -right-2" delay={2} />
              </>
            )}
          </>
        )}

        {/* INNER INTERACTIVE CONTAINER */}
        <div className="relative rounded-3xl h-full" ref={containerRef}>
          <div
            className="relative overflow-hidden rounded-3xl bg-[#0b1120]/90 
                       shadow-[0_0_20px_rgba(56,189,248,0.2)] 
                       border border-transparent"
          >
            <div
              className="flex"
              style={{
                transform: `translateX(-${index * 100}%)`,
                transition: `transform ${transitionMs}ms ease-in-out`,
              }}
            >
              {reviews.map((review, i) => (
                <div
                  key={i}
                  className="flex-shrink-0 w-full 
                             min-h-[200px] sm:min-h-[180px] md:min-h-[200px]
                             flex flex-col items-center 
                             bg-[#0b1120]/90 rounded-3xl 
                             px-6 py-8 relative"
                >
                  <h3 className="text-2xl font-semibold text-sky-300 mb-4 absolute top-6">
                    {review.name}
                  </h3>

                  {review.profession ? (
                    <p className="text-slate-400 text-xs absolute top-14">
                      {review.profession}
                    </p>
                  ) : null}

                  <div className="flex-grow flex items-center justify-center mt-8">
                    <p className="text-slate-100 text-base leading-relaxed max-w-sm">
                      {review.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={handlePrev}
              className="absolute left-3 top-1/2 -translate-y-1/2 
                         bg-slate-900/80 hover:bg-slate-800 
                         border border-sky-600/40 
                         p-2 rounded-full shadow-md 
                         transition z-10"
            >
              <ChevronLeft className="w-5 h-5 text-cyan-300" />
            </button>

            <button
              onClick={handleNext}
              className="absolute right-3 top-1/2 -translate-y-1/2 
                         bg-slate-900/80 hover:bg-slate-800 
                         border border-sky-600/40 
                         p-2 rounded-full shadow-md 
                         transition z-10"
            >
              <ChevronRight className="w-5 h-5 text-cyan-300" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

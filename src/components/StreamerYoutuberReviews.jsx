import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { client } from "../sanityClient";

const titleClass =
  "text-3xl sm:text-[40px] md:text-[48px] leading-tight font-extrabold text-center tracking-tight " +
  "text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]";

export default function StreamerYoutuberReviews() {
  const [entries, setEntries] = useState([]);
  const [maxCardHeight, setMaxCardHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 0
  );

  const sectionClass =
    "py-12 sm:py-16 px-4 sm:px-6 text-center text-white relative overflow-hidden";

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

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const reportHeight = useCallback((height) => {
    setMaxCardHeight((prev) => (height > prev ? height : prev));
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

  const lockHeight = true;

  return (
    <section className={sectionClass}>
      <div
        className="
          flex flex-col items-center gap-12
          md:grid md:grid-cols-2 md:gap-8 md:items-start
          w-full 
          max-w-6xl 
          mx-auto 
        "
      >
        <Carousel
          side="left"
          title={left?.title}
          subtitle={left?.subtitle}
          defaultTitle={defaultTitle}
          defaultSubtitle={defaultSubtitle}
          reviews={leftReviews}
          intervalMs={8000}
          transitionMs={1400}
          glowEnabled={left?.glowEnabled}
          onMeasureHeight={reportHeight}
          fixedHeight={lockHeight && maxCardHeight ? maxCardHeight : null}
          lockHeight={lockHeight}
        />

        <Carousel
          side="right"
          title={right?.title}
          subtitle={right?.subtitle}
          defaultTitle={defaultTitle}
          defaultSubtitle={defaultSubtitle}
          reviews={rightReviews}
          intervalMs={8000}
          transitionMs={1400}
          glowEnabled={right?.glowEnabled}
          onMeasureHeight={reportHeight}
          fixedHeight={lockHeight && maxCardHeight ? maxCardHeight : null}
          lockHeight={lockHeight}
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
  onMeasureHeight,
  fixedHeight,
  lockHeight,
}) {
  const slideCount = Array.isArray(reviews) ? reviews.length : 0;
  const hasMultipleSlides = slideCount > 1;
  const extendedReviews =
    hasMultipleSlides && reviews
      ? [reviews[slideCount - 1], ...reviews, reviews[0]]
      : reviews || [];
  const totalSlides = extendedReviews.length;

  const [index, setIndex] = useState(hasMultipleSlides ? 1 : 0);
  const [isAnimating, setIsAnimating] = useState(hasMultipleSlides);
  const isTransitioningRef = useRef(false);
  const [localHeight, setLocalHeight] = useState(0);
  const containerRef = useRef(null);
  const cardRefs = useRef([]);

  const heightToUse = lockHeight ? fixedHeight || localHeight : undefined;

  const measureHeights = useCallback(() => {
    if (!lockHeight) return;

    const heights =
      cardRefs.current
        ?.map((card) => card?.offsetHeight || 0)
        ?.filter(Boolean) || [];

    if (!heights.length) return;

    const tallest = Math.max(...heights);
    setLocalHeight((prev) => (prev === tallest ? prev : tallest));
    onMeasureHeight?.(tallest);
  }, [onMeasureHeight, lockHeight]);

  const handleNext = useCallback(() => {
    if (!hasMultipleSlides || isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    setIsAnimating(true);
    setIndex((prev) => prev + 1);
  }, [hasMultipleSlides]);

  const handlePrev = useCallback(() => {
    if (!hasMultipleSlides || isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    setIsAnimating(true);
    setIndex((prev) => prev - 1);
  }, [hasMultipleSlides]);

  useEffect(() => {
    if (!hasMultipleSlides) return;
    const interval = setInterval(() => {
      if (!isTransitioningRef.current) {
        handleNext();
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [hasMultipleSlides, handleNext, intervalMs]);

  useEffect(() => {
    setIndex(hasMultipleSlides ? 1 : 0);
    setIsAnimating(hasMultipleSlides);
    isTransitioningRef.current = false;
  }, [hasMultipleSlides, slideCount]);

  useEffect(() => {
    measureHeights();
    if (!lockHeight) return;
    const onResize = () => measureHeights();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureHeights, extendedReviews, lockHeight]);

  useEffect(() => {
    if (isAnimating) return;
    const id = requestAnimationFrame(() => setIsAnimating(true));
    return () => cancelAnimationFrame(id);
  }, [isAnimating]);

  const handleTransitionEnd = () => {
    if (!hasMultipleSlides) return;

    if (index === 0) {
      setIsAnimating(false);
      setIndex(totalSlides - 2);
      isTransitioningRef.current = false;
      return;
    }

    if (index === totalSlides - 1) {
      setIsAnimating(false);
      setIndex(1);
      isTransitioningRef.current = false;
      return;
    }

    setIsAnimating(false);
    isTransitioningRef.current = false;
  };

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
    <div className="text-center text-white relative w-full flex flex-col items-center">
      <div className="w-full mx-auto px-2">
        <h3
          className={`${titleClass} mb-3 w-full`}
          title={title || defaultTitle}
        >
          {title || defaultTitle}
        </h3>
      </div>

      <p className="text-slate-300 mb-6 text-sm sm:text-[14px]">
        {subtitle || defaultSubtitle}
      </p>

      <div className="relative w-[90vw] max-w-md md:w-full md:max-w-[550px] mx-auto">
        {glowEnabled && (
          <>
            <div className="glow-box">
              <div className="glow-beam" />
            </div>

            {side === "left" && (
              <>
                <CornerSparkle className="-top-2 -left-2" delay={0} />
                <CornerSparkle className="-bottom-2 -right-2" delay={1.5} />
              </>
            )}

            {side === "right" && (
              <>
                <CornerSparkle className="-bottom-2 -left-2" delay={0.5} />
                <CornerSparkle className="-top-2 -right-2" delay={2} />
              </>
            )}
          </>
        )}

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
                transition: isAnimating
                  ? `transform ${transitionMs}ms ease-in-out`
                  : "none",
              }}
              onTransitionEnd={handleTransitionEnd}
            >
              {extendedReviews.map((review, i) => (
                <div
                  key={`review-${i}-${review?.name || "item"}`}
                  ref={(el) => {
                    cardRefs.current[i] = el;
                  }}
                  className="flex-shrink-0 w-full"
                  style={
                    heightToUse
                      ? {
                          minHeight: `${heightToUse}px`,
                        }
                      : undefined
                  }
                >
                  <div
                    className="flex h-full flex-col rounded-3xl 
                               bg-[#0b1120]/90 px-5 py-7 text-center gap-4
                               sm:px-7 sm:py-8 md:grid md:grid-rows-[auto,1fr] md:gap-1"
                  >
                    <div className="flex flex-col items-center justify-start gap-3">
                      <h3 className="text-2xl font-semibold text-sky-300 leading-snug">
                        {review.name}
                      </h3>

                      {review.profession ? (
                        <p className="text-slate-400 text-sm leading-tight">
                          {review.profession}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-1 items-center justify-center">
                      <p className="text-slate-100 text-base sm:text-lg leading-relaxed max-w-sm">
                        {review.text}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={handlePrev}
              className="absolute left-3 bottom-3 md:bottom-auto md:top-1/2 md:-translate-y-1/2 
                           bg-slate-900/80 hover:bg-slate-800 
                           border border-sky-600/40 
                           p-2 rounded-full shadow-md 
                           transition z-10"
            >
              <ChevronLeft className="w-5 h-5 text-cyan-300" />
            </button>

            <button
              onClick={handleNext}
              className="absolute right-3 bottom-3 md:bottom-auto md:top-1/2 md:-translate-y-1/2 
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

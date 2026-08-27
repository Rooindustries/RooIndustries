import React, { useEffect, useRef, useState } from "react";
import { urlFor } from "../sanityClient";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
  readHomeSectionData,
} from "../lib/homeSectionData";

const titleClass =
  "text-[28px] sm:text-[32px] md:text-[36px] leading-tight font-extrabold text-center tracking-tight " +
  "text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]";
const AUTO_SCROLL_PIXELS_PER_SECOND = 20;

const getReviewAvatarUrl = (pfp) => {
  const optimized = urlFor(pfp)
    .width(112)
    .height(112)
    .fit("crop")
    .format("webp")
    .quality(55)
    .url();

  return `${optimized}${optimized.includes("?") ? "&" : "?"}frame=1`;
};

export default function StreamerYoutuberReviews({ initialData = null }) {
  const [data, setData] = useState(() => initialData);
  const [shouldLoad, setShouldLoad] = useState(() => Boolean(initialData));
  const sectionRef = useRef(null);

  useEffect(() => {
    if (initialData !== null) {
      setData(initialData);
      setShouldLoad(true);
      return;
    }

    if (readHomeSectionData(HOME_SECTION_DATA_KEYS.reviews) !== null) {
      setShouldLoad(true);
    }
  }, [initialData]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !sectionRef.current) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "180px 0px" }
    );

    observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad || data) return;

    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetchHomeSectionData(HOME_SECTION_DATA_KEYS.reviews);
        if (!cancelled) setData(res);
      } catch (error) {
        console.error("Could not fetch reviews:", error);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [data, shouldLoad]);

  const defaultTitle = "Results Players Felt";
  const defaultSubtitle =
    "The FPS graph matters. The real test is whether ranked feels cleaner after the tune.";
  const reviews = data?.reviews || [];
  const isLoading = shouldLoad && !data;

  return (
    <section
      ref={sectionRef}
      className="pt-4 sm:pt-5 pb-4 text-center text-ink relative overflow-hidden"
    >
      <div className="px-4 sm:px-6 mb-3">
        <h2 className={`ri-reviews-heading ${titleClass} mb-2`}>
          {data?.title || defaultTitle}
        </h2>
        <p className="text-ink-secondary text-sm sm:text-base">
          {data?.subtitle || defaultSubtitle}
        </p>
      </div>

      {isLoading ? (
        <div className="px-4 flex gap-4 overflow-hidden">
          <div className="w-[320px] sm:w-[360px] h-[184px] rounded-xl bg-skeleton animate-pulse flex-shrink-0" />
          <div className="w-[320px] sm:w-[360px] h-[184px] rounded-xl bg-skeleton animate-pulse flex-shrink-0" />
          <div className="hidden lg:block w-[360px] h-[184px] rounded-xl bg-skeleton animate-pulse flex-shrink-0" />
        </div>
      ) : (
        <AutoReviewCarousel reviews={reviews} />
      )}
    </section>
  );
}

function ReviewerAvatar({ review, isCreator }) {
  if (review.pfp) {
    return (
      <img
        src={getReviewAvatarUrl(review.pfp)}
        alt={review.name}
        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
        style={{
          boxShadow: isCreator ? "0 0 0 2px var(--color-accent)" : "none",
        }}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    );
  }

  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black flex-shrink-0 bg-surface-hover"
      style={{ color: "var(--color-accent)" }}
      aria-hidden="true"
    >
      {review.name?.charAt(0)?.toUpperCase() || "?"}
    </div>
  );
}

function parseFpsResult(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(.*?):?\s*(\d[\d,.]*)\s*(?:→|->|to)\s*(\d[\d,.]*)$/i);
  if (!match) return null;
  return {
    label: match[1].replace(/:$/, "").trim() || "Average FPS",
    before: match[2],
    after: match[3],
  };
}

function ReviewCard({ review }) {
  const isCreator = Boolean(review.isVip);
  const result = parseFpsResult(review.optimizationResult);

  return (
    <article
      className={`ri-review-card ${
        isCreator ? "ri-review-card-creator" : "ri-review-card-standard"
      } flex flex-col w-[320px] sm:w-[360px] min-h-[184px] p-3 rounded-xl text-left flex-shrink-0`}
      style={{
        background: isCreator
          ? "linear-gradient(145deg, rgba(212, 175, 55, 0.12), var(--color-surface-solid) 52%)"
          : "var(--color-surface-solid)",
        boxShadow: isCreator
          ? "inset 0 0 0 1px rgba(212, 175, 55, 0.58), 0 16px 40px rgba(0, 0, 0, 0.25)"
          : "inset 0 0 0 1px var(--color-border-soft), 0 16px 40px rgba(0, 0, 0, 0.18)",
      }}
    >
      <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-[0.14em]">
        <p style={{ color: isCreator ? "var(--color-accent)" : "#ffffff" }}>
          {isCreator ? "Creator review" : "Player review"}
        </p>
        <p className="text-white">{review.game || "PC performance"}</p>
      </div>

      <div className={`mt-1 flex items-end gap-3 ${result ? "justify-between" : "justify-end"}`}>
        {result && (
          <p className="font-black leading-none tracking-[-0.04em] tabular-nums whitespace-nowrap">
            <span className="mr-2 text-[10px] uppercase tracking-[0.12em] text-white">
              {result.label}
            </span>
          {result.before && (
              <span className="text-lg text-white">{result.before}</span>
          )}
            {result.before && (
              <span
                className="mx-1.5 text-base"
                style={{ color: "var(--color-accent-strong)" }}
              >
                →
              </span>
            )}
            <span
              className="text-[28px]"
              style={{ color: isCreator ? "var(--color-accent)" : "var(--color-text-primary)" }}
            >
              {result.after}
            </span>
          </p>
        )}
        <p
          className="text-xs font-bold tracking-[0.08em] flex-shrink-0"
          style={{ color: isCreator ? "var(--color-accent)" : "#ffffff" }}
          aria-label={`${review.rating || 5} out of 5 stars`}
        >
          ★★★★★
        </p>
      </div>

      <blockquote className="mt-2 flex-1">
        <p className="text-white text-[11px] sm:text-[12px] leading-[1.35] break-words whitespace-normal">
          “{review.text}”
        </p>
      </blockquote>

      <footer className="mt-2 flex items-center gap-2">
        <ReviewerAvatar review={review} isCreator={isCreator} />
        <div className="min-w-0">
          <p
            className="font-extrabold text-[13px] leading-tight text-ink truncate"
            style={{ color: isCreator ? "var(--color-accent)" : undefined }}
          >
            {review.name}
          </p>
          {review.profession && (
            <p className="mt-0.5 text-[9px] leading-snug text-white">
              {review.profession}
            </p>
          )}
        </div>
      </footer>
    </article>
  );
}

function AutoReviewCarousel({ reviews }) {
  const viewportRef = useRef(null);
  const firstGroupRef = useRef(null);
  const pauseUntilRef = useRef(0);
  const dragRef = useRef(null);

  useEffect(() => {
    let previousTime = performance.now();

    const tick = () => {
      const time = performance.now();
      const viewport = viewportRef.current;
      const firstGroup = firstGroupRef.current;
      if (viewport && firstGroup) {
        const elapsed = Math.min(time - previousTime, 1000);
        previousTime = time;
        const loopWidth = firstGroup.scrollWidth;
        if (time >= pauseUntilRef.current && loopWidth > 0) {
          viewport.scrollLeft +=
            (AUTO_SCROLL_PIXELS_PER_SECOND * elapsed) / 1000;
          if (viewport.scrollLeft >= loopWidth) {
            viewport.scrollLeft -= loopWidth;
          }
        }
      }
    };

    const intervalId = window.setInterval(tick, 50);
    return () => window.clearInterval(intervalId);
  }, [reviews.length]);

  if (!reviews.length) return null;

  const orderedReviews = [
    ...reviews.filter((review) => review.isVip),
    ...reviews.filter((review) => !review.isVip),
  ];

  const pauseAutoScroll = (milliseconds = 2400) => {
    pauseUntilRef.current = performance.now() + milliseconds;
  };

  const scrollReviews = (direction) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    pauseAutoScroll();
    viewport.scrollBy({
      left: direction * Math.min(376, viewport.clientWidth * 0.8),
      behavior: "auto",
    });
  };

  const onPointerDown = (event) => {
    if (event.pointerType !== "mouse" || !viewportRef.current) return;
    pauseAutoScroll(10000);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: viewportRef.current.scrollLeft,
    };
    viewportRef.current.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !viewportRef.current) return;
    viewportRef.current.scrollLeft =
      drag.startScrollLeft - (event.clientX - drag.startX);
  };

  const onPointerUp = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    pauseAutoScroll();
    viewportRef.current?.releasePointerCapture(event.pointerId);
  };

  return (
    <div className="relative">
      <div
        ref={viewportRef}
        className="ri-reviews-viewport w-full overflow-x-auto overflow-y-hidden cursor-grab active:cursor-grabbing select-none"
        role="region"
        aria-label="Player reviews"
        onWheel={() => pauseAutoScroll()}
        onTouchStart={() => pauseAutoScroll(10000)}
        onTouchEnd={() => pauseAutoScroll()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="ri-reviews-auto-track flex w-max items-stretch">
        {[0, 1].map((groupIndex) => (
          <div
            key={groupIndex}
            ref={groupIndex === 0 ? firstGroupRef : undefined}
            className="flex items-stretch gap-4 pr-4"
            aria-hidden={groupIndex === 1 ? "true" : undefined}
          >
            {orderedReviews.map((review, reviewIndex) => (
              <ReviewCard
                key={`${review._id || review.name || "review"}-${reviewIndex}`}
                review={review}
              />
            ))}
          </div>
        ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => scrollReviews(-1)}
        className="absolute left-1 sm:left-3 top-1/2 -translate-y-1/2 z-10 w-9 h-12 text-2xl leading-none text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        aria-label="Scroll reviews left"
      >
        ←
      </button>
      <button
        type="button"
        onClick={() => scrollReviews(1)}
        className="absolute right-1 sm:right-3 top-1/2 -translate-y-1/2 z-10 w-9 h-12 text-2xl leading-none text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        aria-label="Scroll reviews right"
      >
        →
      </button>
    </div>
  );
}

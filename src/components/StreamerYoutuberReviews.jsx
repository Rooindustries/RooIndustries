import React, { useEffect, useRef, useState } from "react";
import { urlFor } from "../lib/cmsImageUrl";
import { getPerfToggleEnabled, isPerfDebugEnabled, PERF_DEBUG_EVENT, PERF_TOGGLE_KEYS } from "../lib/perfDebug";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
  readHomeSectionData,
} from "../lib/homeSectionData";

const titleClass =
  "text-[28px] sm:text-[32px] md:text-[36px] leading-tight font-extrabold text-center tracking-tight " +
  "text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]";
const AUTO_SCROLL_PIXELS_PER_SECOND = 24;
const AUTO_SCROLL_RESUME_DELAY_MS = 1500;
const AUTO_SCROLL_RAMP_MS = 900;
const WHEEL_ACTIVE_MS = 150;
const ARROW_SCROLL_MS = 450;
const MAX_FRAME_MS = 100;
const REVIEW_CARD_GAP = 16;
const MIN_REVIEW_GROUPS = 3;

const getReviewKey = (review) => review._id || review.name || "review";
const easeInOut = (progress) =>
  progress < 0.5 ? 2 * progress * progress : 1 - (2 - 2 * progress) ** 2 / 2;
const easeOut = (progress) => 1 - (1 - progress) ** 3;

const readReviewScroll = (viewport, motion) => {
  if (Math.abs(viewport.scrollLeft - motion.written) >= 1) {
    motion.position = viewport.scrollLeft;
  }
  return motion.position;
};

const commitReviewScroll = (viewport, motion, position) => {
  const { groupWidth } = motion;
  const shift = groupWidth > 0 ? -Math.floor((position - groupWidth) / groupWidth) * groupWidth : 0;
  if (shift) {
    if (motion.drag) motion.drag.startScrollLeft += shift;
    if (motion.arrow) {
      motion.arrow.from += shift;
      motion.arrow.to += shift;
    }
  }
  motion.position = position + shift;
  viewport.scrollLeft = motion.position;
  motion.written = viewport.scrollLeft;
};

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
          boxShadow: isCreator ? "0 0 0 2px #f5c954" : "none",
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

function ReviewCard({ review, groupIndex }) {
  const isCreator = Boolean(review.isVip);
  const result = parseFpsResult(review.optimizationResult);
  const rating = Math.max(1, Math.min(5, Math.round(Number(review.rating) || 5)));

  return (
    <article
      data-review-id={getReviewKey(review)}
      data-group-index={groupIndex}
      className={`ri-review-card ${
        isCreator ? "ri-review-card-creator" : "ri-review-card-standard"
      } flex flex-col w-[320px] sm:w-[360px] min-h-[184px] p-3 rounded-xl text-left flex-shrink-0`}
      style={{
        background: isCreator
          ? "linear-gradient(145deg, rgba(250, 219, 120, 0.12), var(--color-surface-solid) 52%)"
          : "var(--color-surface-solid)",
        boxShadow: isCreator
          ? "inset 0 0 0 1px rgba(245, 201, 84, 0.58), 0 16px 40px rgba(0, 0, 0, 0.25)"
          : "inset 0 0 0 1px var(--color-border-soft), 0 16px 40px rgba(0, 0, 0, 0.18)",
      }}
    >
      <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-[0.14em]">
        <p className={isCreator ? "ri-review-champagne-text" : "text-white"}>
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
                style={{ color: "#f5c954" }}
              >
                →
              </span>
            )}
            <span
              className="ri-review-champagne-text text-[28px]"
            >
              {result.after}
            </span>
          </p>
        )}
        <p
          className="ri-review-champagne-text text-xs font-bold tracking-[0.08em] flex-shrink-0"
          aria-label={`${rating} out of 5 stars`}
        >
          <span aria-hidden="true">{"★".repeat(rating)}{"☆".repeat(5 - rating)}</span>
          <span className="sr-only">{rating} out of 5 stars</span>
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
            className={`font-extrabold text-[13px] leading-tight text-ink truncate ${
              isCreator ? "ri-review-champagne-text" : ""
            }`}
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
  const motionRef = useRef({
    groupWidth: 0,
    position: 0,
    written: 0,
    drag: null,
    arrow: null,
    touching: false,
    wheelAt: -Infinity,
    interactedAt: -Infinity,
    wake: null,
  });
  const [groupCount, setGroupCount] = useState(1);

  useEffect(() => {
    const viewport = viewportRef.current;
    const firstGroup = firstGroupRef.current;
    if (!viewport || !firstGroup) return undefined;
    const motion = motionRef.current;

    const measure = () => {
      const groupWidth = firstGroup.scrollWidth;
      if (!groupWidth) return;
      const neededGroups = Math.max(
        MIN_REVIEW_GROUPS,
        Math.ceil((2 * viewport.clientWidth) / groupWidth) + 2
      );
      if (neededGroups !== groupCount) {
        motion.groupWidth = 0;
        setGroupCount(neededGroups);
        return;
      }
      if (motion.groupWidth !== groupWidth) {
        const position = motion.groupWidth ? readReviewScroll(viewport, motion) : viewport.scrollLeft;
        motion.groupWidth = groupWidth;
        commitReviewScroll(viewport, motion, position);
      }
    };

    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(firstGroup);
    return () => observer.disconnect();
  }, [groupCount, reviews.length]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const motion = motionRef.current;
    let paused = false;
    let visible = true;
    let previousTime = 0;
    let frameId = 0;
    const needsFrames = () => Boolean(motion.arrow) || (visible && !paused);

    const frame = (time) => {
      frameId = 0;
      const elapsed = Math.min(Math.max(time - previousTime, 0), MAX_FRAME_MS);
      previousTime = time;
      const { groupWidth, arrow } = motion;
      if (groupWidth) {
        let position = readReviewScroll(viewport, motion);
        if (arrow) {
          arrow.startedAt ??= time;
          const progress = Math.min(1, (time - arrow.startedAt) / ARROW_SCROLL_MS);
          position = arrow.from + (arrow.to - arrow.from) * easeInOut(progress);
          if (progress === 1) motion.arrow = null;
        }
        if (arrow || motion.drag || motion.touching || time - motion.wheelAt < WHEEL_ACTIVE_MS) {
          motion.interactedAt = time;
        } else if (!paused && visible) {
          const idle = time - motion.interactedAt - AUTO_SCROLL_RESUME_DELAY_MS;
          if (idle > 0) {
            position +=
              (AUTO_SCROLL_PIXELS_PER_SECOND * easeOut(Math.min(1, idle / AUTO_SCROLL_RAMP_MS)) * elapsed) /
              1000;
          }
        }
        if (position !== motion.position || position < groupWidth || position >= groupWidth * 2) {
          commitReviewScroll(viewport, motion, position);
        }
      }
      if (needsFrames()) frameId = window.requestAnimationFrame(frame);
    };
    const wake = () => {
      if (frameId || !needsFrames()) return;
      previousTime = performance.now();
      frameId = window.requestAnimationFrame(frame);
    };
    motion.wake = wake;

    const updatePause = () => {
      paused = isPerfDebugEnabled() && getPerfToggleEnabled(PERF_TOGGLE_KEYS.PAUSE_REVIEWS_AUTOPLAY);
      wake();
    };
    updatePause();
    window.addEventListener(PERF_DEBUG_EVENT, updatePause);

    const visibilityObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            visible = entries[entries.length - 1].isIntersecting;
            wake();
          });
    visibilityObserver?.observe(viewport);

    const onScroll = () => {
      const { groupWidth } = motion;
      if (!groupWidth) return;
      if (Math.abs(viewport.scrollLeft - motion.written) >= 1) {
        motion.interactedAt = performance.now();
        motion.arrow = null;
      }
      const position = readReviewScroll(viewport, motion);
      if (position < groupWidth || position >= groupWidth * 2) {
        commitReviewScroll(viewport, motion, position);
      }
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      motion.wake = null;
      viewport.removeEventListener("scroll", onScroll);
      visibilityObserver?.disconnect();
      window.removeEventListener(PERF_DEBUG_EVENT, updatePause);
    };
  }, [reviews.length]);

  if (!reviews.length) return null;

  const orderedReviews = [
    ...reviews.filter((review) => review.isVip),
    ...reviews.filter((review) => !review.isVip),
  ];

  const markInteraction = () => {
    const motion = motionRef.current;
    motion.interactedAt = performance.now();
    motion.arrow = null;
    return motion;
  };

  const scrollReviews = (direction) => {
    const viewport = viewportRef.current;
    const card = firstGroupRef.current?.firstElementChild;
    if (!viewport || !card) return;
    const motion = motionRef.current;
    const position = readReviewScroll(viewport, motion);
    const target = (motion.arrow?.to ?? position) + direction * (card.offsetWidth + REVIEW_CARD_GAP);
    motion.interactedAt = performance.now();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motion.arrow = null;
      commitReviewScroll(viewport, motion, target);
      return;
    }
    motion.arrow = { from: position, to: target, startedAt: null };
    motion.wake?.();
  };

  const onWheel = (event) => {
    if (!event.deltaX && !event.shiftKey) return;
    markInteraction().wheelAt = performance.now();
  };

  const onTouchStart = () => {
    markInteraction().touching = true;
  };

  const onTouchEnd = () => {
    markInteraction().touching = false;
  };

  const onPointerDown = (event) => {
    const viewport = viewportRef.current;
    if (event.pointerType !== "mouse" || event.button !== 0 || !viewport) return;
    const motion = markInteraction();
    motion.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: readReviewScroll(viewport, motion),
    };
    viewport.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    const viewport = viewportRef.current;
    const drag = motionRef.current.drag;
    if (!drag || drag.pointerId !== event.pointerId || !viewport) return;
    commitReviewScroll(
      viewport,
      motionRef.current,
      drag.startScrollLeft - (event.clientX - drag.startX)
    );
  };

  const onPointerUp = (event) => {
    if (motionRef.current.drag?.pointerId !== event.pointerId) return;
    markInteraction().drag = null;
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
      viewportRef.current.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="relative">
      <div
        ref={viewportRef}
        className="ri-reviews-viewport w-full overflow-x-auto overflow-y-hidden cursor-grab active:cursor-grabbing select-none"
        role="region"
        aria-label="Player reviews"
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      >
        <div className="ri-reviews-auto-track flex w-max items-stretch">
        {Array.from({ length: groupCount }, (_, groupIndex) => (
          <div
            key={groupIndex}
            ref={groupIndex === 0 ? firstGroupRef : undefined}
            className="flex items-stretch gap-4 pr-4"
            aria-hidden={groupIndex > 0 ? "true" : undefined}
          >
            {orderedReviews.map((review, reviewIndex) => (
              <ReviewCard
                key={`${getReviewKey(review)}-${reviewIndex}`}
                review={review}
                groupIndex={groupIndex}
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

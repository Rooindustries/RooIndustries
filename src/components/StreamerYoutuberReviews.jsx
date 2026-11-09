import React, { useEffect, useRef, useState } from "react";
import { reportRequestError } from "../lib/clientRequest";
import { urlFor } from "../lib/cmsImageUrl";
import { getPerfToggleEnabled, isPerfDebugEnabled, PERF_DEBUG_EVENT, PERF_TOGGLE_KEYS } from "../lib/perfDebug";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
  readHomeSectionData,
} from "../lib/homeSectionData";

const AUTO_SCROLL_PIXELS_PER_SECOND = 24;
const AUTO_SCROLL_RESUME_DELAY_MS = 1500;
const AUTO_SCROLL_RAMP_MS = 900;
const WHEEL_ACTIVE_MS = 150;
const ARROW_SCROLL_MS = 450;
const MAX_FRAME_MS = 100;
const REVIEW_CARD_GAP = 16;
const MIN_REVIEW_GROUPS = 3;
const REVIEW_CARD_WIDTH = "w-[320px] sm:w-[410px]";
const REVIEW_SKELETON_CLASS =
  `${REVIEW_CARD_WIDTH} h-[296px] sm:h-[222px] rounded-2xl bg-skeleton animate-pulse flex-shrink-0`;
const REVIEW_SWIPE_ONLY_QUERY = "(max-width: 639.98px)";
const REVIEW_ARROW_CLASS =
  "absolute top-1/2 -translate-y-1/2 z-10 hidden sm:grid h-10 w-10 place-items-center rounded-full border border-line-soft " +
  "bg-panel text-lg leading-none text-ink-secondary shadow-lg hover:border-line-accent hover:text-ink focus-visible:outline " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]";

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
        reportRequestError(error);
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
      className="py-6 sm:py-8 text-center text-ink relative overflow-hidden"
    >
      <div className="px-4 sm:px-6 mb-8">
        <h2 className="ri-reviews-heading section-title">
          {data?.title || defaultTitle}
        </h2>
        <p className="section-lede">
          {data?.subtitle || defaultSubtitle}
        </p>
      </div>

      {isLoading ? (
        <div className="px-4 flex gap-4 overflow-hidden">
          <div className={REVIEW_SKELETON_CLASS} />
          <div className={REVIEW_SKELETON_CLASS} />
          <div className={`hidden lg:block ${REVIEW_SKELETON_CLASS}`} />
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
        className="w-10 h-10 rounded-full object-cover flex-shrink-0"
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
      className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-black flex-shrink-0 bg-surface-hover"
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
  const rating = Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5
    ? review.rating
    : 5;

  return (
    <article
      data-review-id={getReviewKey(review)}
      data-group-index={groupIndex}
      className={`ri-review-card ${
        isCreator ? "ri-review-card-creator" : "ri-review-card-standard"
      } flex flex-col ${REVIEW_CARD_WIDTH} p-5 sm:py-4 rounded-2xl text-left flex-shrink-0`}
      style={{
        background: isCreator
          ? "linear-gradient(145deg, rgba(250, 219, 120, 0.12), var(--color-surface-solid) 52%)"
          : "var(--color-surface-solid)",
        boxShadow: isCreator
          ? "inset 0 0 0 1px rgba(245, 201, 84, 0.58), 0 16px 40px rgba(0, 0, 0, 0.25)"
          : "inset 0 0 0 1px var(--color-border-soft), 0 16px 40px rgba(0, 0, 0, 0.18)",
      }}
    >
      <div className="ri-review-head flex items-center justify-between gap-3 text-[11px] font-bold uppercase tracking-[0.12em]">
        <p className={`ri-review-kind ${isCreator ? "ri-review-champagne-text" : "text-ink-secondary"}`}>
          {isCreator ? "Creator review" : "Player review"}
        </p>
        <p className="ri-review-game text-ink-secondary">{review.game || "PC performance"}</p>
      </div>

      <div className={`ri-review-stats mt-3 flex min-h-4 flex-wrap items-end gap-x-3 gap-y-1 ${result ? "justify-between" : "justify-end"}`}>
        {result && (
          <p className="ri-review-result min-w-0 font-black leading-none tracking-[-0.04em] tabular-nums">
            <span className="ri-review-result-label mr-2 text-[11px] uppercase tracking-[0.1em] text-ink-secondary">
              {result.label}
            </span>
            <span className="whitespace-nowrap">
              <span className="text-lg text-ink">{result.before}</span>
              <span className="mx-1.5 text-base" style={{ color: "#f5c954" }}>
                →
              </span>
              <span className="ri-review-champagne-text text-[28px]">
                {result.after}
              </span>
            </span>
          </p>
        )}
        <p
          className="ri-review-stars ri-review-champagne-text text-xs font-bold tracking-[0.08em] flex-shrink-0 ml-auto"
          role="img"
          aria-label={`${rating} out of 5 stars`}
        >
          <span aria-hidden="true">{"★".repeat(rating)}{"☆".repeat(5 - rating)}</span>
          <span className="sr-only">{rating} out of 5 stars</span>
        </p>
      </div>

      <blockquote className="ri-review-quote mt-3 flex-1">
        <p className="text-ink text-[15px] leading-[1.5] break-words whitespace-normal">
          “{review.text}”
        </p>
      </blockquote>

      <footer className="ri-review-person mt-4 flex items-center gap-3">
        <ReviewerAvatar review={review} isCreator={isCreator} />
        <div className="min-w-0">
          <p
            className={`font-bold text-[15px] leading-tight text-ink break-words ${
              isCreator ? "ri-review-champagne-text" : ""
            }`}
          >
            {review.name}
          </p>
          {review.profession && (
            <p className="mt-0.5 text-[13px] leading-snug text-ink-secondary">
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
        if (arrow || motion.drag || motion.touching || motion.focused || time - motion.wheelAt < WHEEL_ACTIVE_MS) {
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

    const swipeOnly = window.matchMedia(REVIEW_SWIPE_ONLY_QUERY);
    const updatePause = () => {
      paused =
        swipeOnly.matches ||
        (isPerfDebugEnabled() && getPerfToggleEnabled(PERF_TOGGLE_KEYS.PAUSE_REVIEWS_AUTOPLAY));
      wake();
    };
    updatePause();
    window.addEventListener(PERF_DEBUG_EVENT, updatePause);
    swipeOnly.addEventListener("change", updatePause);

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
      swipeOnly.removeEventListener("change", updatePause);
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
        tabIndex={0}
        onFocus={(event) => {
          if (event.target.matches(":focus-visible")) markInteraction().focused = true;
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          markInteraction().focused = false;
        }}
        onKeyDown={markInteraction}
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
        className={`${REVIEW_ARROW_CLASS} left-4`}
        aria-label="Scroll reviews left"
      >
        ←
      </button>
      <button
        type="button"
        onClick={() => scrollReviews(1)}
        className={`${REVIEW_ARROW_CLASS} right-4`}
        aria-label="Scroll reviews right"
      >
        →
      </button>
    </div>
  );
}

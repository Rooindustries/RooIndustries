import React, { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { client, urlFor } from "../sanityClient";

const titleClass =
  "text-3xl sm:text-[40px] md:text-[48px] leading-tight font-extrabold text-center tracking-tight " +
  "text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]";

export default function StreamerYoutuberReviews() {
  const [data, setData] = useState(null);

  const sectionClass =
    "pt-12 sm:pt-16 pb-4 sm:pb-6 text-center text-white relative overflow-hidden";

  useEffect(() => {
    const query = `*[_type == "proReviewsCarousel"][0]{
      _id,
      title,
      subtitle,
      reviews[]{
        name,
        profession,
        game,
        optimizationResult,
        text,
        rating,
        pfp,
        isVip 
      }
    }`;
    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await client.fetch(query);
        if (cancelled) return;
        setData(res);
      } catch (error) {
        console.error("Could not fetch reviews:", error);
      }
    };

    fetchData();

    const subscription = client
      .listen(query, {}, { visibility: "query" })
      .subscribe((update) => {
        if (cancelled) return;
        if (update.result) {
          setData(update.result);
        }
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const defaultTitle = "What professionals say about us";
  const defaultSubtitle = "Feedback from pros who rely on us.";
  const reviews = data?.reviews || [];

  return (
    <section className={sectionClass}>
      <div className="px-4 sm:px-6 mb-8">
        <h3 className={`${titleClass} mb-3`}>{data?.title || defaultTitle}</h3>
        <p className="text-slate-300/90 text-base sm:text-lg">
          {data?.subtitle || defaultSubtitle}
        </p>
      </div>

      <InfiniteDraggableCarousel reviews={reviews} />
    </section>
  );
}

function CompactStarRating({ rating = 5 }) {
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating % 1 !== 0;
  const totalStars = 5;

  return (
    <div className="flex items-center gap-0.5">
      {[...Array(totalStars)].map((_, i) => {
        const isFull = i < fullStars;
        const isHalf = i === fullStars && hasHalfStar;
        const isEmpty = i >= fullStars && !isHalf;

        return (
          <div key={i} className="relative">
            {!isEmpty && (
              <div
                className="absolute inset-0 blur-sm rounded-full opacity-70"
                style={{
                  background:
                    "radial-gradient(circle, rgba(250,204,21,0.8) 0%, rgba(251,146,60,0.4) 50%, transparent 70%)",
                  transform: "scale(1.8)",
                }}
              />
            )}
            {isHalf ? (
              <div className="relative">
                <Star className="w-4 h-4 text-slate-600 absolute" />
                <div className="overflow-hidden w-[50%]">
                  <Star
                    className="w-4 h-4 text-yellow-400 fill-yellow-400"
                    style={{
                      filter: "drop-shadow(0 0 3px rgba(250,204,21,0.9))",
                    }}
                  />
                </div>
              </div>
            ) : (
              <Star
                className={`w-4 h-4 relative ${
                  isEmpty ? "text-slate-600" : "text-yellow-400 fill-yellow-400"
                }`}
                style={{
                  filter: isEmpty
                    ? undefined
                    : "drop-shadow(0 0 3px rgba(250,204,21,0.9))",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReviewCard({ review }) {
  const isVip = review.isVip;
  const highlightStyle = {
    background: isVip
      ? "none"
      : "linear-gradient(90deg, #7dd3fc 0%, #38bdf8 30%, #22d3ee 70%, #67e8f9 100%)",
    WebkitBackgroundClip: isVip ? "border-box" : "text",
    backgroundClip: isVip ? "border-box" : "text",
    WebkitTextFillColor: isVip ? "#facc15" : "transparent",
    color: isVip ? "#facc15" : "transparent",
    textShadow: isVip ? "0 0 10px rgba(250, 204, 21, 0.5)" : "none",
    filter: isVip ? "none" : "drop-shadow(0 0 8px rgba(56,189,248,0.5))",
  };

  return (
    <div
      className="flex-shrink-0 w-[420px] sm:w-[520px] h-[260px] sm:h-[290px] rounded-2xl select-none pointer-events-none flex flex-col transition-all duration-300"
      style={{
        background: "rgba(12,22,40,0.95)",
        boxShadow: "none",
        border: isVip ? "2px solid #fbbf24" : "1px solid rgba(71,85,105,0.5)",
      }}
    >
      <div className="relative px-4 py-5 sm:px-6 sm:py-6 flex flex-col h-full overflow-hidden">
        {/* Internal background glow */}
        {isVip && (
          <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-500/20 blur-[50px] rounded-full pointer-events-none -mr-10 -mt-10"></div>
        )}

        <div className="absolute top-4 right-4 z-10">
          <CompactStarRating rating={review.rating || 5} />
        </div>

        {/* Header Section */}
        <div className="flex items-center gap-3 pr-24 mb-3 flex-shrink-0 relative z-10">
          {review.pfp ? (
            <img
              src={urlFor(review.pfp).width(120).height(120).fit("crop").url()}
              alt={review.name}
              className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full object-cover flex-shrink-0 ${
                isVip
                  ? "border-2 border-yellow-300"
                  : "border-2 border-sky-500/30"
              }`}
              draggable={false}
            />
          ) : (
            <div
              className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center text-white font-bold text-lg flex-shrink-0 ${
                isVip
                  ? "bg-gradient-to-br from-yellow-400 to-orange-500"
                  : "bg-gradient-to-br from-sky-500 to-cyan-400"
              }`}
            >
              {review.name?.charAt(0)?.toUpperCase() || "?"}
            </div>
          )}

          <span
            className={`font-semibold text-lg sm:text-xl truncate ${
              isVip ? "text-yellow-300" : "text-sky-300"
            }`}
          >
            {review.name}
          </span>
        </div>

        {/* Content Body */}
        <div className="flex flex-col text-left w-full flex-1 min-h-0 relative z-10">
          {review.optimizationResult && (
            <h4
              className="text-xl sm:text-2xl font-bold leading-snug flex-shrink-0 mb-1"
              style={highlightStyle}
            >
              {review.optimizationResult}
            </h4>
          )}

          {review.game && (
            <p
              className="text-sm sm:text-base font-semibold leading-snug flex-shrink-0 mb-1"
              style={highlightStyle}
            >
              {review.game}
            </p>
          )}

          {/* Review Text - Quotes removed here */}
          <p className="text-slate-300 text-sm sm:text-base leading-relaxed italic break-words overflow-hidden line-clamp-3 mb-1">
            {review.text}
          </p>

          {/* Profession - Pushed to bottom with mt-auto */}
          {review.profession && (
            <p
              className={`font-medium text-sm sm:text-base flex-shrink-0 mt-auto pt-1 ${
                isVip ? "text-yellow-300" : "text-cyan-400"
              }`}
            >
              {review.profession}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function InfiniteDraggableCarousel({ reviews }) {
  const containerRef = useRef(null);
  const trackRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const xPos = useRef(0);
  const animationFrameId = useRef(null);
  const startTime = useRef(null);
  const dragStart = useRef(0);
  const lastDragPos = useRef(0);
  const velocity = useRef(0);
  const positionHistory = useRef([]);
  const SPEED = 0.5;

  const displayReviews =
    reviews.length > 0 ? [...reviews, ...reviews, ...reviews, ...reviews] : [];

  const animate = (timestamp) => {
    if (!startTime.current) startTime.current = timestamp;
    if (!isDragging) {
      if (Math.abs(velocity.current) > 0.1) {
        velocity.current *= 0.95;
        xPos.current -= velocity.current;
      } else {
        xPos.current -= SPEED;
      }
    }
    if (trackRef.current) {
      const trackWidth = trackRef.current.scrollWidth;
      const singleSetWidth = trackWidth / 4;
      if (xPos.current <= -singleSetWidth) {
        xPos.current += singleSetWidth;
      } else if (xPos.current > 0) {
        xPos.current -= singleSetWidth;
      }
      trackRef.current.style.transform = `translate3d(${xPos.current}px, 0, 0)`;
    }
    animationFrameId.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    if (reviews.length === 0) return;
    animationFrameId.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId.current);
  }, [reviews.length, isDragging]);

  const handleDragStart = (clientX) => {
    setIsDragging(true);
    dragStart.current = clientX;
    lastDragPos.current = clientX;
    velocity.current = 0;
    positionHistory.current = [{ x: clientX, time: performance.now() }];
    if (trackRef.current) {
      trackRef.current.style.cursor = "grabbing";
    }
  };

  const handleDragMove = (clientX) => {
    if (!isDragging) return;
    const delta = clientX - lastDragPos.current;
    xPos.current += delta;
    lastDragPos.current = clientX;
    const now = performance.now();
    positionHistory.current.push({ x: clientX, time: now });
    positionHistory.current = positionHistory.current.filter(
      (p) => now - p.time < 300
    );
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    if (trackRef.current) {
      trackRef.current.style.cursor = "grab";
    }
    const now = performance.now();
    const history = positionHistory.current;
    if (history.length >= 2) {
      const latest = history[history.length - 1];
      const oldest = history.find((p) => now - p.time > 50) || history[0];
      const dist = latest.x - oldest.x;
      const time = latest.time - oldest.time;
      if (time > 0) {
        velocity.current = -(dist / time) * 15;
      }
    } else {
      velocity.current = 0;
    }
  };

  const onMouseDown = (e) => {
    e.preventDefault();
    handleDragStart(e.clientX);
  };
  const onMouseMove = (e) => {
    if (isDragging) e.preventDefault();
    handleDragMove(e.clientX);
  };
  const onMouseUp = () => handleDragEnd();
  const onMouseLeave = () => {
    if (isDragging) handleDragEnd();
  };
  const onTouchStart = (e) => handleDragStart(e.touches[0].clientX);
  const onTouchMove = (e) => handleDragMove(e.touches[0].clientX);
  const onTouchEnd = () => handleDragEnd();

  if (reviews.length === 0) {
    return (
      <div className="text-slate-400 text-center py-12">No reviews yet</div>
    );
  }

  return (
    <div
      className="relative w-full overflow-hidden select-none"
      ref={containerRef}
    >
      <div
        ref={trackRef}
        className="flex gap-5 pr-5 w-max px-4 cursor-grab items-stretch"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ willChange: "transform" }}
      >
        {displayReviews.map((review, i) => (
          <ReviewCard key={`review-${i}`} review={review} />
        ))}
      </div>
    </div>
  );
}

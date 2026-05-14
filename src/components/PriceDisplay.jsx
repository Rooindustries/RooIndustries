import React from "react";
import packagePricing from "../lib/packagePricing";

const { getPackagePricePresentation } = packagePricing;

const sizeClasses = {
  card: {
    current: "text-5xl sm:text-6xl",
    compare: "text-lg sm:text-xl",
    slash: "h-[2px]",
  },
  modal: {
    current: "text-4xl",
    compare: "text-base",
    slash: "h-[2px]",
  },
  summary: {
    current: "text-3xl",
    compare: "text-sm",
    slash: "h-px",
  },
};

export default function PriceDisplay({
  pkg = null,
  price = "",
  compareAtPrice = "",
  size = "card",
  className = "",
}) {
  const resolved = pkg
    ? getPackagePricePresentation(
        pkg.title,
        pkg.price || price || pkg.compareAtPrice || pkg.originalPrice
      )
    : { price, compareAtPrice };
  const currentPrice = resolved.price || price || "";
  const oldPrice = resolved.compareAtPrice || compareAtPrice || "";
  const classes = sizeClasses[size] || sizeClasses.card;

  if (!currentPrice) return null;

  return (
    <div
      className={`flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 ${className}`}
      aria-label={
        oldPrice
          ? `Price ${currentPrice}, previous price ${oldPrice}`
          : `Price ${currentPrice}`
      }
    >
      <span
        aria-hidden="true"
        className={`${classes.current} font-extrabold leading-none text-sky-400 drop-shadow-[0_0_18px_rgba(56,189,248,0.35)]`}
      >
        {currentPrice}
      </span>
      {oldPrice && oldPrice !== currentPrice && (
        <span
          aria-hidden="true"
          className={`${classes.compare} relative inline-flex -translate-y-1 items-center font-bold leading-none text-slate-400/85`}
        >
          <span>{oldPrice}</span>
          <span
            className={`pointer-events-none absolute left-[-0.18em] right-[-0.18em] top-1/2 ${classes.slash} -translate-y-1/2 -rotate-12 rounded-full bg-gradient-to-r from-cyan-300/60 via-sky-300 to-indigo-300/80 shadow-[0_0_8px_rgba(56,189,248,0.75)]`}
          />
        </span>
      )}
    </div>
  );
}

import React from "react";
import { Link } from "react-router-dom";
import homeCopy from "../../lib/homeCopy";
import useHomeSectionLinkHandler from "../../lib/useHomeSectionLinkHandler";

const { HOME_COPY } = homeCopy;
const hero = HOME_COPY.hero;

// Left-column hero copy for the split 3D stage. The 3D card owns the right
// half of the viewport, so this column stays left-aligned and compact.
export default function HeroSplitCopy() {
  const handleHomeSectionLink = useHomeSectionLinkHandler();

  return (
    <div className="mx-auto grid min-h-screen w-full max-w-7xl items-start px-6 sm:px-10 lg:grid-cols-2">
      <div className="max-w-xl pt-8 pb-12 text-left lg:pt-14">
        <h1 className="font-extrabold tracking-tight">
          <span
            className="block text-ink"
            style={{ fontSize: "clamp(1.7rem, 0.6rem + 2.1vw + 0.5vh, 3.1rem)", lineHeight: 1.07, textWrap: "balance" }}
          >
            {hero.headingLine1}
          </span>
          <span
            className="text-gradient-display block"
            style={{ fontSize: "clamp(1.7rem, 0.6rem + 2.1vw + 0.5vh, 3.1rem)", lineHeight: 1.07, textWrap: "balance" }}
          >
            {hero.headingLine2}
          </span>
        </h1>

        <p className="mt-5 max-w-md text-sm leading-relaxed text-ink-secondary sm:text-base">
          {hero.description}
        </p>

        <p className="mt-4 text-sm font-semibold hero-subtext-accent sm:text-base">
          {hero.subtext}
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            to="/#packages"
            onClick={(event) => handleHomeSectionLink(event, "#packages")}
            className="glow-button book-optimization-button relative inline-flex items-center justify-center gap-2 rounded-md px-5 py-3 text-sm font-semibold text-white ring-2 ring-line-accent hover:text-white active:translate-y-px transition-all duration-300 sm:px-6 sm:text-base"
          >
            {hero.ctaPrimaryText}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
          <Link
            to="/#how-it-works"
            onClick={(event) => handleHomeSectionLink(event, "#how-it-works")}
            className="glow-button fps-boosts-button inline-flex items-center justify-center gap-2 rounded-md px-5 py-3 text-sm font-semibold text-ink ring-1 ring-line-accent active:translate-y-px transition-all duration-300 sm:px-6 sm:text-base"
          >
            {hero.ctaSecondaryText}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </div>

        {hero.ctaNote && (
          <p className="gold-flair-text mt-5 text-sm font-extrabold tracking-wide">
            {hero.ctaNote}
          </p>
        )}
      </div>
      <div aria-hidden="true" />
    </div>
  );
}

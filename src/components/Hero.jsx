import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { getPublicContent } from "../lib/publicContentClient";
import homeCopy from "../lib/homeCopy";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";
import { trackEvent } from "../lib/analytics";

const { resolveHeroCopy } = homeCopy;

const normalizeText = (s = "") =>
  String(s)
    .replace(/\\u00a0/g, " ")
    .replace(/\u00a0/g, " ");


function CtaNote({ text }) {
  const parts = normalizeText(text).trim().split(/\s+·\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  return (
    <ul className="ri-hero-cta-note mx-auto mt-4 flex max-w-2xl flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-center text-sm font-semibold text-ink-secondary sm:mt-5 sm:text-[15px]">
      {parts.map((part, index) => (
        <li key={index} className="flex items-start gap-1.5">
          <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={2.5} />
          {part}
        </li>
      ))}
    </ul>
  );
}

export default function Hero({ initialData = null, headingTag = "h1" }) {
  const Heading = headingTag;
  const [fetchedHero, setFetchedHero] = useState(null);
  const heroData = resolveHeroCopy(initialData || fetchedHero);
  const handleHomeSectionLink = useHomeSectionLinkHandler();

  const handleHeroCta = (event, hash, cta) => {
    trackEvent("home_cta_click", { cta, surface: "hero" });
    handleHomeSectionLink(event, hash);
  };

  useEffect(() => {
    if (initialData) return undefined;
    let cancelled = false;
    getPublicContent("hero")
      .then((data) => {
        if (!cancelled) setFetchedHero(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialData]);

  const {
    headingLine1,
    headingLine2,
    description,
    subtext,
    ctaPrimaryText: primaryCtaText,
    ctaSecondaryText: secondaryCtaText,
    ctaNote,
  } = heroData;

  const headingLine2BaseClass = "text-gradient-display";

  const renderWithGlow110 = (text) => {
    const cleaned = normalizeText(text);
    const target = "110% FPS";
    if (!cleaned || !cleaned.includes(target)) return cleaned;

    const parts = cleaned.split(target);

    return (
      <>
        {parts[0]}
        <span
          className="text-accent"
          style={{ textShadow: "0 0 10px var(--color-accent-glow)" }}
        >
          {target}
        </span>
        {parts.slice(1).join(target)}
      </>
    );
  };

  const renderHeadingLine1 = (text) => {
    if (!text) return null;

    const cleaned = normalizeText(text);

    if (cleaned.includes("-")) {
      const parts = cleaned.split("-");
      const firstPart = parts[0].trim();
      const secondPart = parts.slice(1).join("-").trim();

      return (
        <>
          <span className="text-ink">
            {renderWithGlow110(`${firstPart} - `)}
          </span>
          <span className="text-gradient-display">
            {renderWithGlow110(secondPart)}
          </span>
        </>
      );
    }

    return <span className="text-ink">{renderWithGlow110(cleaned)}</span>;
  };

  const heroHeadingStyle = {
    fontSize: "clamp(1.75rem, 0.5rem + 5vw, 3.75rem)",
    lineHeight: 1.08,
  };

  const line1Ref = useRef(null);
  const line2Ref = useRef(null);

  useEffect(() => {
    const el1 = line1Ref.current;
    const el2 = line2Ref.current;
    if (!el1 || !el2 || !headingLine1 || !headingLine2) return;

    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;pointer-events:none";
    document.body.appendChild(probe);
    let rafId;

    const measureWidth = (text, fontSize, style) => {
      probe.style.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      probe.style.letterSpacing = style.letterSpacing;
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    };

    const adjust = () => {
      el2.style.fontSize = "clamp(1.75rem, 0.5rem + 5vw, 3.75rem)";
      el1.style.fontSize = "clamp(1.75rem, 0.5rem + 5vw, 3.75rem)";

      const s = getComputedStyle(el2);
      const base = parseFloat(s.fontSize);
      const container = el2.parentElement?.parentElement;
      const avail = container
        ? container.getBoundingClientRect().width
        : window.innerWidth - 48;

      const text1 = normalizeText(headingLine1);
      const text2 = normalizeText(headingLine2);
      const nw1 = measureWidth(text1, base, s);
      const nw2 = measureWidth(text2, base, s);
      if (nw1 <= 0 || nw2 <= 0) return;

      const targetWidth = Math.min(Math.max(nw1, nw2), avail * 0.99);
      const line1Size = Math.min(base * 1.14, base * (targetWidth / nw1));
      const line2Size = Math.min(base * 1.14, base * (targetWidth / nw2));

      el1.style.fontSize = `${line1Size}px`;
      el2.style.fontSize = `${line2Size}px`;
    };

    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(adjust);
    };

    (document.fonts?.ready ?? Promise.resolve()).then(adjust);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(rafId);
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    };
  }, [headingLine1, headingLine2, headingTag]);

  return (
    <header id="top" className="flex justify-center pb-14 pt-6 sm:py-16">
      <section className="mx-auto max-w-4xl px-6 text-center w-full">
        <div className="w-full">
          <Heading className="font-extrabold tracking-tight text-center">
            {headingLine1 && (
              <span
                ref={line1Ref}
                className="ri-hero-heading-line text-metal-display block w-full text-center text-ink"
                style={heroHeadingStyle}
              >
                {renderHeadingLine1(headingLine1)}
              </span>
            )}

            {headingLine2 && (
              <span
                ref={line2Ref}
                className={`ri-hero-heading-line block w-full text-center ${headingLine2BaseClass}`}
                style={heroHeadingStyle}
              >
                {renderWithGlow110(headingLine2)}
              </span>
            )}
          </Heading>
        </div>

        <div className="min-h-[36px] sm:min-h-[60px]">
          {description && (
            <p className="mt-4 text-base md:text-lg text-ink-secondary leading-relaxed max-w-2xl mx-auto text-balance">
              {renderWithGlow110(description)}
            </p>
          )}
        </div>

        <div className="min-h-[24px] sm:min-h-[36px]">
          {subtext && (
            <p className="mt-4 sm:mt-6 text-base sm:text-lg font-semibold hero-subtext-accent text-balance">
              {renderWithGlow110(subtext)}
            </p>
          )}
        </div>

        <div className="mt-5 sm:mt-6 flex items-center justify-center gap-3 sm:gap-4 flex-wrap min-h-[56px]">
          <Link
            to="/#packages"
            onClick={(event) =>
              handleHeroCta(event, "#packages", "packages")
            }
            className="glow-button book-optimization-button relative inline-flex items-center justify-center gap-2 rounded-md px-4 sm:px-6 py-2.5 sm:py-3.5 text-sm sm:text-base font-semibold text-white ring-2 ring-line-accent hover:text-white active:translate-y-px transition-all duration-300"
          >
            {renderWithGlow110(primaryCtaText)}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>

          <Link
            to="/#how-it-works"
            onClick={(event) =>
              handleHeroCta(event, "#how-it-works", "how_it_works")
            }
            className="glow-button fps-boosts-button inline-flex items-center justify-center gap-2 rounded-md px-4 sm:px-6 py-2.5 sm:py-3.5 text-sm sm:text-base font-semibold text-ink ring-1 ring-line-accent active:translate-y-px transition-all duration-300"
          >
            {renderWithGlow110(secondaryCtaText)}
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </Link>
        </div>

        {ctaNote && (
          <CtaNote text={ctaNote} />
        )}
      </section>
    </header>
  );
}

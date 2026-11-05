export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

export const scrollWindowTo = (top) => {
  window.scrollTo({
    top: Math.max(0, top),
    behavior: prefersReducedMotion() ? "instant" : "smooth",
  });
};

export const REVEAL_DEFERRED_SECTIONS_EVENT = "roo:reveal-deferred-sections";

export const scrollWindowToElement = (element) => {
  window.dispatchEvent(new Event(REVEAL_DEFERRED_SECTIONS_EVENT));
  const marginTop = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
  scrollWindowTo(element.getBoundingClientRect().top + window.scrollY - marginTop);
};

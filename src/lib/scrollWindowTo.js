import { revealDeferredSections } from "./sectionNavigation";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

export const scrollWindowTo = (top) => {
  window.scrollTo({
    top: Math.max(0, top),
    behavior: prefersReducedMotion() ? "instant" : "smooth",
  });
};

export const scrollWindowToElement = (element, offset) => {
  revealDeferredSections();
  scrollWindowTo(element.getBoundingClientRect().top + window.scrollY - offset);
};

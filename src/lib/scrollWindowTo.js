export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

export const scrollWindowTo = (top) => {
  window.scrollTo({
    top: Math.max(0, top),
    behavior: prefersReducedMotion() ? "instant" : "smooth",
  });
};

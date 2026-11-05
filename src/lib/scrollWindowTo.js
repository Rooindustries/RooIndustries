export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

export const scrollWindowTo = (top) => {
  window.scrollTo({
    top: Math.max(0, top),
    behavior: prefersReducedMotion() ? "instant" : "smooth",
  });
};

const revealDeferredSectionsBefore = (element) => {
  document.querySelectorAll(".deferred-section-content").forEach((section) => {
    if (section.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
      section.style.contentVisibility = "visible";
    }
  });
};

export const scrollWindowToElement = (element, offset = 0) => {
  revealDeferredSectionsBefore(element);
  scrollWindowTo(element.getBoundingClientRect().top + window.scrollY - offset);
};

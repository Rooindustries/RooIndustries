import {
  buildHomeSectionHref,
  isHomeSectionHash,
  normalizeSectionHash,
} from "../lib/sectionNavigation";
import { alignToHashTarget } from "../lib/scrollCoordinator";

describe("sectionNavigation", () => {
  it.each([
    "#services",
    "#packages",
    "#how-it-works",
    "#faq",
    "#upgrade-path",
    "#trust",
  ])("treats %s as a valid home hash", (hash) => {
    expect(isHomeSectionHash(hash)).toBe(true);
  });

  it("normalizes and builds hrefs for in-page CTA hashes", () => {
    expect(normalizeSectionHash("how-it-works")).toBe("#how-it-works");
    expect(buildHomeSectionHref("upgrade-path")).toBe("/#upgrade-path");
    expect(buildHomeSectionHref("#trust")).toBe("/#trust");
  });
});

describe("section alignment during deferred loading", () => {
  let cleanup;
  let scrollTop;
  let documentTop;
  let originalScrollY;
  let settled;

  beforeEach(() => {
    jest.useFakeTimers();
    scrollTop = 0;
    documentTop = 900;
    originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollTop });
    jest.spyOn(window, "scrollTo").mockImplementation(({ top }) => { scrollTop = top; });
    document.body.innerHTML = '<div data-section-placeholder></div><section id="packages"></section>';
    jest.spyOn(document.getElementById("packages"), "getBoundingClientRect")
      .mockImplementation(() => ({ top: documentTop - scrollTop }));
    document.documentElement.style.scrollBehavior = "smooth";
    settled = jest.fn();
    window.addEventListener("roo:section-align-settled", settled);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    window.removeEventListener("roo:section-align-settled", settled);
    Object.defineProperty(window, "scrollY", originalScrollY);
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("scroll-behavior");
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const startAlignment = (options = {}) => alignToHashTarget({
    hash: "#packages",
    getOffsetPx: () => 80,
    preAlignStableFramesRequired: 1,
    stableFramesRequired: 2,
    minRuntimeMs: 420,
    maxWaitMs: 4200,
    ...options,
  });

  test("waits for an earlier section to finish loading before settling", () => {
    cleanup = startAlignment();
    jest.advanceTimersByTime(750);
    expect(settled).not.toHaveBeenCalled();

    documentTop = 1600;
    document.querySelector("[data-section-placeholder]").remove();
    jest.advanceTimersByTime(500);

    expect(scrollTop).toBe(1520);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(document.documentElement.style.scrollBehavior).toBe("smooth");
  });

  test("does not wait for placeholders below the destination", () => {
    document.body.appendChild(document.querySelector("[data-section-placeholder]"));
    cleanup = startAlignment();
    jest.advanceTimersByTime(500);
    expect(scrollTop).toBe(820);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test("lets user scrolling cancel alignment while a section is loading", () => {
    cleanup = startAlignment();
    jest.advanceTimersByTime(32);
    scrollTop = 250;
    window.dispatchEvent(new Event("wheel"));
    documentTop = 1600;
    document.querySelector("[data-section-placeholder]").remove();
    jest.advanceTimersByTime(500);
    expect(scrollTop).toBe(250);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test("releases alignment when loading exceeds its deadline", () => {
    cleanup = startAlignment({ maxWaitMs: 80 });
    jest.advanceTimersByTime(150);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(document.documentElement.style.scrollBehavior).toBe("smooth");
  });
});

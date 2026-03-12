import {
  buildHomeSectionHref,
  isHomeSectionHash,
  normalizeSectionHash,
} from "../lib/sectionNavigation";

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

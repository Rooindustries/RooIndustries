const fs = require("fs");
const path = require("path");

describe("review carousel design", () => {
  const componentSource = fs.readFileSync(
    path.join(__dirname, "../components/StreamerYoutuberReviews.jsx"),
    "utf8"
  );

  test("keeps the existing centered heading treatment", () => {
    expect(componentSource).toContain("font-extrabold text-center tracking-tight");
    expect(componentSource).toContain('className="px-4 sm:px-6 mb-3"');
    expect(componentSource).toContain("text-[28px] sm:text-[32px] md:text-[36px]");
  });

  test("shows multiple compact reviews with automatic and manual scrolling", () => {
    const stylesheet = fs.readFileSync(
      path.join(__dirname, "../index.css"),
      "utf8"
    );
    expect(componentSource).toContain("function AutoReviewCarousel");
    expect(componentSource).toContain("ri-reviews-auto-track");
    expect(componentSource).toContain("w-[320px] sm:w-[360px] min-h-[184px]");
    expect(componentSource).toContain("[0, 1].map");
    expect(componentSource).toContain("“{review.text}”");
    expect(componentSource).toContain("AUTO_SCROLL_PIXELS_PER_SECOND = 20");
    expect(componentSource).toContain("window.setInterval(tick, 50)");
    expect(componentSource).toContain("viewport.scrollLeft +=");
    expect(componentSource).toContain("onPointerDown={onPointerDown}");
    expect(componentSource).toContain("Scroll reviews left");
    expect(componentSource).toContain("Scroll reviews right");
    expect(componentSource).toContain("absolute left-1 sm:left-3 top-1/2");
    expect(componentSource).toContain("absolute right-1 sm:right-3 top-1/2");
    expect(stylesheet).toContain(".ri-reviews-viewport::-webkit-scrollbar");
    expect(componentSource).toContain('color: "var(--color-accent)"');
    expect(componentSource).not.toContain("bg-yellow");
    expect(componentSource).not.toContain("text-yellow");
    expect(componentSource).not.toContain("FocusedReviewCarousel");
    expect(componentSource).not.toContain("newCreatorReviews");
    expect(componentSource).toContain("const reviews = data?.reviews || [];");
  });

  test("distinguishes creator reviews from standard reviews with real gold", () => {
    expect(componentSource).toContain("const isCreator = Boolean(review.isVip);");
    expect(componentSource).toContain("ri-review-card-creator");
    expect(componentSource).toContain("rgba(212, 175, 55, 0.58)");
    expect(componentSource).toContain("var(--color-accent)");
    expect(componentSource).toContain('isCreator ? "Creator review" : "Player review"');
    expect(componentSource).not.toContain(" · ");
    expect(componentSource).toContain("...reviews.filter((review) => review.isVip)");
  });
});

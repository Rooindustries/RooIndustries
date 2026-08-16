const fs = require("fs");
const path = require("path");

describe("review card theme styling", () => {
  const componentSource = fs.readFileSync(
    path.join(__dirname, "../components/StreamerYoutuberReviews.jsx"),
    "utf8"
  );
  const stylesheet = fs.readFileSync(
    path.join(__dirname, "../index.css"),
    "utf8"
  );

  test("uses one theme-aware highlight class for results and game names", () => {
    expect(componentSource).toContain('const highlightClass = `ri-review-highlight ${');
    expect(componentSource.match(/className=\{`\$\{highlightClass\}/g)).toHaveLength(2);
    expect(componentSource).not.toContain("highlightStyle");
  });

  test("keeps VIP highlights gold and makes regular dark-theme highlights white", () => {
    expect(stylesheet).toContain(".ri-review-highlight-standard {");
    expect(stylesheet).toContain("#38bdf8 30%");
    expect(stylesheet).toContain(".ri-review-highlight-vip {");
    expect(stylesheet).toContain("-webkit-text-fill-color: #facc15;");

    const darkRule = stylesheet.match(
      /html\[data-theme="dark"\] \.ri-review-highlight-standard \{([^}]+)\}/
    )?.[1];

    expect(darkRule).toContain("-webkit-text-fill-color: #ffffff;");
    expect(darkRule).toContain("color: #ffffff;");
    expect(darkRule).toContain("filter: none;");
    expect(darkRule).toContain("text-shadow: none;");
    expect(stylesheet).not.toContain(
      'html[data-theme="dark"] .ri-review-highlight {'
    );
  });
});

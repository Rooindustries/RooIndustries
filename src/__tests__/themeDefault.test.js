const fs = require("fs");
const path = require("path");

const readSource = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("site theme default", () => {
  test("server markup and the pre-hydration boot script default to dark", () => {
    const source = readSource("app/layout.jsx");

    expect(source).toContain('<html lang="en" data-theme="dark"');
    expect(source).toContain('<meta name="theme-color" content="#070707" />');
    expect(source).toContain(
      'var theme = stored === "default" ? "default" : "dark";'
    );
    expect(source).toContain(
      'document.documentElement.dataset.theme = "dark";'
    );
  });

  test.each([
    "src/components/Navbar.jsx",
    "app/tourney/TourneyThemeToggle.jsx",
  ])("keeps Roo Blue opt-in while treating missing and legacy values as dark in %s", (relativePath) => {
    const source = readSource(relativePath);

    expect(source).toContain(
      'const normalizeTheme = (value) => (value === "default" ? "default" : "dark");'
    );
    expect(source).toContain('dark: "Blackout Gold"');
    expect(source).toContain('useState("dark")');
  });

  test("uses a high-contrast metallic gold gradient", () => {
    const source = readSource("src/index.css");
    const darkTheme = source.slice(
      source.indexOf('html[data-theme="dark"] {'),
      source.indexOf(".deferred-section-content")
    );

    expect(darkTheme).toContain("--color-accent: #d4af37;");
    expect(darkTheme).toContain("--color-accent-strong: #b88708;");
    expect(darkTheme).toContain("--color-text-accent: #d4af37;");
    expect(darkTheme).toContain("#fff0a6 40%");
    expect(darkTheme).not.toMatch(/#(?:e8b94a|c9962e|c78b16|d6a338)/i);
  });

  test("does not turn drop-shadow heading utilities into rectangular box shadows", () => {
    const source = readSource("src/index.css");

    expect(source).toContain(
      '[class*="shadow-[0_0"]:not([class*="drop-shadow"])'
    );
    expect(source).toContain('h2.text-info-text');
    expect(source).toContain('background-image: var(--gradient-display-text);');
  });
});

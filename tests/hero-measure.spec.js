const { test, devices } = require("@playwright/test");

const SITE = "https://rooindustries.com";

const phones = [
  { name: "iPhone_SE_375", config: devices["iPhone SE"] },
  { name: "iPhone_14_390", config: devices["iPhone 14"] },
  { name: "iPhone_14_ProMax_430", config: devices["iPhone 14 Pro Max"] },
  { name: "Pixel_7_412", config: devices["Pixel 7"] },
  { name: "Desktop_1280", config: { viewport: { width: 1280, height: 800 } } },
];

for (const { name, config } of phones) {
  test(`measure hero headings - ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ ...config });
    const page = await context.newPage();
    await page.goto(SITE, { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      if (!h1) return { error: "No h1 found" };
      const spans = h1.querySelectorAll(":scope > span");
      if (spans.length < 2) return { error: `Only ${spans.length} spans` };

      const line1 = spans[0];
      const line2 = spans[1];
      const s1 = getComputedStyle(line1);
      const s2 = getComputedStyle(line2);

      // Measure natural (nowrap) width
      const origWS1 = line1.style.whiteSpace;
      const origWS2 = line2.style.whiteSpace;
      const origW1 = line1.style.width;
      const origW2 = line2.style.width;

      line1.style.whiteSpace = "nowrap";
      line1.style.width = "auto";
      line2.style.whiteSpace = "nowrap";
      line2.style.width = "auto";

      const nw1 = line1.getBoundingClientRect().width;
      const nw2 = line2.getBoundingClientRect().width;

      line1.style.whiteSpace = origWS1;
      line1.style.width = origW1;
      line2.style.whiteSpace = origWS2;
      line2.style.width = origW2;

      const r1 = line1.getBoundingClientRect();
      const r2 = line2.getBoundingClientRect();

      return {
        line1Text: line1.textContent,
        line2Text: line2.textContent,
        line1FontSize: s1.fontSize,
        line2FontSize: s2.fontSize,
        line1NowrapWidth: Math.round(nw1 * 100) / 100,
        line2NowrapWidth: Math.round(nw2 * 100) / 100,
        widthRatio: Math.round((nw1 / nw2) * 10000) / 10000,
        line1Height: Math.round(r1.height * 100) / 100,
        line2Height: Math.round(r2.height * 100) / 100,
        containerWidth: Math.round(
          line1.parentElement.parentElement.getBoundingClientRect().width * 100
        ) / 100,
        letterSpacing: s1.letterSpacing,
        fontWeight: s1.fontWeight,
        wrapsLine1: r1.height > parseFloat(s1.fontSize) * 1.5,
        wrapsLine2: r2.height > parseFloat(s2.fontSize) * 1.5,
      };
    });

    console.log(`\n=== ${name} ===`);
    console.log(JSON.stringify(result, null, 2));
    await context.close();
  });
}

const { test, devices } = require("@playwright/test");

const SITE = "https://rooindustries.com";

const phones = [
  { name: "iPhone_SE_375", config: devices["iPhone SE"] },
  { name: "iPhone_14_390", config: devices["iPhone 14"] },
  { name: "iPhone_14_ProMax_430", config: devices["iPhone 14 Pro Max"] },
  { name: "Pixel_7_412", config: devices["Pixel 7"] },
  { name: "Galaxy_S9_360", config: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 3 } },
  { name: "Desktop_1280", config: { viewport: { width: 1280, height: 800 } } },
];

for (const { name, config } of phones) {
  test(`measure v2 - ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ ...config });
    const page = await context.newPage();
    await page.goto(SITE, { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      if (!h1) return { error: "No h1 found" };
      const spans = h1.querySelectorAll(":scope > span");
      if (spans.length < 2) return { error: "Only " + spans.length + " spans" };

      const line1 = spans[0];
      const line2 = spans[1];
      const s1 = getComputedStyle(line1);
      const s2 = getComputedStyle(line2);

      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;pointer-events:none";
      probe.style.font = s1.fontWeight + " " + s1.fontSize + " " + s1.fontFamily;
      probe.style.letterSpacing = s1.letterSpacing;
      document.body.appendChild(probe);

      probe.textContent = line1.textContent;
      const naturalW1 = probe.getBoundingClientRect().width;

      probe.style.font = s2.fontWeight + " " + s2.fontSize + " " + s2.fontFamily;
      probe.style.letterSpacing = s2.letterSpacing;
      probe.textContent = line2.textContent;
      const naturalW2 = probe.getBoundingClientRect().width;

      document.body.removeChild(probe);

      const containerWidth = line1.parentElement.parentElement.getBoundingClientRect().width;

      return {
        line1Text: line1.textContent,
        line2Text: line2.textContent,
        line1FontSize: s1.fontSize,
        line2FontSize: s2.fontSize,
        naturalWidth1: Math.round(naturalW1 * 100) / 100,
        naturalWidth2: Math.round(naturalW2 * 100) / 100,
        containerWidth: Math.round(containerWidth * 100) / 100,
        line1Fits: naturalW1 <= containerWidth,
        line2Fits: naturalW2 <= containerWidth,
        ratioW2overW1: Math.round((naturalW2 / naturalW1) * 10000) / 10000,
        line1Height: Math.round(line1.getBoundingClientRect().height * 100) / 100,
        line2Height: Math.round(line2.getBoundingClientRect().height * 100) / 100,
      };
    });

    console.log("\n=== " + name + " ===");
    console.log(JSON.stringify(result, null, 2));
    await context.close();
  });
}

const { test, devices } = require("@playwright/test");

const targets = [
  { name: "Galaxy_S9_360", config: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 3, javaScriptEnabled: true } },
  { name: "iPhone_SE_375", config: { ...devices["iPhone SE"], javaScriptEnabled: true } },
  { name: "iPhone_14_390", config: { ...devices["iPhone 14"], javaScriptEnabled: true } },
  { name: "Pixel_7_412", config: { ...devices["Pixel 7"], javaScriptEnabled: true } },
  { name: "iPhone_ProMax_430", config: { ...devices["iPhone 14 Pro Max"], javaScriptEnabled: true } },
  { name: "iPad_Mini_768", config: { ...devices["iPad Mini"], javaScriptEnabled: true } },
  { name: "Desktop_1280", config: { viewport: { width: 1280, height: 800 }, javaScriptEnabled: true } },
  { name: "Desktop_1920", config: { viewport: { width: 1920, height: 1080 }, javaScriptEnabled: true } },
];

for (const { name, config } of targets) {
  test("hero JS - " + name, async ({ browser }) => {
    const ctx = await browser.newContext(config);
    const page = await ctx.newPage();
    await page.goto("/", { waitUntil: "networkidle", timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      if (!h1) return { error: "No h1" };
      const spans = h1.querySelectorAll(":scope > span");
      if (spans.length < 2) return { error: "spans: " + spans.length };

      const l1 = spans[0], l2 = spans[1];
      const s1 = getComputedStyle(l1);
      const s2 = getComputedStyle(l2);
      const r1 = l1.getBoundingClientRect();
      const r2 = l2.getBoundingClientRect();

      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;top:-9999px;visibility:hidden;white-space:nowrap";
      probe.style.font = s1.fontWeight + " " + s1.fontSize + " " + s1.fontFamily;
      probe.style.letterSpacing = s1.letterSpacing;
      document.body.appendChild(probe);
      probe.textContent = l1.textContent;
      const nw1 = probe.getBoundingClientRect().width;
      probe.style.font = s2.fontWeight + " " + s2.fontSize + " " + s2.fontFamily;
      probe.style.letterSpacing = s2.letterSpacing;
      probe.textContent = l2.textContent;
      const nw2 = probe.getBoundingClientRect().width;
      document.body.removeChild(probe);

      return {
        fs1: s1.fontSize, fs2: s2.fontSize,
        inlineFS1: l1.style.fontSize || "(none)",
        inlineFS2: l2.style.fontSize || "(none)",
        nw1: Math.round(nw1 * 10) / 10,
        nw2: Math.round(nw2 * 10) / 10,
        h1: Math.round(r1.height * 10) / 10,
        h2: Math.round(r2.height * 10) / 10,
        wraps1: r1.height > parseFloat(s1.fontSize) * 1.5,
        wraps2: r2.height > parseFloat(s2.fontSize) * 1.5,
        container: Math.round(l1.parentElement.parentElement.getBoundingClientRect().width * 10) / 10,
      };
    });

    console.log("\n=== " + name + " ===");
    console.log(JSON.stringify(r, null, 2));
    await ctx.close();
  });
}

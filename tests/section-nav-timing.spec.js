const { test, expect } = require("./fixtures/booking-flow.cjs");
const { waitForTargetSettle, waitForHash } = require("./fixtures/section-nav.cjs");

test.use({ javaScriptEnabled: true });

test("hash timing stays in the browser while the controller is busy", async ({ page }, testInfo) => {
  await page.setContent("<h1>Hash timing fixture</h1>");
  await page.evaluate(() => { setTimeout(() => { window.location.hash = "target"; }, 100); });
  const pending = waitForHash(page, "#target", 500);
  await page.evaluate(() => true);
  const busyUntil = Date.now() + 800;
  while (Date.now() < busyUntil) {}
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.latencyMs).toBeLessThanOrEqual(500);
  expect(new URL(page.url()).hash).toBe("#target");
  await testInfo.attach("browser-hash-timing", { body: JSON.stringify(result), contentType: "application/json" });
});

test("hash timing still refuses an unchanged URL", async ({ page }, testInfo) => {
  await page.setContent("<h1>Unchanged hash fixture</h1>");
  const result = await waitForHash(page, "#missing", 500);
  expect(result.ok).toBe(false);
  expect(result.latencyMs).toBeGreaterThanOrEqual(500);
  await testInfo.attach("refused-hash-change", { body: JSON.stringify(result), contentType: "application/json" });
});

test("scroll timing stays in the browser while the controller is busy", async ({ page }, testInfo) => {
  await page.setContent('<section id="target" style="position:fixed;top:108px">Fixture target</section>');
  await page.evaluate(() => {
    const target = document.querySelector("#target");
    const measure = target.getBoundingClientRect.bind(target);
    target.getBoundingClientRect = () => { window.samplingStarted = true; return measure(); };
  });
  const pending = waitForTargetSettle(page, "#target", 500, 140);
  await page.waitForFunction(() => window.samplingStarted);
  const busyUntil = Date.now() + 800;
  while (Date.now() < busyUntil) {}
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.timeToTargetMs).toBeLessThanOrEqual(500);
  expect(result.top).toBe(108);
  await testInfo.attach("browser-scroll-timing", { body: JSON.stringify(result), contentType: "application/json" });
});

for (const scenario of ["missing", "outside", "moving", "late"]) {
  test(`scroll timing refuses a ${scenario} target`, async ({ page }, testInfo) => {
    await page.setContent('<section id="target" style="position:fixed;top:108px">Fixture target</section>');
    await page.evaluate(scenario => {
      const target = document.querySelector("#target");
      if (scenario === "missing") target.remove();
      if (scenario === "outside" || scenario === "late") target.style.top = "400px";
      if (scenario === "late") setTimeout(() => { target.style.top = "108px"; }, 1500);
      if (scenario === "moving") setInterval(() => { target.style.top = target.style.top === "108px" ? "128px" : "108px"; }, 50);
    }, scenario);
    const result = await waitForTargetSettle(page, "#target", 500, 140);
    expect(result.ok).toBe(false);
    expect(result.timeToTargetMs).toBeGreaterThanOrEqual(500);
    await testInfo.attach("refused-scroll-target", { body: JSON.stringify({ scenario, ...result }), contentType: "application/json" });
  });
}

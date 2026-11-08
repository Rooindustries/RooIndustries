const { test, expect } = require("@playwright/test");
const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { sampleScrollAfterClick, scrollPath } = require("./fixtures/button-scroll.cjs");
const { waitForRouteCommitted, waitForHydrated } = require("./fixtures/react-hydration.cjs");

test.use({ javaScriptEnabled: true, viewport: { width: 1536, height: 960 } });

test("a question link cancels an interrupted FAQ pagination scroll", async ({ page, context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForRouteCommitted(page);
  await waitForHydrated(page, "#faq .ri-faq-question button");
  const result = await evaluateBrowserTask(page, () => new Promise((resolve) => {
    const firstPageId = document.querySelector("#faq .ri-faq-question").id;
    const next = [...document.querySelectorAll("#faq button")].find((button) => button.textContent === "Next");
    let secondPageId;
    let interrupted = false;
    let returned = false;
    let settled = false;
    let stableFrames = 0;
    let lastLayout;
    const calls = [];
    const scrollTo = window.scrollTo;
    window.scrollTo = function (...args) {
      if (args[0]?.behavior === "smooth") calls.push(args[0].top);
      return scrollTo.apply(this, args);
    };
    const onSettled = (event) => {
      if (returned && event.detail.hash === `#${secondPageId}`) settled = true;
    };
    window.addEventListener("roo:section-align-settled", onSettled);
    const sample = () => {
      const question = document.querySelector("#faq .ri-faq-question");
      const style = getComputedStyle(question.parentElement);
      if (!interrupted && question.id !== firstPageId && Number(style.opacity) < 1) {
        secondPageId = question.id;
        interrupted = true;
        window.location.hash = firstPageId;
      } else if (interrupted && !returned && question.id === firstPageId && style.opacity === "1") {
        returned = true;
        window.location.hash = secondPageId;
      }
      const layout = JSON.stringify([question.id, style.transform, style.opacity, style.filter,
        question.getBoundingClientRect().top, window.scrollY]);
      stableFrames = settled && layout === lastLayout ? stableFrames + 1 : 0;
      lastLayout = layout;
      if (stableFrames < 10) {
        requestAnimationFrame(sample);
        return;
      }
      window.scrollTo = scrollTo;
      window.removeEventListener("roo:section-align-settled", onSettled);
      const headerOffset = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--section-nav-offset")) + 12;
      const top = question.getBoundingClientRect().top;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const expectedTop = Math.max(headerOffset, top + window.scrollY - maxScroll);
      resolve({ calls, interrupted, returned, hash: window.location.hash, secondPageId,
        offset: top - expectedTop });
    };
    next.click();
    requestAnimationFrame(sample);
  }));
  expect(result.interrupted, "question link interrupts the new FAQ page before it finishes entering").toBe(true);
  expect(result.returned, "another question link returns to the interrupted FAQ page").toBe(true);
  expect(result.hash).toBe(`#${result.secondPageId}`);
  expect(result.calls, "question links never restart the canceled pagination scroll").toEqual([]);
  expect(Math.abs(result.offset), "the linked question stays below the header").toBeLessThanOrEqual(2);
});

test("FAQ scroll sampling finishes when pagination moves 0 px", async ({ page, context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForRouteCommitted(page);
  await waitForHydrated(page, "#faq .ri-faq-question button");
  await page.evaluate(() => {
    const scrollTo = window.scrollTo;
    window.scrollTo = function (...args) {
      if (args[0]?.behavior !== "smooth") return scrollTo.apply(this, args);
    };
  });
  const path = scrollPath(await sampleScrollAfterClick(page, { scope: "#faq", text: "Next", from: "top" }));
  expect(path.distance, `FAQ Next moved ${path.distance} px`).toBe(0);
});

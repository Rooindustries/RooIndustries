const { test, expect } = require("@playwright/test");
const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { sampleScrollAfterClick, scrollPath } = require("./fixtures/button-scroll.cjs");
const { navLink } = require("./fixtures/nav-link.cjs");
const { waitForRouteCommitted, waitForHydrated } = require("./fixtures/react-hydration.cjs");

test.use({ javaScriptEnabled: true, viewport: { width: 1536, height: 960 } });

test.beforeEach(async ({ page, context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
});

for (const { label, target, initialHash = "" } of [
  { label: "a question link cancels an interrupted FAQ pagination scroll", target: "previous-question" },
  { label: "a question link on the entering FAQ page cancels its pagination scroll", target: "entering-question" },
  { label: "a section link cancels an interrupted FAQ pagination scroll", target: "packages" },
  { label: "a repeated section link cancels an interrupted FAQ pagination scroll", target: "packages",
    initialHash: "#packages" },
]) {
  test(label, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`/${initialHash}`, { waitUntil: "domcontentloaded" });
    await waitForRouteCommitted(page);
    await waitForHydrated(page, "#faq .ri-faq-question button");
    const packagesLink = navLink("plans");
    await waitForHydrated(page, packagesLink);
    const result = await evaluateBrowserTask(page, ({ target, packagesLink }) => new Promise((resolve, reject) => {
      const firstPageId = document.querySelector("#faq .ri-faq-question").id;
      const next = [...document.querySelectorAll("#faq button")].find((button) => button.textContent === "Next");
      let secondPageId;
      let targetId;
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
        if (returned && event.detail.hash === `#${targetId}`) settled = true;
      };
      const cleanup = () => {
        window.scrollTo = scrollTo;
        window.removeEventListener("roo:section-align-settled", onSettled);
      };
      const clickQuestionLink = (id) => {
        const link = document.createElement("a");
        link.href = `#${id}`;
        link.click();
      };
      window.addEventListener("roo:section-align-settled", onSettled);
      const sample = () => {
        const question = document.querySelector("#faq .ri-faq-question");
        const style = getComputedStyle(question.parentElement);
        const entering = Number(style.opacity) < 1 || !new DOMMatrixReadOnly(style.transform).isIdentity;
        if (!interrupted && question.id !== firstPageId) {
          if (!entering) {
            cleanup();
            reject(new Error("The next FAQ page finished entering before the link could interrupt it"));
            return;
          }
          secondPageId = question.id;
          interrupted = true;
          targetId = target === "packages" ? "packages" : secondPageId;
          returned = target !== "previous-question";
          if (target === "packages") {
            document.querySelector(packagesLink).click();
          } else {
            clickQuestionLink(returned ? secondPageId : firstPageId);
          }
        } else if (interrupted && !returned && question.id === firstPageId && style.opacity === "1") {
          returned = true;
          clickQuestionLink(secondPageId);
        }
        const destination = document.getElementById(targetId);
        const layout = JSON.stringify([question.id, style.transform, style.opacity, style.filter,
          destination?.getBoundingClientRect().top, window.scrollY]);
        stableFrames = settled && layout === lastLayout ? stableFrames + 1 : 0;
        lastLayout = layout;
        if (stableFrames < 10) {
          requestAnimationFrame(sample);
          return;
        }
        cleanup();
        const headerOffset = Number.parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue("--section-nav-offset")) + 12;
        const top = destination.getBoundingClientRect().top;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const expectedTop = Math.max(headerOffset, top + window.scrollY - maxScroll);
        resolve({ calls, interrupted, returned, hash: window.location.hash, targetId,
          offset: top - expectedTop });
      };
      next.click();
      requestAnimationFrame(sample);
    }), { target, packagesLink });
    await page.screenshot({ path: testInfo.outputPath("linked-destination.png") });
    expect(result.interrupted, "the link interrupts the new FAQ page before it finishes entering").toBe(true);
    expect(result.returned, "navigation reaches the requested destination").toBe(true);
    expect(result.hash).toBe(`#${result.targetId}`);
    expect(result.calls, "links never restart the canceled pagination scroll").toEqual([]);
    expect(Math.abs(result.offset), "the linked destination stays below the header").toBeLessThanOrEqual(2);
  });
}

test("FAQ scroll sampling finishes when pagination moves 0 px", async ({ page }) => {
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

const FAQ_NEXT = { scope: "#faq", text: "Next", from: "top" };
const FAQ_PREVIOUS = { scope: "#faq", text: "Previous", from: "top" };
const BACK_TO_TOP = { scope: "footer", text: "To the top", from: "bottom" };

const SCROLL_BUTTONS = [
  { label: "FAQ Next", button: FAQ_NEXT },
  { label: "FAQ Previous", button: FAQ_PREVIOUS },
  { label: "footer back to top", button: BACK_TO_TOP },
];

for (const width of [1440, 390]) {
  test.describe(`reduced motion on button scrolls at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 960 } });

    test("FAQ paging and back to top jump without animating", async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      for (const { label, button } of SCROLL_BUTTONS) {
        const path = scrollPath(await sampleScrollAfterClick(page, button));
        expect(path.distance, `${label} moved ${path.distance} px`).toBeGreaterThan(300);
        await page.screenshot({ path: testInfo.outputPath(`${label.replaceAll(" ", "-")}.png`) });
        expect(Math.abs(path.offset), `${label} reaches its destination`).toBeLessThanOrEqual(2);
        expect(path.inBetween, `${label} has no animated in-between positions`).toEqual([]);
      }
    });

    test("FAQ paging and back to top still glide without a reduced-motion preference", async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      for (const { label, button } of SCROLL_BUTTONS) {
        const path = scrollPath(await sampleScrollAfterClick(page, button));
        expect(path.distance, `${label} moved ${path.distance} px`).toBeGreaterThan(300);
        await page.screenshot({ path: testInfo.outputPath(`${label.replaceAll(" ", "-")}.png`) });
        expect(Math.abs(path.offset), `${label} reaches its destination`).toBeLessThanOrEqual(2);
        expect(path.inBetween.length, `${label} glides through in-between positions`).toBeGreaterThan(1);
      }
    });
  });
}

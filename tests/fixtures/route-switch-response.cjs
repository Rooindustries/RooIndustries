const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("@playwright/test");
const { holdChunks, holdRoute } = require("./held-routes.cjs");
const { waitForHydrated } = require("./react-hydration.cjs");
const { declineCookies } = require("./booking-flow.cjs");

const homeData = [
  "reviews", "about", "services", "packages-list", "packages-settings", "how-it-works",
  "supported-games", "faq-settings", "faq-questions",
];

const targets = {
  home: { marker: "deferred-section-content", route: "/", data: homeData },
  benchmarks: { marker: "Performance Benchmarks", route: "/benchmarks", data: ["benchmarks"] },
  reviews: { marker: "Community Reviews", route: "/reviews", data: ["reviews-gallery"] },
  register: { marker: "Referral Creator Registration", route: "/referrals/register", data: [] },
  login: { marker: "Referral Creator Login", route: "/referrals/login", data: [] },
};

const matches = (body, marker) => body.toString().startsWith('"use strict";') && body.includes(marker);

const holdTarget = async (page, baseURL, target, distDir) => {
  const details = targets[target];
  const chunkDir = path.join(distDir, "static/chunks");
  const chunks = fs.readdirSync(chunkDir, { recursive: true }).filter(file => file.endsWith(".js"));
  const found = chunks.filter(file => matches(fs.readFileSync(path.join(chunkDir, file)), details.marker));
  expect(found, `unique lazy chunk for ${target}`).toHaveLength(1);
  const chunk = await holdChunks(page, { origin: baseURL }, body => matches(body, details.marker));
  const data = [];
  for (const key of details.data) {
    data.push(await holdRoute(page, `**/api/content/${key}`, route => route.continue()));
  }
  return {
    chunk,
    release: () => {
      chunk.release();
      for (const hold of data) hold.release();
    },
    finished: () => page.waitForResponse(response => response.url().endsWith(`/static/chunks/${found[0]}`)),
  };
};

const installMeasurement = page => page.addInitScript(() => {
  window.routeSwitchMeasurement = null;
  document.addEventListener("click", () => {
    const state = window.routeSwitchMeasurement;
    if (!state || state.clicked !== null) return;
    state.clicked = performance.now();
    const observe = () => {
      if (document.querySelector(state.heading)) state.mounted = true;
    };
    new MutationObserver(observe).observe(document.documentElement, { childList: true, subtree: true });
    const frame = () => {
      const now = performance.now();
      const bar = document.querySelector('[role="progressbar"][aria-label="Loading page"]');
      const style = bar && getComputedStyle(bar);
      const heading = document.querySelector(state.heading);
      const visible = element => element && element.getBoundingClientRect().width > 0 &&
        element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden";
      if (state.response === null && ((visible(bar) && Number(style.opacity) >= 0.5) || visible(heading))) {
        state.response = now - state.clicked;
      }
      if (now - state.clicked >= 300) state.measured = true;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, true);
});

const armMeasurement = (page, target) => page.evaluate(route => {
  window.routeSwitchMeasurement = {
    clicked: null, response: null, measured: false, mounted: false,
    heading: `#main-content [data-route-key="${route}"] h1`,
  };
}, targets[target].route);

const openPage = async (page, route) => {
  await page.goto(route);
  await waitForHydrated(page, 'button[aria-label="Open menu"]');
  await declineCookies(page);
};

const proofClick = async (page, label, mobile = false) => {
  if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
  const surface = mobile ? "mobile" : "desktop";
  await page.locator(`button[aria-controls="${surface}-proof-menu"]`).click();
  await page.locator(`#${surface}-proof-menu`).getByRole("link", { name: label, exact: true }).click();
};

module.exports = { targets, holdTarget, installMeasurement, armMeasurement, openPage, proofClick };

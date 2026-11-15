const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("@playwright/test");
const { holdChunks, holdRoute, inspectChunks } = require("./held-routes.cjs");
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
  team: { marker: "showFounder", route: "/meet-the-team", data: ["team"] },
  tools: { marker: "All Tools & Utilities", route: "/tools", data: ["tools"] },
  about: { marker: "About Roo Industries", route: "/about", data: ["about"] },
  privacy: { marker: 'contentKey:"privacy-policy"', route: "/privacy", data: ["privacy-policy"] },
  terms: { marker: 'contentKey:"terms"', route: "/terms", data: ["terms"] },
  packages: {
    marker: "PC Game Optimization Packages", route: "/packages", heading: "h2",
    data: ["packages-list", "packages-settings"],
  },
  contact: { marker: "Get In Touch", route: "/contact", data: ["contact"] },
  booking: {
    marker: "Schedule Your Session", route: "/booking", data: ["package"], api: ["bookingAvailability"],
    selector: '[role="dialog"][aria-label="Schedule your session"] h2',
  },
};

const matches = (body, marker) => body.toString().startsWith('"use strict";') && body.includes(marker);

const findChunk = (target, distDir) => {
  const details = targets[target];
  const chunkDir = path.join(distDir, "static/chunks");
  const chunks = fs.readdirSync(chunkDir, { recursive: true }).filter(file => file.endsWith(".js"));
  const found = chunks.filter(file => matches(fs.readFileSync(path.join(chunkDir, file)), details.marker));
  expect(found, `unique lazy chunk for ${target}`).toHaveLength(1);
  return found[0];
};

const holdData = async (page, details) => {
  const data = [];
  for (const key of details.data) {
    data.push(await holdRoute(page, new RegExp(`/api/content/${key}(?:\\?|$)`), route => route.continue()));
  }
  for (const key of details.api || []) {
    data.push(await holdRoute(page, new RegExp(`/api/${key}(?:\\?|$)`), route => route.continue()));
  }
  return data;
};

const requestFinished = (page, chunk) => page.waitForEvent("requestfinished", {
  predicate: request => request.url().endsWith(`/static/chunks/${chunk}`),
});

const holdTarget = async (page, baseURL, target, distDir) => {
  const details = targets[target];
  const found = findChunk(target, distDir);
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const chunk = await holdChunks(page, { origin: baseURL }, body => {
    const match = matches(body, details.marker);
    if (match) reached();
    return match;
  });
  const data = await holdData(page, details);
  return {
    chunk,
    waiting,
    release: () => {
      chunk.release();
      for (const hold of data) hold.release();
    },
    finished: () => requestFinished(page, found),
  };
};

const holdTargets = async (page, baseURL, names, distDir) => {
  const holds = {};
  for (const name of names) {
    const file = findChunk(name, distDir);
    const state = { held: false };
    const waiting = new Promise(resolve => { state.reached = resolve; });
    const gate = new Promise(resolve => { state.release = resolve; });
    const data = await holdData(page, targets[name]);
    holds[name] = {
      chunk: state, waiting, gate,
      release: () => { state.release(); for (const hold of data) hold.release(); },
      finished: () => requestFinished(page, file),
    };
  }
  await inspectChunks(page, { origin: baseURL }, body => {
    for (const name of names) {
      if (matches(body, targets[name].marker)) {
        holds[name].chunk.held = true;
        holds[name].chunk.reached();
        return holds[name].gate;
      }
    }
    return undefined;
  });
  return holds;
};

const installMeasurement = page => page.addInitScript(() => {
  window.routeSwitchMeasurement = null;
  document.addEventListener("click", () => {
    const state = window.routeSwitchMeasurement;
    if (!state || state.clicked !== null) return;
    state.clicked = performance.now();
    const observe = () => {
      if (document.querySelector(state.heading)) state.mounted = true;
      const headings = [...document.querySelectorAll("h1, h2")];
      if (headings.some(node => /we couldn.t load this page/i.test(node.textContent))) {
        state.error = true;
      }
    };
    new MutationObserver(observe).observe(document.documentElement, { childList: true, subtree: true });
    const frame = () => {
      const now = performance.now();
      const bar = document.querySelector('[role="progressbar"][aria-label="Loading page"]');
      const style = bar && getComputedStyle(bar);
      const heading = document.querySelector(state.heading);
      const visible = element => {
        if (!element || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
          box.right > 0 && box.left < innerWidth;
      };
      if (state.response === null && ((visible(bar) && Number(style.opacity) >= 0.5) || visible(heading))) {
        state.response = now - state.clicked;
      }
      if (now - state.clicked >= 300) state.measured = true;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, true);
});

const armMeasurement = (page, target) => page.evaluate(({ route, heading, selector }) => {
  window.routeSwitchMeasurement = {
    clicked: null, response: null, measured: false, mounted: false, error: false,
    heading: selector || `#main-content [data-route-key="${route}"] ${heading || "h1"}`,
  };
}, targets[target]);

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

const finishSuperseded = async (page, held, second, heading = "h1") => {
  await expect(page).toHaveURL(new RegExp(`${second}$`));
  await expect(page.locator(`#main-content [data-route-key="${second}"] ${heading}`).first()).toBeVisible();
  const finished = held.finished();
  held.release();
  await finished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => window.routeSwitchMeasurement);
  expect(result.mounted, "the superseded page never mounted").toBe(false);
  expect(result.error, "the error heading never appeared").toBe(false);
  await expect(page).toHaveURL(new RegExp(`${second}$`));
  await expect(page.locator(`#main-content [data-route-key="${second}"] ${heading}`).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /We couldn.t load this page/ })).toHaveCount(0);
  expect(result.response, "a response is visible within 300 ms").not.toBeNull();
  expect(result.response, "a response is visible within 300 ms").toBeLessThanOrEqual(300);
};

const openBooking = async page => {
  const availability = { fail: false };
  await page.route("**/api/bookingAvailability", route => route.fulfill(availability.fail
    ? { status: 503, json: { ok: false } }
    : { json: { settings: { dateSlots: [] }, bookedSlots: [] } }));
  await page.route("**/api/content/package?*", route => route.fulfill({
    json: { ok: true, data: { title: "Performance Vertex Overhaul", price: "$84.99",
      features: ["Future Upgrade Path"] } },
  }));
  await openPage(page, "/packages");
  await page.locator(".ri-package-book-button").first().click();
  await expect(page.getByRole("button", { name: "View My Plan" })).toBeVisible();
  return availability;
};

const watchBar = page => page.evaluate(() => {
  window.routeBarWatch = { running: true, seen: false };
  const frame = () => {
    const state = window.routeBarWatch;
    if (!state.running) return;
    const bar = document.querySelector('[role="progressbar"][aria-label="Loading page"]');
    if (bar && bar.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        Number(getComputedStyle(bar).opacity) >= 0.5) state.seen = true;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});

const barWasSeen = page => page.evaluate(() => new Promise(resolve => {
  const start = performance.now();
  const frame = now => {
    if (now - start < 300) return requestAnimationFrame(frame);
    window.routeBarWatch.running = false;
    resolve(window.routeBarWatch.seen);
  };
  requestAnimationFrame(frame);
}));

module.exports = {
  targets, holdTarget, holdTargets, installMeasurement, armMeasurement, openPage, proofClick, finishSuperseded,
  openBooking,
  watchBar, barWasSeen,
};

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { expect, test } = require("@playwright/test");
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
  if (!test.info().config.metadata.ownsToolingServer && !process.env.NEXT_DIST_DIR) {
    throw new Error("BASE_URL is set, so NEXT_DIST_DIR must name the build that BASE_URL serves.");
  }
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

const installMeasurement = async page => {
  await page.addInitScript(() => {
    window.routeSwitchMeasurement = null;
    const barSelector = '[role="progressbar"][aria-label="Loading page"]';
    const visible = (element, opacityProperty) => {
      if (!element || !element.checkVisibility({ opacityProperty, visibilityProperty: true })) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
        box.right > 0 && box.left < innerWidth;
    };
    document.addEventListener("click", () => {
      const state = window.routeSwitchMeasurement;
      if (!state || state.clicked !== null) return;
      state.clicked = performance.now();
      const fades = [];
      let loading = null;
      const capture = bar => {
        for (const animation of bar.getAnimations()) {
          if (animation.transitionProperty !== "opacity" || fades.some(fade => fade.animation === animation)) continue;
          fades.push({
            animation, anchor: loading, ended: null, keyframes: animation.effect.getKeyframes(),
            timing: animation.effect.getComputedTiming(), rate: animation.playbackRate,
          });
        }
      };
      const track = () => {
        const bar = document.querySelector(barSelector);
        if (bar && loading === null) loading = performance.now();
        if (!bar && loading !== null) {
          for (const fade of fades) fade.ended ??= performance.now();
          loading = null;
        }
        if (bar) capture(bar);
      };
      const crossing = fade => {
        const [from, to] = fade.keyframes;
        const low = Number(from.opacity);
        const high = Number(to.opacity);
        if (fade.anchor === null || high < 0.5) return null;
        if (fade.timing.easing !== "linear" || from.easing !== "linear") {
          state.timingError = `the bar's fade easing is ${from.easing}, the reading needs linear`;
          return null;
        }
        const progress = low >= 0.5 ? 0 : (0.5 - low) / (high - low);
        const at = fade.anchor + (low >= 0.5 ? 0 : (fade.timing.delay + progress * fade.timing.duration) / fade.rate);
        return fade.ended === null || fade.ended > at ? at : null;
      };
      const observe = () => {
        if (document.querySelector(state.heading)) state.mounted = true;
        const headings = [...document.querySelectorAll("h1, h2")];
        if (headings.some(node => /we couldn.t load this page/i.test(node.textContent))) {
          state.error = true;
        }
        track();
      };
      new MutationObserver(observe).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "role"],
      });
      document.addEventListener("transitionrun", event => {
        if (event.propertyName === "opacity" && event.target.matches(barSelector)) capture(event.target);
      }, true);
      track();
      window.routeSwitchSettle = () => {
        const bar = document.querySelector(barSelector);
        if (bar) capture(bar);
        const crossings = fades.map(crossing).filter(at => at !== null);
        const barAt = visible(bar, false) && crossings.length ? Math.min(...crossings) - state.clicked : null;
        if (barAt !== null && (state.headingAt === null || barAt <= state.headingAt)) {
          state.response = barAt;
          state.responseKind = "bar";
        } else if (state.headingAt !== null) {
          state.response = state.headingAt;
          state.responseKind = "heading";
        }
        return state;
      };
      const frame = () => {
        const now = performance.now();
        if (state.headingAt === null && visible(document.querySelector(state.heading), true)) {
          state.headingAt = now - state.clicked;
        }
        if (now - state.clicked >= 300) {
          state.measured = true;
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, true);
  });
};

const armMeasurement = async (page, target) => {
  await page.evaluate(({ route, heading, selector }) => {
    window.routeSwitchMeasurement = {
      clicked: null, response: null, responseKind: null, pixels: null, headingAt: null,
      timingError: null, measured: false, mounted: false, error: false,
      heading: selector || `#main-content [data-route-key="${route}"] ${heading || "h1"}`,
    };
  }, targets[target]);
};

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

const segmentPositions = [0.26, 0.5, 0.74];

const segmentAt = (page, position) => page.evaluate(async position => {
  const bar = document.querySelector('[role="progressbar"][aria-label="Loading page"]');
  if (!bar || bar.dataset.state !== "loading") return null;
  await Promise.all(bar.getAnimations().map(animation => animation.finished));
  const segment = bar.firstElementChild;
  segment.style.animation = "";
  segment.style.transform = "";
  for (const animation of segment.getAnimations()) {
    animation.pause();
    animation.currentTime = position * animation.effect.getComputedTiming().duration;
  }
  segment.style.transform = getComputedStyle(segment).transform;
  segment.style.animation = "none";
  window.routeSwitchSegment = segment;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = segment.getBoundingClientRect();
  return {
    left: Math.max(0, Math.ceil(box.left) + 1), right: Math.min(innerWidth, Math.floor(box.right) - 1),
    rows: Math.floor(box.height), width: innerWidth, color: getComputedStyle(segment).backgroundColor,
  };
}, position);

const segmentPainted = async (page, position) => {
  const segment = await segmentAt(page, position);
  if (!segment) return `the bar is not loading at ${position}`;
  const color = segment.color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (!color) throw new Error(`Unexpected accent color: ${segment.color}`);
  const rgb = color.slice(1).map(Number);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: segment.width, height: segment.rows }, scale: "css" });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (segment.right - segment.left < 10) return `the segment is under 10 px at ${position}`;
  for (let row = 0; row < info.height; row += 1) {
    for (let column = segment.left; column < segment.right; column += 1) {
      const offset = (row * info.width + column) * 3;
      const pixel = [...data.subarray(offset, offset + 3)];
      if (!rgb.every((channel, index) => Math.abs(channel - pixel[index]) <= 8)) {
        const shown = await page.evaluate(() => window.routeSwitchSegment.isConnected ? "the bar" : "a new bar");
        return `pixel ${column},${row} is rgb(${pixel.join(", ")}), not ${segment.color}, at ${position} on ${shown}`;
      }
    }
  }
  return true;
};

const measuredResponse = async page => {
  await page.waitForFunction(() => window.routeSwitchMeasurement.measured);
  const state = await page.evaluate(() => window.routeSwitchSettle());
  const response = state.response === null ? "none" : String(Math.round(state.response));
  test.info().annotations.push({ type: "route switch response", description: response });
  if (state.responseKind !== "bar") return;
  let pixels = true;
  for (const position of segmentPositions) {
    if (pixels === true) pixels = await segmentPainted(page, position);
  }
  await page.evaluate(pixels => {
    window.routeSwitchMeasurement.pixels = pixels;
    const segment = document.querySelector(".route-progress-segment");
    segment.style.animation = "";
    segment.style.transform = "";
  }, pixels);
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
  if (result.responseKind === "bar") {
    expect(result.pixels, "the accent segment is visible on screen").toBe(true);
  }
  expect(result.timingError, "the bar's fade can be read").toBeNull();
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
  openBooking, measuredResponse,
  watchBar, barWasSeen,
};

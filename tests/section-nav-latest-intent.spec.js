const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { test, expect } = require("@playwright/test");
const { navLink } = require("./fixtures/nav-link.cjs");
const { clickAtHomeArrival } = require("./fixtures/home-arrival-click.cjs");
const { clickAtRouteCommit: clickAtCommit } = require("./fixtures/route-commit-click.cjs");
const { waitForHydrated, waitForRouteCommitted } = require("./fixtures/react-hydration.cjs");

const CPU_THROTTLE_RATE = Number(process.env.NAV_CPU_THROTTLE_RATE || 4);
const FINAL_OFFSET_MAX = 160;

const SECTIONS = {
  benefits: "#services",
  faq: "#faq",
  plans: "#packages",
  howItWorks: "#how-it-works",
};

const PAIRS = [
  ["benefits", "faq"],
  ["faq", "plans"],
  ["plans", "benefits"],
];

test.use({ javaScriptEnabled: true });
test.describe.configure({ mode: "default" });

test.beforeEach(async ({ context, page, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
});

const waitForLinks = async (page, ...links) => {
  await waitForRouteCommitted(page);
  for (const { selector } of links) await waitForHydrated(page, selector);
};

const openPage = async (page, route, surface) => {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  const selector =
    surface === "mobile"
      ? 'button[aria-label="Open menu"]'
      : '[data-nav-surface="desktop"][data-nav-target="faq"]';
  await waitForLinks(page, { selector });
};

const clickSection = async (page, target, surface) => {
  const selector = surface === "mobile"
    ? `[data-nav-surface="mobile"][data-nav-target="${target}"]`
    : navLink(target);
  const link = page.locator(selector).first();
  if (surface !== "mobile") {
    await waitForLinks(page, { selector });
    await link.click();
    return;
  }
  const menuButton = page.locator('button[aria-label="Open menu"]');
  await expect(async () => {
    if ((await menuButton.getAttribute("aria-expanded")) !== "true") await menuButton.click();
    await waitForLinks(page, { selector });
    await link.click({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
};

const readLanding = (page) =>
  page.evaluate(
    ({ hashes, maxOffset }) => {
      const onTop = hashes.find((hash) => {
        const element = document.querySelector(hash);
        return element && Math.abs(element.getBoundingClientRect().top) <= maxOffset;
      });
      return { path: window.location.pathname, hash: window.location.hash, onTop: onTop || "none" };
    },
    { hashes: Object.values(SECTIONS), maxOffset: FINAL_OFFSET_MAX }
  );

const expectLanded = async (page, hash, label) => {
  const landed = { path: "/", hash, onTop: hash };
  await expect
    .poll(() => readLanding(page).catch(() => null), {
      message: `${label} lands on ${hash}`, timeout: 8000, intervals: [100],
    })
    .toEqual(landed);
  await page.waitForTimeout(1500);
  expect(await readLanding(page), `${label} stays on ${hash}`).toEqual(landed);
};

const readHomeSectionState = (page) => page.evaluate(() => ({
  length: window.history.length,
  search: window.location.search,
  hash: window.location.hash,
  state: window.history.state?.usr ?? null,
  active: [...new Set([...document.querySelectorAll('[data-nav-target][aria-current="location"]')]
    .map((link) => link.dataset.navTarget))],
}));

const clickSettledSection = async (page, target, surface) => {
  await page.evaluate((hash) => {
    window.__sectionClickSettled = false;
    const onSettled = (event) => {
      if (event.detail.hash !== hash) return;
      window.removeEventListener("roo:section-align-settled", onSettled);
      window.__sectionClickSettled = true;
    };
    window.addEventListener("roo:section-align-settled", onSettled);
  }, SECTIONS[target]);
  await clickSection(page, target, surface);
  await expect.poll(() => page.evaluate(() => window.__sectionClickSettled)).toBe(true);
};

for (const surface of ["desktop", "mobile"]) {
  const viewport = surface === "mobile" ? { width: 390, height: 844 } : { width: 1536, height: 960 };

  for (const origin of ["/reviews", "/"]) {
    test(`latest section click wins from ${origin} on ${surface}`, async ({ page }) => {
      test.setTimeout(180000);
      await page.setViewportSize(viewport);
      for (const [first, second] of PAIRS) {
        const label = `${origin} ${surface} ${first} then ${second}`;
        await openPage(page, origin, surface);
        await clickSection(page, first, surface);
        await page.waitForTimeout(10);
        await clickSection(page, second, surface);
        await expectLanded(page, SECTIONS[second], label);

        if (origin !== "/") {
          await page.goBack();
          await expect.poll(() => new URL(page.url()).pathname, { message: `${label} back` }).toBe(origin);
          await page.goForward();
          await expectLanded(page, SECTIONS[second], `${label} forward`);
        }
      }
    });
  }
}

const NAVBAR = (target) => ({ selector: `[data-nav-surface="desktop"][data-nav-target="${target}"]` });
const ON_PAGE = (hash, text = "") => ({ selector: `#main-content a[href="/${hash}"]`, text });

const clickInQuickSuccession = async (page, first, second, gapMs = 10) => {
  await waitForLinks(page, first);
  return evaluateBrowserTask(
    page,
    ([firstLink, secondLink, gap]) =>
      new Promise((resolve, reject) => {
        const find = ({ selector, text }) =>
          [...document.querySelectorAll(selector)].find((element) => !text || element.textContent.includes(text));
        const firstElement = find(firstLink);
        if (!firstElement) {
          reject(new Error(`Missing ${firstLink.selector}`));
          return;
        }
        firstElement.click();
        const clickedAt = performance.now();
        const clickSecond = () => {
          const secondElement = find(secondLink);
          const hydrated = secondElement && Object.keys(secondElement).some(key => key.startsWith("__reactProps$"));
          if (hydrated && performance.now() - clickedAt >= gap) {
            secondElement.click();
            resolve();
            return;
          }
          if (performance.now() - clickedAt > 15000) {
            reject(new Error(`Missing ${secondLink.selector}`));
            return;
          }
          requestAnimationFrame(clickSecond);
        };
        requestAnimationFrame(clickSecond);
      }),
    [first, second, gapMs]
  );
};

const HOME_MIXED_ORDERS = [
  { label: "on-page packages then navbar FAQ", first: ON_PAGE("#packages"), second: NAVBAR("faq"), hash: "#faq" },
  {
    label: "navbar FAQ then on-page how it works",
    first: NAVBAR("faq"), second: ON_PAGE("#how-it-works"), hash: "#how-it-works",
  },
  {
    label: "on-page how it works then on-page Tune My PC",
    first: ON_PAGE("#how-it-works"),
    second: ON_PAGE("#packages", "Tune My PC"),
    hash: "#packages",
  },
];

test("latest click wins between navbar and on-page section links on the homepage", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1536, height: 960 });
  for (const { label, first, second, hash } of HOME_MIXED_ORDERS) {
    await openPage(page, "/", "desktop");
    await clickInQuickSuccession(page, first, second);
    await expectLanded(page, hash, `/ ${label}`);
  }
});

test("an on-page section link clicked as the homepage lands wins over the navbar section", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1536, height: 960 });
  const label = "/reviews navbar Benefits then on-page how it works";
  await openPage(page, "/reviews", "desktop");
  await clickInQuickSuccession(page, NAVBAR("benefits"), ON_PAGE("#how-it-works"), 0);
  await expectLanded(page, "#how-it-works", label);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname, { message: `${label} back` }).toBe("/reviews");
  await page.goForward();
  await expectLanded(page, "#how-it-works", `${label} forward`);
});

const FOOTER = (path) => ({ selector: `footer a[href="${path}"]` });

const readRoute = (page) =>
  page.evaluate(() => ({ path: window.location.pathname, hash: window.location.hash, top: window.scrollY <= 160 }));

const expectOnRoute = async (page, path, label) => {
  const landed = { path, hash: "", top: true };
  await expect
    .poll(() => readRoute(page).catch(() => null), {
      message: `${label} lands on ${path}`, timeout: 8000, intervals: [100],
    })
    .toEqual(landed);
  await page.waitForTimeout(1500);
  expect(await readRoute(page), `${label} stays on ${path}`).toEqual(landed);
};

const expectPath = (page, path, label) =>
  expect.poll(() => new URL(page.url()).pathname, { message: label, timeout: 8000 }).toBe(path);

const historyLength = (page) => page.evaluate(() => window.history.length);

const clickWhileTripInFlight = async (page, first, second) => {
  await waitForLinks(page, first, second);
  return page.evaluate(
    ([firstLink, secondLink]) => {
      const find = ({ selector, text }) =>
        [...document.querySelectorAll(selector)].find((element) => !text || element.textContent.includes(text));
      const pushState = window.history.pushState;
      window.history.pushState = function (...args) {
        window.history.pushState = pushState;
        pushState.apply(this, args);
        queueMicrotask(() => find(secondLink).click());
      };
      find(firstLink).click();
    },
    [first, second]
  );
};

for (const thirdClick of [false, true]) {
  const title = `an abandoned Home commit stays inert with delayed FAQ and third Tools click ${thirdClick}`;
  test(title, async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    const startLength = await historyLength(page);
    await clickSettledSection(page, "benefits", "desktop");
    await page.goBack();
    await expect(page.locator('#main-content [data-route-key="/reviews"]')).toBeVisible();
    await expectPath(page, "/reviews", "return from cached Home");
    const historySession = thirdClick ? await page.context().newCDPSession(page) : null;
    let resolveSample;
    const sample = new Promise(resolve => { resolveSample = resolve; });
    const onConsole = message => {
      const prefix = "ABANDONED_HOME_SAMPLE ";
      if (message.text().startsWith(prefix)) resolveSample(JSON.parse(message.text().slice(prefix.length)));
    };
    page.on("console", onConsole);
    let releaseFAQ;
    const faqReleased = new Promise(resolve => { releaseFAQ = resolve; });
    await page.route("**/faq", async route => {
      await faqReleased;
      await route.continue();
    });
    await page.evaluate(thirdClick => {
      const read = () => console.log("ABANDONED_HOME_SAMPLE " + JSON.stringify({
        path: location.pathname,
        length: history.length,
        y: scrollY,
        active: [...document.querySelectorAll('[data-nav-target][aria-current="location"]')]
          .map(link => link.dataset.navTarget),
      }));
      if (thirdClick) {
        for (const method of ["pushState", "replaceState"]) {
          const update = history[method];
          history[method] = function (...args) {
            update.apply(this, args);
            if (location.pathname === "/tools") read();
          };
        }
      }
      const observer = new MutationObserver(() => {
        if (!document.querySelector("#services")) return;
        observer.disconnect();
        if (thirdClick) document.querySelector('footer a[href="/tools"]').click();
        else requestAnimationFrame(() => requestAnimationFrame(read));
      });
      observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
    }, thirdClick);
    try {
      await clickWhileTripInFlight(page, NAVBAR("benefits"), FOOTER("/faq"));
      const observed = await sample;
      if (thirdClick) {
        expect(observed.path).toBe("/tools");
        expect(observed.length).toBe(startLength + 1);
        const history = await historySession.send("Page.getNavigationHistory");
        expect(new URL(history.entries[history.currentIndex - 1].url).pathname).toBe("/reviews");
      } else {
        expect(observed.active).not.toContain("benefits");
        expect(observed.y).toBe(0);
      }
    } finally {
      releaseFAQ();
      page.off("console", onConsole);
      await page.unrouteAll({ behavior: "wait" });
      await historySession?.detach();
    }
    if (!thirdClick) {
      await expectOnRoute(page, "/faq", "FAQ finishes after the abandoned Home");
      expect(await historyLength(page)).toBe(startLength + 1);
    }
  });
}

const ROUTE_AFTER_SECTION = [
  { label: "footer Privacy", link: FOOTER("/privacy"), path: "/privacy" },
  { label: "footer Tools", link: FOOTER("/tools"), path: "/tools" },
  { label: "footer FAQ page", link: FOOTER("/faq"), path: "/faq" },
  { label: "navbar logo", link: { selector: `header a[href="/"]` }, path: "/" },
  { label: "footer logo", link: FOOTER("/"), path: "/" },
];

for (const { label, link, path } of [ROUTE_AFTER_SECTION[1], ROUTE_AFTER_SECTION[3]]) {
  test(`the ${label} clicked when the homepage commits supersedes the section trip`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1536, height: 960 });
    await openPage(page, "/reviews", "desktop");
    const startLength = await historyLength(page);
    await evaluateBrowserTask(
      page,
      ([first, second]) =>
        new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            const secondLink = document.querySelector(second);
            if (!document.querySelector("#services") || !secondLink) return;
            observer.disconnect();
            clearTimeout(timeout);
            secondLink.click();
            resolve();
          });
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Missing #services or ${second}`));
          }, 15000);
          observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
          document.querySelector(first).click();
        }),
      [NAVBAR("benefits").selector, link.selector]
    );
    await expectOnRoute(page, path, label);
    if (path === "/") expect(await readHomeTop(page), label).toEqual({ path: "/", hash: "", y: 0 });
    expect(await historyLength(page), `${label} adds only its own history entry`).toBe(startLength + 1);
    await page.goBack();
    await expectPath(page, "/reviews", `${label} back`);
  });
}

test("a route link after Home is painted keeps the seen section in history", async ({ page }) => {
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  const departures = [];
  await page.exposeFunction("recordHomeDeparture", (departure) => departures.push(departure));
  await page.evaluate(() => {
    document.addEventListener("click", (event) => {
      if (!event.target.closest('footer a[href="/tools"]')) return;
      const section = document.querySelector("#services");
      const veil = document.querySelector(".route-transition-veil");
      window.recordHomeDeparture({
        path: window.location.pathname,
        hash: window.location.hash,
        aligned: Boolean(section && Math.abs(section.getBoundingClientRect().top) <= 160),
        unveiled: Boolean(veil && getComputedStyle(veil).opacity === "0"),
      });
    }, { capture: true });
  });
  await clickAtHomeArrival(page, NAVBAR("benefits").selector, FOOTER("/tools").selector, true);
  await expectMatrixLanding(page, MATRIX_LINKS.Tools);
  expect(departures).toEqual([{ path: "/", hash: "#services", aligned: true, unveiled: true }]);
  expect(await historyLength(page)).toBe(startLength + 2);
  await page.goBack();
  await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
});

test("a route link clicked right after a section link wins", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1536, height: 960 });
  for (const { label, link, path } of ROUTE_AFTER_SECTION) {
    const name = `/reviews navbar Benefits then ${label}`;
    await openPage(page, "/reviews", "desktop");
    await clickAtHomeArrival(page, NAVBAR("benefits").selector, link.selector);
    await expectOnRoute(page, path, name);
    await page.goBack();
    await expectPath(page, "/reviews", `${name} back`);
  }
});

test("a route link clicked while the homepage trip is in flight wins", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1536, height: 960 });
  for (const { label, link, path } of [ROUTE_AFTER_SECTION[0], ROUTE_AFTER_SECTION[2]]) {
    const name = `/reviews navbar Benefits then ${label} in flight`;
    await openPage(page, "/reviews", "desktop");
    await clickWhileTripInFlight(page, NAVBAR("benefits"), link).catch(() => {});
    await expectOnRoute(page, path, name);
    await page.goBack();
    await expectPath(page, "/reviews", `${name} back`);
  }
});

test("a delayed FAQ document consumes the abandoned Home entry once", async ({ page }) => {
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  await page.route("**/faq", async (route) => {
    await new Promise(resolve => setTimeout(resolve, 4000));
    await route.continue();
  });
  await clickWhileTripInFlight(page, NAVBAR("benefits"), FOOTER("/faq"));
  await expect(page).toHaveURL(/\/faq$/);
  await waitForHydrated(page, NAVBAR("benefits").selector);
  expect(await historyLength(page)).toBe(startLength + 1);
  await page.goBack();
  await expectPath(page, "/reviews", "Back skips the abandoned Home arrival");
});

test("a route link clicked as the section lands leaves the page scrollable", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 960 });
  const name = "/reviews navbar Benefits, landed, then footer Privacy";
  await openPage(page, "/reviews", "desktop");
  await evaluateBrowserTask(
    page,
    ([sectionSelector, routeSelector]) =>
      new Promise((resolve) => {
        document.querySelector(sectionSelector).click();
        const clickRouteOnLanding = () => {
          const locked = document.documentElement.classList.contains("route-transition-lock");
          if (window.location.pathname === "/" && locked) {
            document.querySelector(routeSelector).click();
            resolve();
            return;
          }
          requestAnimationFrame(clickRouteOnLanding);
        };
        requestAnimationFrame(clickRouteOnLanding);
      }),
    [NAVBAR("benefits").selector, FOOTER("/privacy").selector]
  );
  await expectOnRoute(page, "/privacy", name);
  expect(
    await page.evaluate(() => ({
      locked: document.documentElement.classList.contains("route-transition-lock"),
      veil: getComputedStyle(document.querySelector(".route-transition-veil")).opacity,
    })),
    `${name} veil`
  ).toEqual({ locked: false, veil: "0" });
});

const clickOnceSectionLands = async (page, sectionSelector, linkSelector, hash) => {
  await waitForLinks(page, { selector: sectionSelector }, { selector: linkSelector });
  return evaluateBrowserTask(
    page,
    ([section, link, target]) =>
      new Promise((resolve) => {
        document.querySelector(section).click();
        const clickLinkOnLanding = () => {
          if (window.location.pathname === "/" && window.location.hash === target && window.scrollY > 300) {
            document.querySelector(link).click();
            resolve();
            return;
          }
          requestAnimationFrame(clickLinkOnLanding);
        };
        requestAnimationFrame(clickLinkOnLanding);
      }),
    [sectionSelector, linkSelector, hash]
  );
};

const readHomeTop = (page) =>
  page.evaluate(() => ({ path: window.location.pathname, hash: window.location.hash, y: window.scrollY }));

const holdRouteChunks = async (page, shouldHold = () => true) => {
  const pending = [];
  const inFlight = new Set();
  let holding = true;
  const pattern = "**/_next/static/chunks/*.js";
  const handler = async (route) => {
    const handled = (async () => {
      const pause = await shouldHold();
      if (holding && pause) pending.push(route);
      else await route.continue();
    })();
    inFlight.add(handled);
    try {
      await handled;
    } finally {
      inFlight.delete(handled);
    }
  };
  await page.route(pattern, handler);
  return {
    wait: () => expect.poll(() => pending.length, { timeout: 8000 }).toBeGreaterThan(0),
    release: async () => {
      holding = false;
      await Promise.all(pending.splice(0).map((route) => route.continue()));
      while (inFlight.size) await Promise.all(inFlight);
      await page.unroute(pattern, handler);
    },
  };
};

for (const [label, selector, path, hash] of [
  ["navbar FAQ", NAVBAR("faq").selector, "/", "#faq"],
  ["footer FAQ page", FOOTER("/faq").selector, "/faq", ""],
]) {
  test(`the winning Tools commit consumes its marker before ${label}`, async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    const startLength = await historyLength(page);
    const markerSample = page.waitForEvent("console", {
      predicate: message => message.text().startsWith("TOOLS_COMMIT_MARKER "),
    });
    await page.evaluate(selector => {
      let toolsClicked = false;
      const observer = new MutationObserver(() => {
        if (document.querySelector('#main-content [data-route-key="/tools"]')) {
          observer.disconnect();
          console.log("TOOLS_COMMIT_MARKER " + JSON.stringify(history.state.__rooSectionTrip || null));
          document.querySelector(selector).click();
        } else if (!toolsClicked && document.querySelector("#services")) {
          toolsClicked = true;
          document.querySelector('footer a[href="/tools"]').click();
        }
      });
      observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
      document.querySelector('[data-nav-surface="desktop"][data-nav-target="benefits"]').click();
    }, selector);
    const marker = JSON.parse((await markerSample).text().slice("TOOLS_COMMIT_MARKER ".length));
    if (path === "/faq") await expectOnRoute(page, path, label);
    else await expectMatrixLanding(page, { path, hash });
    expect(await historyLength(page)).toBe(startLength + 2);
    await page.goBack();
    await expectPath(page, "/tools", `${label} returns to the winning Tools entry`);
    expect(marker).toBeNull();
  });
}

test("reloading a pending section trip leaves Home in the Back chain after Tools", async ({ page }) => {
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  const chunks = await holdRouteChunks(page);
  try {
    await page.locator(NAVBAR("benefits").selector).evaluate(link => link.click());
    await chunks.wait();
    await page.reload({ waitUntil: "commit" });
  } finally {
    await chunks.release();
  }
  await waitForLinks(page, NAVBAR("benefits"));
  await expectMatrixLanding(page, { path: "/", hash: "#services" });
  await page.locator(FOOTER("/tools").selector).evaluate(link => link.click());
  await expectMatrixLanding(page, { path: "/tools", hash: "" });
  expect(await historyLength(page)).toBe(startLength + 2);
  await page.goBack();
  await expectMatrixLanding(page, { path: "/", hash: "#services" });
  await page.goBack();
  await expectPath(page, "/reviews", "Back returns past the reloaded Home entry");
});

const MATRIX_LINKS = {
  Benefits: { ...NAVBAR("benefits"), path: "/", hash: SECTIONS.benefits },
  FAQ: { ...NAVBAR("faq"), path: "/", hash: SECTIONS.faq },
  Tools: { ...FOOTER("/tools"), path: "/tools", hash: "" },
  Privacy: { ...FOOTER("/privacy"), path: "/privacy", hash: "" },
  logo: { selector: 'header a[href="/"]', path: "/", hash: "" },
  Reviews: { selector: 'header a[href="/reviews"]', path: "/reviews", hash: "" },
};

const clickAtRouteCommit = (page, first, second, path) =>
  clickAtCommit(page, MATRIX_LINKS[first].selector, MATRIX_LINKS[second].selector, path);

const expectMatrixLanding = async (page, { path, hash }) => {
  if (hash) {
    await expect.poll(() => readLanding(page)).toEqual({ path, hash, onTop: hash });
  } else {
    await expect.poll(() => readRoute(page)).toEqual({ path, hash, top: true });
  }
};

test("a route after the winning Home commit keeps Home in the Back chain", async ({ page }) => {
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  await page.evaluate(() => {
    let logoClicked = false;
    let homeWritten = false;
    const replaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = replaceState.apply(this, args);
      if (logoClicked && !homeWritten && location.pathname === "/" && !location.hash &&
          args[0]?.__rooLegacy && args[0]?.usr && !args[0].usr.sectionTrip) {
        homeWritten = true;
        window.__winningHomeEntry = { path: location.pathname, hash: location.hash, length: history.length };
        queueMicrotask(() => document.querySelector('footer a[href="/privacy"]').click());
      }
      return result;
    };
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#services")) return;
      observer.disconnect();
      logoClicked = true;
      document.querySelector('header a[href="/"]').click();
    });
    observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
    document.querySelector('[data-nav-surface="desktop"][data-nav-target="benefits"]').click();
  });
  await expectMatrixLanding(page, MATRIX_LINKS.Privacy);
  expect(await page.evaluate(() => window.__winningHomeEntry)).toEqual({
    path: "/", hash: "", length: startLength + 1,
  });
  expect(await historyLength(page)).toBe(startLength + 2);
  await page.goBack();
  await expectMatrixLanding(page, MATRIX_LINKS.logo);
  await page.goBack();
  await expectPath(page, "/reviews", "Back returns past the winning Home entry");
});

const INTERLEAVINGS = ["before Home", "at Home commit"].flatMap((timing) => [
  ["Benefits", "FAQ"],
  ["Benefits", timing === "before Home" ? "Tools" : "Privacy"],
  ["Benefits", "logo"],
  ["logo", "FAQ"],
  ["logo", timing === "before Home" ? "Privacy" : "Tools"],
].map((clicks) => ({ origin: "/reviews", timing, clicks })));

for (const origin of ["/reviews", "/#services"]) {
  for (const winner of ["FAQ", "Privacy", "logo"]) {
    INTERLEAVINGS.push({ origin, timing: "held route", clicks: ["Tools", winner] });
    INTERLEAVINGS.push({ origin, timing: "held route then section", clicks: ["Tools", "Benefits", winner] });
    if (origin === "/reviews") {
      INTERLEAVINGS.push({ origin, timing: "Home commit then held route", clicks: ["Benefits", "Tools", winner] });
    }
  }
  for (const winner of ["FAQ", "Privacy"]) {
    INTERLEAVINGS.push({ origin, timing: "held route then logo", clicks: ["Tools", "logo", winner] });
  }
  INTERLEAVINGS.push({ origin, timing: "at route commit", clicks: ["Tools", "FAQ"] });
}
INTERLEAVINGS.push({ origin: "/#services", timing: "section replacement then route", clicks: ["FAQ", "Privacy"] });
for (const origin of ["/reviews", "/tools", "/about"]) {
  INTERLEAVINGS.push({ origin, scrolled: true, clicks: ["Benefits", "logo"], timing: "at Home commit" });
}
for (const origin of ["/reviews", "/tools", "/about"]) {
  INTERLEAVINGS.push({
    origin, scrolled: true, clicks: ["Benefits", origin === "/tools" ? "Privacy" : "Tools", "logo"],
    timing: "Home commit then held route",
  });
}
INTERLEAVINGS.push({ origin: "/reviews", timing: "before Home", clicks: ["Benefits", "Reviews"] });

test.describe("navigation interleaving matrix", () => {
  for (const { origin, timing, clicks, scrolled } of INTERLEAVINGS) {
    test(`${origin}: ${clicks.join(" → ")} (${timing}${scrolled ? ", scrolled start" : ""})`, async ({ page }) => {
      await page.setViewportSize({ width: 1536, height: scrolled ? 480 : 960 });
      await openPage(page, origin === "/#services" ? "/reviews" : origin, "desktop");
      await waitForLinks(page, ...clicks.map(link => MATRIX_LINKS[link]));
      if (origin === "/#services") await clickSettledSection(page, "benefits", "desktop");
      if (scrolled) {
        await page.evaluate(() => window.scrollTo({ top: 700, behavior: "instant" }));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(250);
      }
      const startLength = await historyLength(page);
      const [first, second, third] = clicks;
      const winner = MATRIX_LINKS[clicks.at(-1)];
      const held = timing.includes("held") || timing === "before Home";
      const chunks = held ? await holdRouteChunks(page, () =>
        timing === "Home commit then held route" ? page.locator("#services").count() : true
      ) : null;
      try {
        if (timing === "at Home commit" || timing === "Home commit then held route") {
          await clickAtRouteCommit(page, first, second, "/");
        } else if (timing === "at route commit") {
          await clickAtRouteCommit(page, first, second, "/tools");
        } else if (timing === "section replacement then route") {
          await clickSettledSection(page, "faq", "desktop");
          await page.locator(MATRIX_LINKS[second].selector).evaluate((link) => link.click());
        } else {
          await page.locator(MATRIX_LINKS[first].selector).first().evaluate((link) => link.click());
        }
        if (chunks) {
          await chunks.wait();
          const heldClicks = timing.startsWith("held route then") ? [second, third] : [third || second];
          await page.evaluate((selectors) => {
            for (const selector of selectors) document.querySelector(selector).click();
          }, heldClicks.map((link) => MATRIX_LINKS[link].selector));
        }
      } finally {
        await chunks?.release();
      }
      await expectMatrixLanding(page, winner);
      const committedPage = timing === "at route commit" ? MATRIX_LINKS.Tools
        : timing === "at Home commit" && first === "logo" && winner.path !== "/" ? MATRIX_LINKS.logo : null;
      const homeReplacement = origin === "/#services" && winner.path === "/" && !committedPage;
      expect(await historyLength(page)).toBe(startLength + (committedPage ? 2 : homeReplacement ? 0 : 1));
      if (scrolled) expect(await readHomeTop(page)).toEqual({ path: "/", hash: "", y: 0 });
      const nextRoute = winner.path === "/privacy" ? "Tools" : "Privacy";
      await page.locator(MATRIX_LINKS[nextRoute].selector).evaluate((link) => link.click());
      await expectMatrixLanding(page, MATRIX_LINKS[nextRoute]);
      await page.goBack();
      await expectMatrixLanding(page, winner);
      await page.goBack();
      if (committedPage) {
        await expectMatrixLanding(page, committedPage);
        await page.goBack();
      }
      if (origin !== "/#services" || homeReplacement) {
        const startPage = homeReplacement ? "/reviews" : origin;
        if (scrolled) await expectPath(page, startPage, "Back returns to the start page");
        else await expectMatrixLanding(page, { path: startPage, hash: "" });
      } else {
        const previousHome = timing === "section replacement then route" ? MATRIX_LINKS.FAQ
          : timing === "held route then logo" ? MATRIX_LINKS.logo : MATRIX_LINKS.Benefits;
        await expectMatrixLanding(page, previousHome);
      }
    });
  }
});

test("the navbar logo uses the committed homepage while the Tools route is pending", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 960 });
  await openPage(page, "/reviews", "desktop");
  await clickSection(page, "benefits", "desktop");
  await expectLanded(page, SECTIONS.benefits, "pending Tools setup");
  const startLength = await historyLength(page);
  const chunks = await holdRouteChunks(page);
  try {
    await page.locator(FOOTER("/tools").selector).click();
    await chunks.wait();
    await evaluateBrowserTask(page, () => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page.locator("#services")).toBeVisible();
    await page.locator('header a[href="/"]').first().click();
    await expect.poll(() => readHomeTop(page), { timeout: 8000 }).toEqual({ path: "/", hash: "", y: 0 });
  } finally {
    await chunks.release();
  }
  await expectOnRoute(page, "/", "logo supersedes pending Tools");
  expect(await readHomeTop(page)).toEqual({ path: "/", hash: "", y: 0 });
  expect(await historyLength(page), "the logo replaces the pending route").toBe(startLength);
  await page.goBack();
  await expectPath(page, "/reviews", "logo back to Reviews");
});

test("a fresh section click supersedes an abandoned trip while route chunks are pending", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 960 });
  await openPage(page, "/reviews", "desktop");
  const chunks = await holdRouteChunks(page);
  try {
    await clickWhileTripInFlight(page, NAVBAR("benefits"), FOOTER("/tools"));
    await chunks.wait();
    await clickSection(page, "faq", "desktop");
  } finally {
    await chunks.release();
  }
  await expectLanded(page, SECTIONS.faq, "Benefits, pending Tools, then fresh FAQ");
});

test("a fresh section click reuses the abandoned trip history entry", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  const chunks = await holdRouteChunks(page);
  try {
    await clickWhileTripInFlight(page, NAVBAR("benefits"), FOOTER("/tools"));
    await chunks.wait();
    await clickSection(page, "faq", "desktop");
  } finally {
    await chunks.release();
  }
  await expect.poll(() => readLanding(page)).toEqual({ path: "/", hash: SECTIONS.faq, onTop: SECTIONS.faq });
  expect(await historyLength(page), "the final section reuses the abandoned entry").toBe(startLength + 1);
  await page.goBack();
  await expect.poll(() => readRoute(page)).toEqual({ path: "/reviews", hash: "", top: true });
});

test("a homepage section click supersedes the pending Tools route", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  await clickSection(page, "benefits", "desktop");
  await expect.poll(() => readLanding(page)).toEqual({
    path: "/", hash: SECTIONS.benefits, onTop: SECTIONS.benefits,
  });
  const committedState = await page.evaluate(() => window.history.state.usr);
  expect(committedState).toEqual({ sectionTrip: expect.any(String) });
  const chunks = await holdRouteChunks(page);
  try {
    await page.locator(FOOTER("/tools").selector).click();
    await chunks.wait();
    await expect(page.locator("#services")).toBeVisible();
    await clickSection(page, "faq", "desktop");
  } finally {
    await chunks.release();
  }
  await expect.poll(() => readLanding(page)).toEqual({ path: "/", hash: SECTIONS.faq, onTop: SECTIONS.faq });
  expect(await historyLength(page), "the pending route adds no history entry").toBe(startLength + 1);
  expect(await page.evaluate(() => window.history.state.usr)).toEqual(committedState);
  await page.goBack();
  await expect.poll(() => readRoute(page)).toEqual({ path: "/reviews", hash: "", top: true });
});

test("a direct homepage section click preserves its query, state and scroll position", async ({ page }) => {
  for (const surface of ["desktop", "mobile"]) {
    await page.setViewportSize(surface === "mobile" ? { width: 390, height: 844 } : { width: 1536, height: 960 });
    await openPage(page, "/?ref=section-navigation", surface);
    const initial = await readHomeSectionState(page);
    await clickSettledSection(page, "faq", surface);
    const before = await readHomeSectionState(page);
    expect(before).toEqual({ ...initial, hash: SECTIONS.faq, active: ["faq"] });
    expect(before.search).toBe("?ref=section-navigation");
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await page.evaluate(() => {
      window.__sectionResetTop = false;
      const scrollTo = window.scrollTo;
      window.scrollTo = function (...args) {
        const top = typeof args[0] === "number" ? args[1] : args[0]?.top;
        if (top === 0) window.__sectionResetTop = true;
        return scrollTo.apply(this, args);
      };
      window.addEventListener("roo:section-align-settled", () => {
        window.scrollTo = scrollTo;
      }, { once: true });
    });
    await clickSettledSection(page, "faq", surface);
    expect(await page.evaluate(() => window.__sectionResetTop), `${surface} does not jump to top`).toBe(false);
    expect(await readHomeSectionState(page)).toEqual(before);
    expect(await readLanding(page)).toEqual({ path: "/", hash: SECTIONS.faq, onTop: SECTIONS.faq });
  }
});

test("homepage section clicks keep stripped background queries out of the URL", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("flow_background_location", JSON.stringify({
      pathname: "/", search: "?ref=section-navigation&junk=strip-me", hash: "",
    }));
  });
  await openPage(page, "/booking", "desktop");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/\?ref=section-navigation$/);
  await clickSettledSection(page, "faq", "desktop");
  expect((await readHomeSectionState(page)).search).toBe("?ref=section-navigation");
});

test("homepage section replacements keep Back and Forward in the same document", async ({ page }) => {
  for (const surface of ["desktop", "mobile"]) {
    await page.setViewportSize(surface === "mobile" ? { width: 390, height: 844 } : { width: 1536, height: 960 });
    await openPage(page, "/reviews", surface);
    const startLength = await historyLength(page);
    const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
    await page.locator(FOOTER("/").selector).click();
    await expect.poll(() => readRoute(page)).toEqual({ path: "/", hash: "", top: true });
    await clickSettledSection(page, "benefits", surface);
    await clickSettledSection(page, "faq", surface);
    expect(await historyLength(page)).toBe(startLength + 1);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
    await page.goBack();
    await expect.poll(() => readRoute(page)).toEqual({ path: "/reviews", hash: "", top: true });
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
    await page.goForward();
    await expect.poll(() => readLanding(page)).toEqual({ path: "/", hash: SECTIONS.faq, onTop: SECTIONS.faq });
    expect(await historyLength(page)).toBe(startLength + 1);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
  }
});

for (const { label, selector } of [
  { label: "footer logo", selector: FOOTER("/").selector },
  { label: "navbar logo", selector: `header a[href="/"]` },
]) {
  for (const origin of ["/reviews", "/"]) {
    const name = `${origin} navbar Benefits, then ${label} while it lands`;
    test(`the ${label} clicked as a section lands from ${origin} goes to a clean homepage`, async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: 1536, height: 960 });
      await openPage(page, origin, "desktop");
      await clickOnceSectionLands(page, NAVBAR("benefits").selector, selector, SECTIONS.benefits);
      const top = { path: "/", hash: "", y: 0 };
      await expect
        .poll(() => readHomeTop(page).catch(() => null), {
          message: `${name} lands on /`, timeout: 8000, intervals: [100],
        })
        .toEqual(top);
      await page.waitForTimeout(1500);
      expect(await readHomeTop(page), `${name} stays on /`).toEqual(top);
      if (origin !== "/") {
        await page.goBack();
        await expectPath(page, origin, `${name} back`);
      }
    });
  }
}

test("a section click after an abandoned trip adds its own history entry", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 960 });
  const name = "/reviews Benefits, Privacy, then FAQ";
  await openPage(page, "/reviews", "desktop");
  const startLength = await historyLength(page);
  await clickInQuickSuccession(page, NAVBAR("benefits"), FOOTER("/privacy"));
  await expectOnRoute(page, "/privacy", name);
  await clickSection(page, "faq", "desktop");
  await expectLanded(page, SECTIONS.faq, name);
  expect(await historyLength(page), `${name} history`).toBe(startLength + 2);
  await page.goBack();
  await expectPath(page, "/privacy", `${name} back to Privacy`);
  await page.goBack();
  await expectPath(page, "/reviews", `${name} back to Reviews`);
  await page.goForward();
  await page.goForward();
  await expectLanded(page, SECTIONS.faq, `${name} forward`);
});

test("Back right after a section click returns to the page it was clicked on", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 960 });
  const name = "/reviews to Privacy, Benefits, then Back";
  await openPage(page, "/reviews", "desktop");
  await page.locator('footer a[href="/privacy"]').click();
  await expectOnRoute(page, "/privacy", name);
  await page.evaluate((selector) => {
    document.querySelector(selector).click();
    document.querySelector(`header button[aria-label="Go Back"]`).click();
  }, NAVBAR("benefits").selector);
  await expectOnRoute(page, "/privacy", name);
  await page.goForward();
  await expectLanded(page, SECTIONS.benefits, `${name} forward`);
  await page.goBack();
  await expectOnRoute(page, "/privacy", `${name} back again`);
  await page.goBack();
  await expectPath(page, "/reviews", `${name} back to Reviews`);
});

for (const { label, origin, selector, text = "", hash } of [
  { label: "navbar FAQ off the homepage", origin: "/reviews", ...NAVBAR("faq"), hash: "#faq" },
  { label: "on-page Tune My PC", origin: "/", ...ON_PAGE("#packages", "Tune My PC"), hash: "#packages" },
]) {
  test(`modifier click on ${label} opens the section in a new page`, async ({ context, page }) => {
    await page.setViewportSize({ width: 1536, height: 960 });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await waitForLinks(page, { selector });
    const before = await page.evaluate(() => ({ url: window.location.href, y: window.scrollY }));
    const [opened] = await Promise.all([
      context.waitForEvent("page", { timeout: 15000 }),
      page.locator(selector, { hasText: text }).first().click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await opened.waitForLoadState("domcontentloaded");
    const openedUrl = new URL(opened.url());
    expect(`${openedUrl.pathname}${openedUrl.hash}`, `${label} new page`).toBe(`/${hash}`);
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(() => ({ url: window.location.href, y: window.scrollY })),
      `${label} current tab`
    ).toEqual(before);
    await opened.close();
  });
}

for (const { label, surface, viewport } of [
  { label: "desktop", surface: "desktop", viewport: { width: 1536, height: 960 } },
  { label: "tablet", surface: "mobile", viewport: { width: 900, height: 1200 } },
  { label: "phone", surface: "mobile", viewport: { width: 390, height: 844 } },
]) {
  test(`${label} menus close when a menu link opens in a new page`, async ({ context, page }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    await openPage(page, "/faq", surface);
    const siteMenu = page.locator('button[aria-controls="mobile-site-menu"]');
    for (const [menu, href] of [
      ["proof", "/benchmarks"],
      ["proof", "/reviews"],
      ["referrals", "/referrals/register"],
      ["referrals", "/referrals/login"],
    ]) {
      const name = `${label} ${href} opened in a new page`;
      const toggle = page.locator(`button[aria-controls="${surface}-${menu}-menu"]`);
      if (surface === "mobile") await siteMenu.click();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const [opened] = await Promise.all([
        context.waitForEvent("page", { timeout: 15000 }),
        page.locator(`#${surface}-${menu}-menu a[href="${href}"]`).click({ modifiers: ["ControlOrMeta"] }),
      ]);
      await opened.close();
      await expect(toggle, `${name} closes its menu`).toHaveAttribute("aria-expanded", "false");
      if (surface === "mobile") {
        await expect(siteMenu, `${name} closes the site menu`).toHaveAttribute("aria-expanded", "false");
      }
      expect(new URL(page.url()).pathname, `${name} stays on /faq`).toBe("/faq");
    }
  });
}

test.describe("reduced motion on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("an on-page section link jumps straight to the section", async ({ page }) => {
    test.setTimeout(120000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const link = ON_PAGE("#packages", "Tune My PC");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForRouteCommitted(page);
    await page.waitForFunction(
      ({ selector, text }) =>
        [...document.querySelectorAll(selector)].some(
          (element) =>
            element.textContent.includes(text) && Object.keys(element).some((key) => key.startsWith("__reactProps$"))
        ),
      link,
      { timeout: 15000 }
    );
    const samples = await evaluateBrowserTask(
      page,
      ({ selector, text, hash }) =>
        new Promise((resolve) => {
          const target = () => document.querySelector(hash);
          const read = () => ({ y: window.scrollY, top: target()?.getBoundingClientRect().top ?? null });
          const frames = [read()];
          const element = [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
          element.click();
          const clickedAt = performance.now();
          const sample = () => {
            frames.push(read());
            if (performance.now() - clickedAt > 1500) {
              resolve(frames);
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
      { ...link, hash: SECTIONS.plans }
    );
    const [start] = samples;
    expect(Math.abs(start.top), "section starts well below the fold").toBeGreaterThan(844);
    const moved = samples.filter((frame) => Math.abs(frame.y - start.y) > 1);
    expect(moved.length, "page scrolled").toBeGreaterThan(0);
    const inBetween = moved.filter((frame) => Math.abs(frame.top) > FINAL_OFFSET_MAX);
    expect(inBetween, "no animated in-between positions").toEqual([]);
    await expectLanded(page, SECTIONS.plans, "reduced motion phone Tune My PC");
  });
});

const FAQ_NEXT = { scope: "#faq", text: "Next", from: "top" };
const FAQ_PREVIOUS = { scope: "#faq", text: "Previous", from: "top" };
const BACK_TO_TOP = { scope: "footer", text: "To the top", from: "bottom" };

const waitForButton = (page, { scope, text }) =>
  page.waitForFunction(
    ({ scope: root, text: label }) =>
      [...document.querySelectorAll(`${root} button`)].some(
        (button) =>
          button.textContent.trim().startsWith(label) &&
          !button.disabled &&
          Object.keys(button).some((key) => key.startsWith("__reactProps$"))
      ),
    { scope, text },
    { timeout: 15000 }
  );

const sampleScrollAfterClick = async (page, button) => {
  await waitForRouteCommitted(page);
  await waitForButton(page, button);
  return evaluateBrowserTask(
    page,
    ({ scope, text, from }) =>
      new Promise((resolve) => {
        const find = () =>
          [...document.querySelectorAll(`${scope} button`)].find((item) => item.textContent.trim().startsWith(text));
        window.scrollTo({ top: from === "top" ? 0 : document.documentElement.scrollHeight, behavior: "instant" });
        let lastY = -1;
        let stillFrames = 0;
        const settle = () => {
          stillFrames = window.scrollY === lastY ? stillFrames + 1 : 0;
          lastY = window.scrollY;
          if (stillFrames < 10) {
            requestAnimationFrame(settle);
            return;
          }
          const frames = [window.scrollY];
          find().click();
          const clickedAt = performance.now();
          const sample = () => {
            frames.push(window.scrollY);
            if (performance.now() - clickedAt > 2000) {
              resolve(frames);
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(settle);
      }),
    button
  );
};

const scrollPath = (frames) => {
  const start = frames[0];
  const end = frames[frames.length - 1];
  return {
    distance: Math.abs(end - start),
    inBetween: frames.filter((y) => Math.abs(y - start) > 1 && Math.abs(y - end) > 1),
  };
};

const SCROLL_BUTTONS = [
  { label: "FAQ Next", button: FAQ_NEXT },
  { label: "FAQ Previous", button: FAQ_PREVIOUS },
  { label: "footer back to top", button: BACK_TO_TOP },
];

test.describe("reduced motion on button scrolls", () => {
  test.use({ viewport: { width: 1536, height: 960 } });

  test("FAQ paging and back to top jump without animating", async ({ page }) => {
    test.setTimeout(120000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    for (const { label, button } of SCROLL_BUTTONS) {
      const path = scrollPath(await sampleScrollAfterClick(page, button));
      expect(path.distance, `${label} scrolled`).toBeGreaterThan(300);
      expect(path.inBetween, `${label} has no animated in-between positions`).toEqual([]);
    }
  });

  test("FAQ paging and back to top still glide without a reduced-motion preference", async ({ page }) => {
    test.setTimeout(120000);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    for (const { label, button } of SCROLL_BUTTONS) {
      const path = scrollPath(await sampleScrollAfterClick(page, button));
      expect(path.distance, `${label} scrolled`).toBeGreaterThan(300);
      expect(path.inBetween.length, `${label} glides through in-between positions`).toBeGreaterThan(1);
    }
  });
});

test.describe("navigation interleaving matrix follow-ups", () => {
  test("Benefits then the skip link preserves one arrival and the full Back chain", async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    const startLength = await historyLength(page);
    const chunks = await holdRouteChunks(page);
    try {
      await page.locator(NAVBAR("benefits").selector).evaluate(link => link.click());
      await chunks.wait();
      await page.locator('a[href="#main-content"]').evaluate(link => link.click());
    } finally {
      await chunks.release();
    }
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
    const landedLength = await historyLength(page);
    expect(landedLength).toBe(startLength + 1);
    await page.locator(MATRIX_LINKS.Tools.selector).evaluate(link => link.click());
    await expectMatrixLanding(page, MATRIX_LINKS.Tools);
    expect(await historyLength(page)).toBe(landedLength + 1);
    await page.goBack();
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
    await page.goBack();
    await expectPath(page, "/reviews", "Back has no duplicate section entry");
  });

  test("real Back after pending fragments ends the trip before the next section click", async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    const startLength = await historyLength(page);
    const chunks = await holdRouteChunks(page);
    try {
      await page.locator(NAVBAR("benefits").selector).evaluate(link => link.click());
      await chunks.wait();
      const firstKey = await page.evaluate(() => window.history.state.__rooSectionTrip.key);
      for (const hash of ["#main-content", "#app-shell", "#main-content"]) {
        await page.locator('a[href="#main-content"]').evaluate((link, hash) => {
          link.setAttribute("href", hash);
          link.click();
          link.setAttribute("href", "#main-content");
        }, hash);
        await expect(page).toHaveURL(new RegExp(hash + "$"));
        expect(await historyLength(page)).toBe(startLength + 1);
      }
      await page.goBack();
      await expectPath(page, "/reviews", "real Back cancels the trip after fragments");
      expect(await page.evaluate(() => window.history.state.__rooSectionTrip)).toBeUndefined();
      await page.locator(NAVBAR("faq").selector).evaluate(link => link.click());
      const nextKey = await page.evaluate(() => window.history.state.__rooSectionTrip?.key);
      expect(nextKey).toEqual(expect.any(String));
      expect(nextKey).not.toBe(firstKey);
    } finally {
      await chunks.release();
    }
    await expectMatrixLanding(page, MATRIX_LINKS.FAQ);
    expect(await historyLength(page)).toBe(startLength + 1);
    await page.goBack();
    await expectPath(page, "/reviews", "new trip still returns directly to Reviews");
  });

  test("section trip keys differ after a reload", async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    await clickSection(page, "benefits", "desktop");
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
    const firstKey = await page.evaluate(() => window.history.state.usr.sectionTrip);
    await page.goBack();
    await expectPath(page, "/reviews", "Back before reload");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForHydrated(page, NAVBAR("benefits").selector);
    await clickSection(page, "benefits", "desktop");
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
    expect(await page.evaluate(() => window.history.state.usr.sectionTrip)).not.toBe(firstKey);
  });

  test("Back and Forward consume an abandoned trip before the next Tools click", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 960 });
    await openPage(page, "/reviews", "desktop");
    const startLength = await historyLength(page);
    const chunks = await holdRouteChunks(page, () => page.locator("#services").count());
    try {
      await clickAtRouteCommit(page, "Benefits", "Tools", "/");
      await chunks.wait();
      await page.goBack();
      await expectPath(page, "/reviews", "Back cancels the held route");
    } finally {
      await chunks.release();
    }
    await page.goForward();
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
    expect(await page.evaluate(() => window.history.state.__rooSectionTrip)).toBeUndefined();
    await page.locator(MATRIX_LINKS.Tools.selector).evaluate(link => link.click());
    await expectMatrixLanding(page, MATRIX_LINKS.Tools);
    expect(await historyLength(page)).toBe(startLength + 2);
    await page.goBack();
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
  });

  for (const [kind, attributes] of [
    ["email", {}],
    ["telephone", { href: "tel:+10000000000" }],
    ["new tab", { href: "/about", target: "_blank" }],
    ["download", { href: "/tools", download: "tools" }],
  ]) {
    test(`Benefits then a ${kind} link keeps the section trip`, async ({ page }) => {
      await page.setViewportSize({ width: 1536, height: 960 });
      await openPage(page, "/contact", "desktop");
      const startLength = await historyLength(page);
      const chunks = await holdRouteChunks(page);
      try {
        await page.evaluate(({ selector, attributes }) => {
          const link = document.querySelector('#main-content a[href^="mailto:"]');
          for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
          link.addEventListener("click", event => event.preventDefault(), { once: true });
          document.querySelector(selector).click();
          link.click();
        }, { selector: NAVBAR("benefits").selector, attributes });
        await chunks.wait();
      } finally {
        await chunks.release();
      }
      await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
      await page.locator(MATRIX_LINKS.Tools.selector).evaluate(link => link.click());
      await expectMatrixLanding(page, MATRIX_LINKS.Tools);
      expect(await historyLength(page)).toBe(startLength + 2);
      await page.goBack();
      await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
    });
  }

  test("a section click works without crypto.randomUUID", async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    await page.evaluate(() => Object.defineProperty(window.crypto, "randomUUID", { value: undefined }));
    await clickSection(page, "benefits", "desktop");
    await expectMatrixLanding(page, MATRIX_LINKS.Benefits);
  });

  test("a section click at Home commit never writes a section onto the start page URL", async ({ page }) => {
    await openPage(page, "/reviews", "desktop");
    await page.evaluate(() => {
      window.__sectionUrls = [];
      const replaceState = window.history.replaceState;
      window.history.replaceState = function (...args) {
        const url = new URL(args[2], window.location.href);
        window.__sectionUrls.push(url.pathname + url.hash);
        return replaceState.apply(this, args);
      };
    });
    await clickAtRouteCommit(page, "Benefits", "FAQ", "/");
    await expectMatrixLanding(page, MATRIX_LINKS.FAQ);
    expect(await page.evaluate(() => window.__sectionUrls)).not.toContain("/reviews#faq");
  });

  for (const width of [1536, 390]) {
    test(`closing Book keeps the visitor's section scroll position at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      const surface = width === 390 ? "mobile" : "desktop";
      await openPage(page, "/reviews", surface);
      await clickSection(page, "plans", surface);
      await expectMatrixLanding(page, { path: "/", hash: SECTIONS.plans });
      const book = page.locator('#packages a[href="/booking"]').first();
      await book.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy({ top: 180, behavior: "instant" }));
      const before = await page.evaluate(() => window.scrollY);
      await book.evaluate(link => link.click());
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
      await evaluateBrowserTask(
        page,
        () => new Promise(resolve => {
        let frames = 0;
        const sample = () => ++frames === 60 ? resolve() : requestAnimationFrame(sample);
        requestAnimationFrame(sample);
      }));
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
      expect(new URL(page.url()).pathname).toBe("/");
    });
  }
});

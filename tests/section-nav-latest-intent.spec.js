const { test, expect } = require("@playwright/test");
const { waitForHydrated } = require("./fixtures/react-hydration.cjs");

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
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, page, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
});

const openPage = async (page, route, surface) => {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  const selector =
    surface === "mobile"
      ? 'button[aria-label="Open menu"]'
      : '[data-nav-surface="desktop"][data-nav-target="faq"]';
  await waitForHydrated(page, selector);
};

const clickSection = async (page, target, surface) => {
  const link = page.locator(`[data-nav-surface="${surface}"][data-nav-target="${target}"]`).first();
  if (surface !== "mobile") {
    await link.click();
    return;
  }
  const menuButton = page.locator('button[aria-label="Open menu"]');
  await expect(async () => {
    if ((await menuButton.getAttribute("aria-expanded")) !== "true") await menuButton.click();
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
    .poll(() => readLanding(page).catch(() => null), { message: `${label} lands on ${hash}`, timeout: 8000, intervals: [100] })
    .toEqual(landed);
  await page.waitForTimeout(1500);
  expect(await readLanding(page), `${label} stays on ${hash}`).toEqual(landed);
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

const clickInQuickSuccession = (page, first, second, gapMs = 10) =>
  page.evaluate(
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
          if (secondElement && performance.now() - clickedAt >= gap) {
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

const HOME_MIXED_ORDERS = [
  { label: "on-page packages then navbar FAQ", first: ON_PAGE("#packages"), second: NAVBAR("faq"), hash: "#faq" },
  { label: "navbar FAQ then on-page how it works", first: NAVBAR("faq"), second: ON_PAGE("#how-it-works"), hash: "#how-it-works" },
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
    .poll(() => readRoute(page).catch(() => null), { message: `${label} lands on ${path}`, timeout: 8000, intervals: [100] })
    .toEqual(landed);
  await page.waitForTimeout(1500);
  expect(await readRoute(page), `${label} stays on ${path}`).toEqual(landed);
};

const expectPath = (page, path, label) =>
  expect.poll(() => new URL(page.url()).pathname, { message: label, timeout: 8000 }).toBe(path);

const historyLength = (page) => page.evaluate(() => window.history.length);

const clickWhileTripInFlight = (page, first, second) =>
  page.evaluate(
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

const ROUTE_AFTER_SECTION = [
  { label: "footer Privacy", link: FOOTER("/privacy"), path: "/privacy" },
  { label: "footer Tools", link: FOOTER("/tools"), path: "/tools" },
  { label: "footer FAQ page", link: FOOTER("/faq"), path: "/faq" },
  { label: "navbar logo", link: { selector: `header a[href="/"]` }, path: "/" },
  { label: "footer logo", link: FOOTER("/"), path: "/" },
];

test("a route link clicked right after a section link wins", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1536, height: 960 });
  for (const { label, link, path } of ROUTE_AFTER_SECTION) {
    const name = `/reviews navbar Benefits then ${label}`;
    await openPage(page, "/reviews", "desktop");
    await clickInQuickSuccession(page, NAVBAR("benefits"), link).catch(() => {});
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

test("a route link clicked as the section lands leaves the page scrollable", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 960 });
  const name = "/reviews navbar Benefits, landed, then footer Privacy";
  await openPage(page, "/reviews", "desktop");
  await page.evaluate(
    ([sectionSelector, routeSelector]) =>
      new Promise((resolve) => {
        document.querySelector(sectionSelector).click();
        const clickRouteOnLanding = () => {
          if (window.location.pathname === "/" && document.documentElement.classList.contains("route-transition-lock")) {
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

const clickOnceSectionLands = (page, sectionSelector, linkSelector, hash) =>
  page.evaluate(
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

const readHomeTop = (page) =>
  page.evaluate(() => ({ path: window.location.pathname, hash: window.location.hash, y: window.scrollY }));

for (const { label, selector } of [
  { label: "footer logo", selector: FOOTER("/").selector },
  { label: "navbar logo", selector: `header a[href="/"]` },
]) {
  for (const origin of ["/reviews", "/"]) {
    test(`the ${label} clicked as a section lands from ${origin} goes to the top of a clean homepage`, async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: 1536, height: 960 });
      const name = `${origin} navbar Benefits, then ${label} while it lands`;
      await openPage(page, origin, "desktop");
      await clickOnceSectionLands(page, NAVBAR("benefits").selector, selector, SECTIONS.benefits);
      const top = { path: "/", hash: "", y: 0 };
      await expect
        .poll(() => readHomeTop(page).catch(() => null), { message: `${name} lands on /`, timeout: 8000, intervals: [100] })
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
    await waitForHydrated(page, selector);
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

for (const surface of ["desktop", "mobile"]) {
  test(`${surface} menus close when a menu link opens in a new page`, async ({ context, page }) => {
    test.setTimeout(120000);
    await page.setViewportSize(surface === "mobile" ? { width: 390, height: 844 } : { width: 1536, height: 960 });
    await openPage(page, "/faq", surface);
    const siteMenu = page.locator('button[aria-controls="mobile-site-menu"]');
    for (const [menu, href] of [
      ["proof", "/benchmarks"],
      ["proof", "/reviews"],
      ["referrals", "/referrals/register"],
      ["referrals", "/referrals/login"],
    ]) {
      const name = `${surface} ${href} opened in a new page`;
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
      if (surface === "mobile") await expect(siteMenu, `${name} closes the site menu`).toHaveAttribute("aria-expanded", "false");
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
    await page.waitForFunction(
      ({ selector, text }) =>
        [...document.querySelectorAll(selector)].some(
          (element) =>
            element.textContent.includes(text) && Object.keys(element).some((key) => key.startsWith("__reactProps$"))
        ),
      link,
      { timeout: 15000 }
    );
    const samples = await page.evaluate(
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
  await waitForButton(page, button);
  return page.evaluate(
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

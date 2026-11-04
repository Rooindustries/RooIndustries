const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true, reducedMotion: "reduce" });

const refreshedHero = "Refreshed Hero Heading One";
const refreshedReferral = "Refreshed referral heading";
const refreshedTag = "Refreshed offer tag";

const publishedEdits = {
  hero: (data) => ({ ...data, headingLine1: refreshedHero }),
  "referral-box": (data) => ({ ...data, heading: refreshedReferral }),
  "packages-list": (rows) => rows.map((row, index) => (index === 0 ? { ...row, tag: refreshedTag } : row)),
};

const resourceOf = (request) => decodeURIComponent(new URL(request.url()).pathname.split("/").pop());

const controlContent = async (page) => {
  const content = { published: false, hold: false, held: [], failing: new Set(), payloads: new Map(), requests: [] };
  await page.route("**/api/content/**", async (route) => {
    const resource = resourceOf(route.request());
    content.requests.push(resource);
    if (content.failing.has(resource)) {
      await route.fulfill({ status: 503, json: { ok: false, error: "Public content is temporarily unavailable." } });
      return;
    }
    if (content.payloads.has(resource)) {
      const { revision } = await (await route.fetch()).json();
      await route.fulfill({ status: 200, json: { ok: true, data: content.payloads.get(resource), revision } });
      return;
    }
    const published = content.published;
    const respond = async () => {
      const response = await route.fetch();
      const body = await response.json();
      if (published && publishedEdits[resource]) body.data = publishedEdits[resource](body.data);
      await route.fulfill({ response, json: body });
    };
    if (content.hold) content.held.push(respond);
    else await respond();
  });
  return content;
};

const contentControl = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = process.env.TOOLING_CONTENT_PORT || String(Number(origin.port) + 1);
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);
const footerLink = (page, href) => page.locator(`footer a[href="${href}"]`).first();
const siteFooter = (page) => page.locator("footer").last();
const pageLink = (page, href) => page.locator(`#main-content a[href="${href}"]`).first();

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("an in-app return to the homepage shows CMS copy published after the first load", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.clock.install();
  const content = await controlContent(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
  await siteFooter(page).scrollIntoViewIfNeeded();
  await expect(page.locator(".ri-referral-heading")).toHaveText("Join the Referral Program");
  expect(content.requests.filter((resource) => ["hero", "referral-box"].includes(resource))).toEqual([]);
  await page.evaluate(() => { window.__homeCopyDocument = true; });

  content.published = true;
  await footerLink(page, "/terms").click();
  await expect(page).toHaveURL(/\/terms$/);
  await page.clock.fastForward("01:01");

  await footerLink(page, "/").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#top h1")).toContainText(refreshedHero);
  await siteFooter(page).scrollIntoViewIfNeeded();
  await expect(page.locator(".ri-referral-heading")).toHaveText(refreshedReferral);
  expect(await page.evaluate(() => window.__homeCopyDocument)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("an older content response never replaces copy refreshed after it", async ({ page }) => {
  await page.clock.install();
  const content = await controlContent(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await page.evaluate(() => { window.__offerDocument = true; });
  content.hold = true;
  await footerLink(page, "/terms").click();
  await expect(page).toHaveURL(/\/terms$/);
  await page.waitForTimeout(1500);

  content.published = true;
  content.hold = false;
  await page.clock.fastForward("01:01");
  await footerLink(page, "/").click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator("#packages").scrollIntoViewIfNeeded();
  await expect(page.locator("#packages").getByText(refreshedTag, { exact: true })).toBeVisible();

  for (const respond of content.held.splice(0)) await respond().catch(() => {});
  await page.waitForTimeout(500);

  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await pageLink(page, "/packages").click();
  await expect(page).toHaveURL(/\/packages$/);
  await expect(page.getByText(refreshedTag, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => window.__offerDocument)).toBe(true);
});

test("a page keeps its last copy when the refresh after the window fails", async ({ page }) => {
  await page.clock.install();
  const content = await controlContent(page);
  const submit = page.locator('form button[type="submit"]');
  const contactRequests = () => content.requests.filter((resource) => resource === "contact").length;

  await page.goto("/contact", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect(page.getByText("Synthetic local contact information.")).toBeVisible();
  await expect(submit).toBeEnabled();
  await page.evaluate(() => { window.__contactDocument = true; });

  content.failing.add("contact");
  await page.clock.fastForward("01:01");
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  const requestsBeforeReturn = contactRequests();

  await pageLink(page, "/contact").click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect.poll(contactRequests).toBeGreaterThan(requestsBeforeReturn);
  await expect(page.getByText("Synthetic local contact information.")).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(page.getByText("The contact form is temporarily unavailable.", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => window.__contactDocument)).toBe(true);
});

const emptyBlockPolicy = (title) => ({
  title,
  sections: [{
    heading: "Published section with an empty body",
    content: [{ _type: "block", _key: "empty", style: "normal", markDefs: [], children: [{ _type: "span", _key: "empty-span", text: "", marks: [] }] }],
  }],
});
const reviewCards = (page) => page.locator("#main-content article[data-review-id]");
const policyBody = (page) => page.locator("#main-content").getByText("Synthetic local information", { exact: true });

const refreshAfterWindow = async (page, refresh) => {
  await page.clock.install();
  const content = await controlContent(page);
  const refreshRequests = () => content.requests.filter((resource) => resource === refresh.resource).length;

  await page.goto(refresh.path, { waitUntil: "networkidle" });
  await hydrated(page);
  await refresh.before(page);
  await page.evaluate(() => { window.__refreshDocument = true; });

  content.payloads.set(refresh.resource, refresh.data);
  const requestsBeforeWindow = refreshRequests();
  await page.clock.fastForward("01:01");
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);

  await (refresh.path === "/contact" ? pageLink(page, refresh.path) : footerLink(page, refresh.path)).click();
  await expect(page).toHaveURL(new RegExp(`${refresh.path}$`));
  await expect.poll(refreshRequests).toBeGreaterThan(requestsBeforeWindow);
  await refresh.after(page);
  expect(await page.evaluate(() => window.__refreshDocument)).toBe(true);
};

test("/contact keeps its last copy when a refresh returns no document", async ({ page }) => {
  const copy = page.locator("#main-content").getByText("Synthetic local contact information.", { exact: true });
  await refreshAfterWindow(page, {
    path: "/contact",
    resource: "contact",
    data: null,
    before: async () => expect(copy).toBeVisible(),
    after: async () => {
      await expect(copy).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toBeEnabled();
      await expect(page.getByText("Loading the contact form...", { exact: true })).toHaveCount(0);
    },
  });
});

for (const refresh of [
  {
    name: "an empty review list on the homepage",
    path: "/",
    resource: "reviews",
    data: { reviews: [] },
    before: async (page) => {
      await reviewCards(page).first().scrollIntoViewIfNeeded();
      expect(await reviewCards(page).count()).toBeGreaterThan(0);
    },
    after: async (page) => expect(reviewCards(page)).toHaveCount(0),
  },
  ...[["/privacy", "privacy-policy", "Privacy Policy"], ["/terms", "terms", "Terms of Service"]].map(([path, resource, title]) => ({
    name: `a ${title.toLowerCase()} with an empty body`,
    path,
    resource,
    data: emptyBlockPolicy(title),
    before: async (page) => expect(policyBody(page)).toBeVisible(),
    after: async (page) => {
      await expect(page.getByRole("heading", { name: "Published section with an empty body", exact: true })).toBeVisible();
      await expect(policyBody(page)).toHaveCount(0);
    },
  })),
  {
    name: "a privacy policy with no sections",
    path: "/privacy",
    resource: "privacy-policy",
    data: { title: "Privacy Policy", sections: [] },
    before: async (page) => expect(policyBody(page)).toBeVisible(),
    after: async (page) => {
      await expect(page.locator("#main-content h1")).toHaveText("Privacy Policy");
      await expect(policyBody(page)).toHaveCount(0);
    },
  },
]) {
  test(`${refresh.path} shows ${refresh.name} as published after the refresh window`, async ({ page }) => {
    await refreshAfterWindow(page, refresh);
  });
}

test("the content API labels each response with its CMS revision and the purge tag", async ({ request }) => {
  const response = await request.get("/api/content/hero");
  expect(response.status()).toBe(200);
  expect(response.headers()["vercel-cache-tag"]).toBe("public-content");
  const body = await response.json();
  expect(Number.isSafeInteger(body.revision)).toBe(true);
  expect(body.revision).toBeGreaterThan(0);
});

test("an older revision from the content API never replaces the newer server copy", async ({ page }) => {
  await page.clock.install();
  const content = await controlContent(page);
  await page.route("**/api/content/hero", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, data: { ...body.data, headingLine1: "Hero copy from before the publish" }, revision: 0 } });
  });

  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
  await page.evaluate(() => { window.__revisionDocument = true; });

  await footerLink(page, "/terms").click();
  await expect(page).toHaveURL(/\/terms$/);
  await page.clock.fastForward("01:01");
  content.published = true;
  content.hold = true;
  const olderHero = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/content/hero");
  await footerLink(page, "/").click();
  await expect(page).toHaveURL(/\/$/);
  await (await olderHero).finished();
  content.hold = false;
  for (const respond of content.held.splice(0)) await respond();
  await page.locator("#packages").scrollIntoViewIfNeeded();
  await expect(page.locator("#packages").getByText(refreshedTag, { exact: true })).toBeVisible();

  await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
  await expect(page.locator("#top h1")).not.toContainText("Hero copy from before the publish");
  expect(await page.evaluate(() => window.__revisionDocument)).toBe(true);
});

test("a content response without a revision never replaces versioned copy", async ({ page }) => {
  const unlabelledHero = "Hero copy with no revision";
  const nextHero = "Hero copy at the next revision";
  const followUpHero = "Hero copy after the unlabelled response";
  const firstHero = "Fixture Hero Heading One";
  const heading = page.locator("#top h1");
  await page.addInitScript(() => {
    window.__heroStates = [];
    new MutationObserver(() => {
      const text = document.querySelector("#top h1")?.textContent;
      if (text && window.__heroStates.at(-1) !== text) window.__heroStates.push(text);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.clock.install();
  await controlContent(page);
  const heroResponses = [
    (body) => ({ ...body, data: { ...body.data, headingLine1: nextHero }, revision: body.revision + 1 }),
    (body) => ({ ok: true, data: { ...body.data, headingLine1: unlabelledHero } }),
    (body) => ({ ...body, data: { ...body.data, headingLine1: followUpHero }, revision: body.revision + 2 }),
  ];
  let heroRequests = 0;
  await page.route("**/api/content/hero", async (route) => {
    heroRequests += 1;
    const body = await (await route.fetch()).json();
    const respond = heroResponses.shift();
    await route.fulfill({ json: respond ? respond(body) : body });
  });
  const shownHeroes = async () => (await page.evaluate(() => window.__heroStates))
    .map((text) => [firstHero, nextHero, unlabelledHero, followUpHero].find((hero) => text.includes(hero)) ?? text)
    .filter((hero, index, heroes) => hero !== heroes[index - 1]);
  const leaveAndReturn = async (beforeReturn = async () => {}) => {
    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await beforeReturn();
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
  };
  const refreshHome = async () => {
    let hero;
    await leaveAndReturn(async () => {
      await page.clock.fastForward("01:01");
      hero = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/content/hero");
    });
    await (await hero).finished();
  };

  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect(heading).toContainText(firstHero);
  await page.evaluate(() => { window.__unlabelledDocument = true; });

  await refreshHome();
  await expect(heading).toContainText(nextHero);

  await refreshHome();
  await expect(async () => {
    expect((await shownHeroes()).filter((hero) => hero !== followUpHero)).toEqual([firstHero, nextHero]);
    await leaveAndReturn();
    expect(heroRequests).toBe(3);
  }).toPass({ timeout: 10000 });
  await expect(heading).toContainText(followUpHero);

  expect(await shownHeroes()).toEqual([firstHero, nextHero, followUpHero]);
  expect(heroResponses).toEqual([]);
  expect(heroRequests).toBe(3);
  expect(await page.evaluate(() => window.__unlabelledDocument)).toBe(true);
});

test("the referral box mounting after hydration starts from the newer cached copy", async ({ page, request, baseURL }) => {
  const publishedHeading = "Referral heading cached before the box mounted";
  const heading = page.locator(".ri-referral-heading");
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  const content = await controlContent(page);
  const referralRequests = () => content.requests.filter((resource) => resource === "referral-box").length;
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    await siteFooter(page).scrollIntoViewIfNeeded();
    await expect(heading).toHaveText("Join the Referral Program");
    await page.evaluate(() => { window.__mountDocument = true; });

    await contentControl(request, baseURL, { patch: { _id: "tooling-referralBox", heading: publishedHeading } });
    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.clock.fastForward("01:01");
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
    await siteFooter(page).scrollIntoViewIfNeeded();
    await expect(heading).toHaveText(publishedHeading);
    const requestsBeforeMount = referralRequests();

    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.evaluate(() => {
      window.__referralHeadings = [];
      new MutationObserver(() => {
        const text = document.querySelector(".ri-referral-heading")?.textContent;
        if (text) window.__referralHeadings.push(text);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
    await siteFooter(page).scrollIntoViewIfNeeded();
    await expect(heading).toHaveText(publishedHeading);
    const headings = await page.evaluate(() => window.__referralHeadings);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.filter((text) => text !== publishedHeading)).toEqual([]);
    expect(referralRequests()).toBe(requestsBeforeMount);
    expect(errors.filter((text) => /hydrat|did not match|#418|#423|#425/i.test(text))).toEqual([]);
    expect(await page.evaluate(() => window.__mountDocument)).toBe(true);
  } finally {
    await contentControl(request, baseURL, { reset: true });
  }
});

test("a publish during a content read never labels the new copy with the older revision", async ({ request, baseURL }) => {
  const publishedDuringRead = "Hero published during a read";
  const readHero = async () => {
    const response = await request.get("/api/content/hero");
    expect(response.status()).toBe(200);
    return response.json();
  };
  try {
    const before = await readHero();
    await contentControl(request, baseURL, { publishAfterRead: { _id: "tooling-hero", headingLine1: publishedDuringRead } });
    const during = await readHero();
    const after = await readHero();

    expect(before.data.headingLine1).not.toBe(publishedDuringRead);
    expect(after.data.headingLine1).toBe(publishedDuringRead);
    for (const [older, newer] of [[before, during], [during, after]]) {
      expect(newer.revision).toBeGreaterThanOrEqual(older.revision);
      if (newer.data.headingLine1 !== older.data.headingLine1) expect(newer.revision).toBeGreaterThan(older.revision);
    }
  } finally {
    await contentControl(request, baseURL, { reset: true });
  }
});

test("a packages section remounted after the cache updated starts from the newer cached copy", async ({ page, request, baseURL }) => {
  const publishedTag = "Offer tag published after the first load";
  await page.clock.install();
  const offers = page.locator("#packages");
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText("$149.95").first()).toBeVisible();
    await expect(offers.getByText(publishedTag, { exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.__remountDocument = true; });

    await contentControl(request, baseURL, { patch: { _id: "tooling-package-0", tag: publishedTag } });
    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.clock.fastForward("01:01");
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText(publishedTag, { exact: true })).toBeVisible();

    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.evaluate(() => {
      window.__offerStates = [];
      new MutationObserver(() => {
        const text = document.querySelector("#packages")?.innerText || "";
        if (text.includes("$149.95")) window.__offerStates.push(text.includes("Offer tag published after the first load"));
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText(publishedTag, { exact: true })).toBeVisible();
    const states = await page.evaluate(() => window.__offerStates);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((published) => !published)).toEqual([]);
    expect(await page.evaluate(() => window.__remountDocument)).toBe(true);
  } finally {
    await contentControl(request, baseURL, { reset: true });
  }
});

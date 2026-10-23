const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

test.use({ javaScriptEnabled: false, trace: process.env.CI ? "retain-on-failure" : "off", video: "off" });

const routes = fs.readdirSync("app", { recursive: true })
  .filter(file => file.endsWith("page.jsx") && !file.startsWith("admin/"))
  .map(file => `/${file.replace(/\/?page.jsx$/, "").replace("[slug]", "fixture")}`)
  .concat("/BIOSGuide", "/404").sort();

const expectedTypes = {
  "/": ["Organization", "WebSite", "WebPage", "Service", "OfferCatalog", "AggregateRating"],
  "/about": ["Organization"],
  "/faq": ["FAQPage"],
  "/packages": ["Service", "OfferCatalog"],
  "/BIOSGuide": ["Article"],
};

const minimumProperties = {
  Organization: ["name"],
  ContactPoint: ["email", "contactType", "url"],
  WebSite: ["name", "url"],
  WebPage: ["name", "url", "headline"],
  Service: ["name"],
  OfferCatalog: ["name", "itemListElement"],
  Offer: ["itemOffered", "price", "priceCurrency", "url"],
  AggregateRating: ["itemReviewed", "ratingValue", "ratingCount", "bestRating", "worstRating"],
  FAQPage: ["mainEntity"],
  Question: ["name", "acceptedAnswer"],
  Answer: ["text"],
  Article: ["headline", "mainEntityOfPage", "publisher"],
  ImageObject: ["url"],
};

const nodes = value => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
};

const normalize = value => String(value).replace(/\s+/g, " ").trim();
const absolute = value => {
  expect(typeof value).toBe("string");
  const url = new URL(value);
  expect(["https:", "http:"]).toContain(url.protocol);
  expect(url.hostname).not.toBe("");
};

const extract = page => page.locator('script[type="application/ld+json"]').allTextContents()
  .then(scripts => scripts.map(text => JSON.parse(text)));

const extractHtml = (page, html) => page.evaluate(source => {
  const document = new DOMParser().parseFromString(source, "text/html");
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(script => JSON.parse(script.textContent));
}, html);

const attach = async (testInfo, name, data) => {
  const file = testInfo.outputPath(`${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  await testInfo.attach(name, { path: file, contentType: "application/json" });
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const route of routes) {
  test(`no-JS structured data is valid for ${route}`, async ({ page }, testInfo) => {
    const response = await page.request.get(route, { maxRedirects: 0 });
    expect(response.status()).toBe(route === "/404" ? 404 : route === "/discord" ? 307 : 200);
    if (route === "/discord") {
      expect(response.headers().location).toBe("https://discord.com/invite/qs5HKNyazD");
    }
    const scripts = await extractHtml(page, await response.text());
    await attach(testInfo, "structured-data", { route, scripts });
    const roots = scripts.flatMap(item => item["@graph"] || [item]);
    expect(roots.map(node => node["@type"]).sort()).toEqual([...(expectedTypes[route] || [])].sort());
    for (const script of scripts) expect(script["@context"]).toMatch(/^https:\/\/schema\.org\/?$/);
    for (const node of nodes(scripts)) {
      if (node["@type"]) {
        expect(Object.keys(minimumProperties)).toContain(node["@type"]);
        for (const property of minimumProperties[node["@type"]]) {
          expect(node[property], `${route}: ${node["@type"]}.${property}`).toBeDefined();
          expect(node[property]).not.toBe("");
        }
      }
      for (const property of ["@id", "url", "logo", "mainEntityOfPage", "sameAs"]) {
        for (const value of [node[property]].flat().filter(Boolean)) {
          if (typeof value === "string") absolute(value);
        }
      }
    }
    const article = roots.find(node => node["@type"] === "Article");
    if (article) {
      const source = fs.readFileSync("public/BIOSGuide/index.html", "utf8");
      expect(await extractHtml(page, source)).toEqual(scripts);
      await page.goto(route);
      expect(normalize(await page.locator("h1").innerText())).toBe(article.headline);
      expect(article.mainEntityOfPage).toBe(await page.locator('link[rel="canonical"]').getAttribute("href"));
      expect(article.publisher.name).toBe("Roo Industries");
    }
  });
}

test("homepage markup advertises its displayed packages and no FAQ", async ({ page }, testInfo) => {
  await page.goto("/");
  const scripts = await extract(page);
  const all = nodes(scripts);
  await attach(testInfo, "homepage", scripts);
  expect(all.filter(node => ["FAQPage", "Review"].includes(node["@type"]))).toEqual([]);
  const webpage = all.find(node => node["@type"] === "WebPage");
  expect(webpage.headline).toBe(normalize(await page.locator("h1").first().innerText()));
});

test("homepage rating matches the stars on the review cards it renders", async ({ page }, testInfo) => {
  await page.goto("/");
  const all = nodes(await extract(page));
  const ratings = all.filter(node => node["@type"] === "AggregateRating");
  expect(ratings).toHaveLength(1);
  const [rating] = ratings;
  const service = all.find(node => node["@type"] === "Service" && node["@id"]);
  expect(rating.itemReviewed).toEqual({ "@id": service["@id"] });
  const stars = await page.locator('.ri-review-card[data-group-index="0"] [aria-label$="out of 5 stars"]')
    .evaluateAll(items => items.map(item => Number.parseInt(item.getAttribute("aria-label"), 10)));
  expect(stars.length).toBeGreaterThan(1);
  expect(new Set(stars).size).toBeGreaterThan(1);
  expect(rating.ratingCount).toBe(stars.length);
  expect(rating.ratingValue).toBe(Math.round((stars.reduce((sum, value) => sum + value, 0) / stars.length) * 100) / 100);
  expect(rating.bestRating).toBe(5);
  expect(rating.worstRating).toBe(1);
  await attach(testInfo, "homepage-rating", { rating, stars });
});

test.describe("home structured data during in-app navigation", () => {
  test.use({ javaScriptEnabled: true });

  test("home rating leaves with the review cards and returns once on Back", async ({ page, baseURL }, testInfo) => {
    const documents = [];
    page.on("request", request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
    });
    const snapshot = async () => {
      const all = nodes(await extract(page));
      return {
        url: page.url(),
        history: await page.evaluate(() => ({
          nextEntry: window.history.state?.__NA,
          legacyEntry: window.history.state?.__rooLegacy,
        })),
        cards: await page.locator(".ri-review-card").count(),
        ratings: all.filter(node => node["@type"] === "AggregateRating"),
        services: all.filter(node => node["@type"] === "Service" && node.hasOfferCatalog),
      };
    };

    await page.goto("/");
    await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
    const home = await snapshot();
    expect(home.ratings).toHaveLength(1);
    expect(home.services).toHaveLength(1);
    expect(home.cards).toBeGreaterThan(0);

    await page.locator(".ri-packages-review-link").click();
    await expect(page).toHaveURL(`${baseURL}/reviews`);
    await expect(page.locator('main [data-route-key="/reviews"]')).toBeVisible();
    await expect(page.locator(".ri-review-card")).toHaveCount(0);
    const reviews = await snapshot();
    await attach(testInfo, "home-navigation", { home, reviews, documents });
    await expect.poll(async () => (await snapshot()).ratings).toHaveLength(0);
    await expect.poll(async () => (await snapshot()).services).toHaveLength(0);

    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.locator('main [data-route-key="/"]')).toBeVisible();
    await expect.poll(async () => (await snapshot()).ratings).toEqual(home.ratings);
    const restored = await snapshot();
    expect(restored.services).toEqual(home.services);
    expect(restored.cards).toBeGreaterThan(0);
    expect(documents).toEqual([`${baseURL}/`]);
    await attach(testInfo, "home-navigation-restored", { home, reviews, restored, documents });
  });
});

test("FAQ markup matches every full answer rendered without JavaScript", async ({ page }, testInfo) => {
  await page.goto("/faq");
  const faq = nodes(await extract(page)).find(node => node["@type"] === "FAQPage");
  expect(faq).toBeDefined();
  const visible = await page.locator('noscript section[aria-label="Frequently asked questions"] > div').evaluateAll(items => items.map(item => ({
    question: item.querySelector("h2").textContent,
    answer: item.querySelector("p").textContent,
  })));
  expect(visible.length).toBeGreaterThan(10);
  expect(faq.mainEntity.map(item => ({ question: item.name, answer: item.acceptedAnswer.text }))).toEqual(visible);
  for (const item of visible) {
    await expect(page.getByRole("heading", { name: item.question, exact: true })).toBeVisible();
    expect(normalize(await page.locator("body").innerText())).toContain(normalize(item.answer));
  }
  await attach(testInfo, "faq-content", { faq, visible });
});

for (const route of ["/", "/packages"]) {
  test(`${route} catalog offers use the displayed package names, current prices and USD`, async ({ page }, testInfo) => {
    await page.goto(route);
    const all = nodes(await extract(page));
    const catalog = all.find(node => node["@type"] === "OfferCatalog");
    expect(catalog).toBeDefined();
    const service = all.find(node => node["@type"] === "Service" && node["@id"]);
    expect(service.hasOfferCatalog).toEqual({ "@id": catalog["@id"] });
    const visible = await page.locator(".ri-package-card").evaluateAll(cards => cards.map(card => ({
      name: card.querySelector("h3").textContent,
      price: card.querySelector(".ri-price-current").textContent,
    })));
    expect(visible.length).toBeGreaterThan(0);
    expect(catalog.itemListElement).toHaveLength(visible.length);
    for (const [index, item] of catalog.itemListElement.entries()) {
      expect(item["@type"]).toBe("Offer");
      expect(item.itemOffered["@type"]).toBe("Service");
      expect(item.itemOffered.name).toBe(visible[index].name);
      expect(visible[index].price).toMatch(/^\$[\d,.]+$/);
      expect(Number(item.price)).toBe(Number(visible[index].price.replace(/[$,]/g, "")));
      expect(item.priceCurrency).toBe("USD");
    }
    await attach(testInfo, "package-offers", { route, catalog, visible });
  });
}

test("entity IDs resolve consistently across all public pages", async ({ page }, testInfo) => {
  const all = [];
  for (const route of routes) {
    const response = await page.request.get(route, { maxRedirects: 0 });
    const found = nodes(await extractHtml(page, await response.text()));
    if (route !== "/") expect(found.filter(node => node["@type"] === "AggregateRating"), route).toEqual([]);
    all.push(...found);
  }
  const definitions = new Map();
  for (const node of all.filter(node => node["@id"] && node["@type"])) {
    if (definitions.has(node["@id"])) expect(node).toEqual(definitions.get(node["@id"]));
    else definitions.set(node["@id"], node);
  }
  for (const reference of all.filter(node => node["@id"] && !node["@type"])) {
    expect(definitions.has(reference["@id"]), reference["@id"]).toBe(true);
  }
  expect(all.filter(node => ["LocalBusiness", "Review", "Product", "SearchAction"].includes(node["@type"]))).toEqual([]);
  await attach(testInfo, "entity-definitions", Object.fromEntries(definitions));
});

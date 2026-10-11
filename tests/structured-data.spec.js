const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

test.use({ javaScriptEnabled: false, trace: "off", video: "off" });

const routes = fs.readdirSync("app", { recursive: true })
  .filter(file => file.endsWith("page.jsx") && !file.startsWith("admin/"))
  .map(file => `/${file.replace(/\/?page.jsx$/, "").replace("[slug]", "fixture")}`)
  .concat("/BIOSGuide", "/404").sort();

const expectedTypes = {
  "/": ["Organization", "WebSite", "WebPage", "Service"],
  "/about": ["Organization"],
  "/faq": ["FAQPage"],
  "/packages": ["OfferCatalog"],
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

test("homepage markup does not advertise undisplayed catalog or FAQ content", async ({ page }, testInfo) => {
  await page.goto("/");
  const scripts = await extract(page);
  const all = nodes(scripts);
  await attach(testInfo, "homepage", scripts);
  expect(all.filter(node => ["OfferCatalog", "FAQPage", "Review", "AggregateRating"].includes(node["@type"]))).toEqual([]);
  const webpage = all.find(node => node["@type"] === "WebPage");
  expect(webpage.headline).toBe(normalize(await page.locator("h1").first().innerText()));
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

test("catalog offers use the displayed package names, current prices and USD", async ({ page }, testInfo) => {
  await page.goto("/packages");
  const catalog = nodes(await extract(page)).find(node => node["@type"] === "OfferCatalog");
  expect(catalog).toBeDefined();
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
  await attach(testInfo, "package-offers", { catalog, visible });
});

test("entity IDs resolve consistently across all public pages", async ({ page }, testInfo) => {
  const all = [];
  for (const route of routes) {
    const response = await page.request.get(route, { maxRedirects: 0 });
    all.push(...nodes(await extractHtml(page, await response.text())));
  }
  const definitions = new Map();
  for (const node of all.filter(node => node["@id"] && node["@type"])) {
    if (definitions.has(node["@id"])) expect(node).toEqual(definitions.get(node["@id"]));
    else definitions.set(node["@id"], node);
  }
  for (const reference of all.filter(node => node["@id"] && !node["@type"])) {
    expect(definitions.has(reference["@id"]), reference["@id"]).toBe(true);
  }
  expect(all.filter(node => ["LocalBusiness", "Review", "AggregateRating", "Product", "SearchAction"].includes(node["@type"]))).toEqual([]);
  await attach(testInfo, "entity-definitions", Object.fromEntries(definitions));
});

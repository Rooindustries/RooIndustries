const { waitForRouteCommitted } = require("./fixtures/react-hydration.cjs");
const { test, expect } = require("@playwright/test");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");
const fs = require("node:fs/promises");
const { gzipSync } = require("node:zlib");

test.use({ javaScriptEnabled: true, viewport: { width: 390, height: 844 }, serviceWorkers: "block", trace: "off", video: "off" });

const attach = async (testInfo, name, value) => {
  const file = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: file, contentType: "application/json" });
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const contentURL = new URL(baseURL);
  contentURL.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  await guardBrowserContext(context, [baseURL, contentURL.origin]);
});

for (const route of ["/reviews", "/tools", "/packages", "/about"]) {
  test(`${route} loads its own page graph`, async ({ page }, testInfo) => {
    const scripts = [];
    const pending = [];
    page.on("response", response => {
      if (response.request().resourceType() !== "script") return;
      pending.push(response.body().then(body => scripts.push({ url: response.url(), body })).catch(() => {}));
    });
    await page.goto(route);
    await waitForRouteCommitted(page);
    await page.waitForTimeout(700);
    await Promise.all(pending);
    await attach(testInfo, "initial-page-scripts", scripts.map(({ url, body }) => ({ url, rawBytes: body.length, gzipBytes: gzipSync(body).length })));
    for (const marker of ["deferred-section-content", "ri-faq-question", "package-details-modal-title", "formspree.io", "[@portabletext/react]"]) {
      expect(scripts.filter(({ body }) => body.includes(marker)).map(({ url }) => url), marker).toEqual([]);
    }
  });
}

const routes = ["/", "/reviews", "/benchmarks", "/tools", "/meet-the-team"];
const navigateFromMenu = async (page, route) => {
  if (route === "/") {
    await page.locator('header a[href="/"]:visible').first().click();
    return;
  }
  if (route === "/tools") {
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    if (await menu.getAttribute("aria-expanded") === "true") await menu.click();
    await page.locator('footer a[href="/tools"]').click();
    return;
  }
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
  if (route === "/reviews" || route === "/benchmarks") {
    const proof = page.locator('#mobile-site-menu button[aria-controls="mobile-proof-menu"]');
    if (await proof.getAttribute("aria-expanded") !== "true") await proof.click();
  }
  await page.locator(`#mobile-site-menu a[href="${route}"]`).click();
};

const expectPage = async (page, route) => {
  if (route === "/") {
    await expect(page.locator("#top h1")).toBeVisible();
    await expect(page.locator("#services")).toBeAttached();
    return;
  }
  const headings = {
    "/reviews": "Community Reviews",
    "/benchmarks": "Performance Benchmarks",
    "/tools": "All Tools & Utilities",
    "/meet-the-team": "Meet the Team",
  };
  await expect(page.locator("#main-content").getByRole("heading", { name: headings[route], exact: true })).toBeVisible();
};

for (const origin of routes) {
  test(`${origin} can navigate to every other top-nav page and back`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && /hydration|didn't match|server rendered/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(origin);
    await waitForRouteCommitted(page);
    await expectPage(page, origin);
    await page.evaluate(() => { window.__routeEntryDocument = true; });
    const transitions = [];
    for (const destination of routes.filter(route => route !== origin)) {
      await navigateFromMenu(page, destination);
      await expect(page).toHaveURL(new RegExp(`${destination === "/" ? "/" : destination}$`));
      await expectPage(page, destination);
      expect(await page.evaluate(() => window.__routeEntryDocument)).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${origin === "/" ? "/" : origin}$`));
      await expectPage(page, origin);
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${destination === "/" ? "/" : destination}$`));
      await expectPage(page, destination);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${origin === "/" ? "/" : origin}$`));
      await expectPage(page, origin);
      expect(await page.evaluate(() => window.__routeEntryDocument)).toBe(true);
      transitions.push({ origin, destination, back: true, forward: true });
    }
    await attach(testInfo, "navigation-matrix", { transitions, errors });
    expect(errors).toEqual([]);
  });
}

test("a delayed home chunk preserves the current page until navigation is ready", async ({ page }, testInfo) => {
  await page.goto("/about");
  await waitForRouteCommitted(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = [];
  await page.route("**/_next/static/chunks/**", async route => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("deferred-section-content")) {
      delayed.push(route.request().url());
      await gate;
    }
    await route.fulfill({ response, body });
  });
  try {
    await page.locator('header a[href="/"]:visible').first().click();
    await expect.poll(() => delayed.length).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "About Roo Industries", exact: true })).toBeVisible();
    release();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#services")).toBeAttached();
    await attach(testInfo, "delayed-home-chunks", delayed);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("package details load on first keyboard open and restore focus on close", async ({ page }, testInfo) => {
  await page.goto("/packages");
  await waitForRouteCommitted(page);
  const button = page.locator(".ri-package-details-button").first();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("package-details.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("same-page hash history preserves an expanded FAQ answer", async ({ page }, testInfo) => {
  await page.goto("/#faq");
  await waitForRouteCommitted(page);
  const question = page.locator('#faq button[aria-expanded]').first();
  await expect(question).toBeVisible();
  await question.click();
  await expect(question).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => { window.location.hash = "packages"; });
  await expect(page).toHaveURL(/#packages$/);
  await page.goBack();
  await expect(page).toHaveURL(/#faq$/);
  await expect(question).toHaveAttribute("aria-expanded", "true");
  await attach(testInfo, "faq-history", { hash: "#faq", expanded: true });
});

test("a failed home import cannot replace a newer tools navigation", async ({ page }, testInfo) => {
  await page.goto("/about");
  await waitForRouteCommitted(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let intercepted = 0;
  let aborted = false;
  await page.route("**/_next/static/chunks/**", async route => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("deferred-section-content")) {
      intercepted += 1;
      await gate;
      await route.abort("failed");
      aborted = true;
      return;
    }
    await route.fulfill({ response, body });
  });
  try {
    await page.locator('header a[href="/"]:visible').first().click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await page.locator('footer a[href="/tools"]').click();
    await expect(page).toHaveURL(/\/tools$/);
    await expect(page.getByRole("heading", { name: "All Tools & Utilities", exact: true })).toBeVisible();
    release();
    await expect.poll(() => aborted).toBe(true);
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/tools$/);
    await expect(page.getByRole("heading", { name: "We couldn’t load this page." })).toHaveCount(0);
    await attach(testInfo, "superseded-home-import", { intercepted, aborted });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});


for (const provider of ["discord", "google"]) {
  test(`shared referral login preserves the ${provider} account-choice flow`, async ({ page }, testInfo) => {
    await page.goto(`/referrals/login?oauth=unlinked&provider=${provider}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No account linked yet", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/referrals\/login$/);
    await page.getByRole("button", { name: "Log in and link", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Referral code or login email", { exact: true })).toBeFocused();
    const choice = await page.evaluate(() => JSON.parse(sessionStorage.getItem("refPendingDiscordChoice")));
    expect(choice).toMatchObject({ state: "link", provider });
    await attach(testInfo, "account-choice", { provider, choice });
  });
}

for (const [entry, message] of [
  ["/referrals/login?notice=password-updated", /Password updated/i],
  ["/referrals/login?notice=email-confirmed", "Email confirmed. Log in to open your creator dashboard."],
  ["/referrals/login?oauth=unavailable", "Social sign-in is temporarily unavailable. Use your email or referral code."],
]) {
  test(`${entry} shows its notice and keeps the cleared URL`, async ({ page }, testInfo) => {
    await page.goto(entry);
    await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
    await expect(page.getByText(message)).toBeVisible();
    await waitForRouteCommitted(page);
    await expect(page).toHaveURL(/\/referrals\/login$/);
    await attach(testInfo, "cleared-notice", { entry, url: page.url() });
  });
}

test("a confirmation link keeps its cleared URL", async ({ page }, testInfo) => {
  await page.goto("/referrals/verify?source=email#token=fixture-token");
  await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
  await waitForRouteCommitted(page);
  await expect(page).toHaveURL(/\/referrals\/verify$/);
  await attach(testInfo, "cleared-confirmation", { url: page.url() });
});

const interceptOnDemandChunks = async (page, entry, handle) => {
  const initialChunks = new Set();
  await page.route(`**${entry.split("?")[0]}*`, async route => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const body = await response.text();
    for (const match of body.matchAll(/static\/chunks\/[^"'\\\s]+?\.js/g)) initialChunks.add(match[0]);
    await route.fulfill({ response, body });
  });
  const intercepted = [];
  await page.route("**/_next/static/chunks/**", async route => {
    const chunk = new URL(route.request().url()).pathname.replace(/^\/_next\//, "");
    if (initialChunks.has(chunk)) return route.fallback();
    intercepted.push(chunk);
    await handle(route);
  });
  return intercepted;
};

const loginIsCoveredByDialog = page => page.getByRole("button", { name: "Login", exact: true }).evaluate(button => {
  const box = button.getBoundingClientRect();
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return Boolean(top?.closest(".glass-overlay")) && !button.contains(top);
});

for (const provider of ["discord", "google"]) {
  test(`the ${provider} account choice blocks login while on-demand code is still downloading`, async ({ page }, testInfo) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const entry = `/referrals/login?oauth=unlinked&provider=${provider}`;
    const intercepted = await interceptOnDemandChunks(page, entry, async route => {
      await gate;
      await route.fallback().catch(() => {});
    });
    try {
      await page.goto(entry);
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole("button", { name: "Log in and link", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeVisible();
      expect(await loginIsCoveredByDialog(page)).toBe(true);
      await attach(testInfo, "held-on-demand-chunks", { provider, intercepted });
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test(`the ${provider} account choice still works when on-demand code fails to load`, async ({ page }, testInfo) => {
    const entry = `/referrals/login?oauth=unlinked&provider=${provider}`;
    const intercepted = await interceptOnDemandChunks(page, entry, route => route.abort("failed"));
    try {
      await page.goto(entry);
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });
      await page.getByRole("button", { name: "Log in and link", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByLabel("Referral code or login email", { exact: true })).toBeFocused();
      await expect(page.getByRole("heading", { name: "We couldn’t load this page." })).toHaveCount(0);
      const choice = await page.evaluate(() => JSON.parse(sessionStorage.getItem("refPendingDiscordChoice")));
      expect(choice).toMatchObject({ state: "link", provider });
      await attach(testInfo, "failed-on-demand-chunks", { provider, intercepted, choice });
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

const describeDialogMotion = () => {
  const panel = document.querySelector('[role="dialog"]');
  const overlay = panel?.parentElement;
  const describe = element => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      delay: style.animationDelay,
      easing: style.animationTimingFunction,
    };
  };
  return {
    overlay: describe(overlay),
    panel: describe(panel),
    closing: overlay?.hasAttribute("data-closing") ?? null,
    inert: panel?.inert ?? null,
  };
};

const finishDialogOpening = page => page.getByRole("dialog").evaluate(async dialog => {
  const animations = [dialog, dialog.parentElement].flatMap(element => element.getAnimations());
  await Promise.allSettled(animations.map(animation => animation.finished));
});

const dialogAnimations = page => page.evaluate(describeDialogMotion);

const recordDialogClosing = async page => {
  await page.evaluate(`window.__describeDialogMotion = ${describeDialogMotion.toString()}`);
  await page.evaluate(() => {
    window.__dialogClosing = null;
    const observer = new MutationObserver(() => {
      if (!document.querySelector("[data-closing]")) return;
      window.__dialogClosing = window.__describeDialogMotion();
      observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-closing"] });
  });
};

test("the account choice fades in and out around the sign-in step", async ({ page }, testInfo) => {
  const loginRequests = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/api\/ref\/login/.test(request.url())) loginRequests.push(request.url());
  });
  await page.goto("/referrals/login?oauth=unlinked&provider=discord");
  await expect(page.getByRole("dialog")).toBeVisible();
  const opening = await dialogAnimations(page);
  expect(opening.overlay).toEqual({ name: "siteDialogOverlayIn", duration: "0.3s", delay: "0s", easing: "ease-out" });
  expect(opening.panel).toEqual({ name: "siteDialogPanelIn", duration: "0.5s", delay: "0.16s", easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
  await finishDialogOpening(page);
  await page.getByLabel("Referral code or login email", { exact: true }).fill("fixture-creator");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  const loginBox = await page.getByRole("button", { name: "Login", exact: true }).boundingBox();
  const choice = page.getByRole("button", { name: "Log in and link", exact: true });
  const choiceBox = await choice.boundingBox();
  await recordDialogClosing(page);
  await choice.click();
  const closing = await page.evaluate(() => window.__dialogClosing);
  expect(closing.closing).toBe(true);
  expect(closing.inert).toBe(true);
  expect(closing.overlay).toEqual({ name: "siteDialogOverlayOut", duration: "0.2s", delay: "0s", easing: "ease-in" });
  expect(closing.panel).toEqual({ name: "siteDialogPanelOut", duration: "0.12s", delay: "0s", easing: "ease-in" });
  await page.mouse.click(choiceBox.x + choiceBox.width / 2, choiceBox.y + choiceBox.height / 2);
  await page.mouse.click(loginBox.x + loginBox.width / 2, loginBox.y + loginBox.height / 2);
  await expect(page.locator('[aria-labelledby="unlinked-discord-title"]')).toHaveCount(0);
  await expect(page.getByLabel("Referral code or login email", { exact: true })).toBeFocused();
  expect(loginRequests).toEqual([]);
  await attach(testInfo, "account-choice-motion", { opening, closing, loginRequests });
});

test("the account choice skips its motion when reduced motion is preferred", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/referrals/login?oauth=unlinked&provider=discord");
  await expect(page.getByRole("dialog")).toBeVisible();
  const opening = await dialogAnimations(page);
  expect(opening.overlay.name).toBe("none");
  expect(opening.panel.name).toBe("none");
  await page.getByRole("button", { name: "Log in and link", exact: true }).click();
  const closing = await dialogAnimations(page);
  expect(closing.overlay?.name ?? "none").toBe("none");
  await expect(page.locator('[aria-labelledby="unlinked-discord-title"]')).toHaveCount(0);
  await expect(page.getByLabel("Referral code or login email", { exact: true })).toBeFocused();
  await attach(testInfo, "account-choice-reduced-motion", { opening, closing });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`a rapid second click while the account choice closes keeps sign-in focused at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/referrals/login?oauth=unlinked&provider=discord");
    const choice = page.getByRole("button", { name: "Log in and link", exact: true });
    await expect(choice).toBeVisible();
    await finishDialogOpening(page);
    const box = await choice.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await page.waitForFunction(() => Boolean(document.querySelector("[data-closing]")));
    await page.mouse.click(x, y);
    await expect(page.locator('[aria-labelledby="unlinked-discord-title"]')).toHaveCount(0);
    await expect(page.getByLabel("Referral code or login email", { exact: true })).toBeFocused();
    const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    await attach(testInfo, "rapid-close-focus", { viewport, focused });
    expect(focused).toBe("ref-login-identifier");
  });
}

test("a looping animation inside the account choice doesn't keep its overlay after it closes", async ({ page }, testInfo) => {
  await page.goto("/referrals/login?oauth=unlinked&provider=discord");
  const choice = page.getByRole("button", { name: "Log in and link", exact: true });
  await expect(choice).toBeVisible();
  const looping = await page.getByRole("dialog").evaluate(dialog => {
    const spinner = document.createElement("span");
    spinner.setAttribute("data-test-spinner", "");
    spinner.style.display = "inline-block";
    spinner.style.width = "12px";
    spinner.style.height = "12px";
    dialog.append(spinner);
    const animation = spinner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 400, iterations: Infinity });
    return animation.effect.getComputedTiming().iterations;
  });
  expect(looping).toBe(Infinity);
  await choice.click();
  await expect(page.locator(".glass-overlay")).toHaveCount(0, { timeout: 2000 });
  expect(await loginIsCoveredByDialog(page)).toBe(false);
  const password = page.getByLabel("Password", { exact: true });
  await password.click();
  await expect(password).toBeFocused();
  await attach(testInfo, "looping-animation-close", { looping: String(looping) });
});

for (const [action, state] of [["pause", "paused"], ["cancel", "idle"]]) {
  const label = action === "pause" ? "paused" : "cancelled";
  test(`${label} account-choice exit animations still close the overlay`, async ({ page }, testInfo) => {
    await page.goto("/referrals/login?oauth=unlinked&provider=discord");
    await expect(page.getByRole("dialog")).toBeVisible();
    await finishDialogOpening(page);
    await page.evaluate(action => {
      window.__interruptedDialogExits = [];
      const observer = new MutationObserver(() => {
        const overlay = document.querySelector("[data-closing]");
        if (!overlay) return;
        const panel = overlay.querySelector('[role="dialog"]');
        for (const element of [overlay, panel]) {
          for (const animation of element.getAnimations()) {
            animation[action]();
            window.__interruptedDialogExits.push(animation.playState);
          }
        }
        observer.disconnect();
      });
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-closing"] });
    }, action);
    await page.getByRole("button", { name: "Log in and link", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__interruptedDialogExits.length)).toBeGreaterThan(0);
    const exits = await page.evaluate(() => window.__interruptedDialogExits);
    expect(exits.every(exit => exit === state)).toBe(true);
    await expect(page.locator(".glass-overlay")).toHaveCount(0, { timeout: 2000 });
    const identifier = page.getByLabel("Referral code or login email", { exact: true });
    await expect(identifier).toBeFocused();
    await identifier.fill("fixture@example.invalid");
    await expect(identifier).toHaveValue("fixture@example.invalid");
    await attach(testInfo, "interrupted-animation-close", { action, exits });
  });
}

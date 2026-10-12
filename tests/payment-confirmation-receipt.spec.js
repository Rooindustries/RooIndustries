const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({
  javaScriptEnabled: true,
  timezoneId: "Asia/Kolkata",
  reducedMotion: "reduce",
  actionTimeout: 10000,
  navigationTimeout: 30000,
  trace: "off",
  video: "off",
});

const neutralHeading = "Looking for your booking?";
const neutralBody = "This page shows your confirmation right after checkout. If you've booked with us, your confirmation email has the details.";
const pages = [
  { route: "/payment-success", heading: "Payment Successful", kind: "paid" },
  { route: "/thank-you", heading: "Thank You!", kind: "free" },
];
const mainCLS = {
  1440: {
    "/payment-success": {"load": 0.15141191772638607, "arrival": 0.1352803846760215},
    "/thank-you": {"load": 0.15145255358127635, "arrival": 0},
  },
  390: {
    "/payment-success": {"load": 0.1650772738369216, "arrival": 0.2512274503676441},
    "/thank-you": {"load": 0.16169327899999936, "arrival": 0},
  },
};

test.beforeEach(async ({ page, flow }) => {
  await page.addInitScript(() => {
    const metrics = window.__confirmationMetrics = {
      cls: 0,
      shifts: [],
      headings: [],
      sectionHeights: [],
      fallbackSeen: false,
    };
    let sessionValue = 0;
    let sessionStart = 0;
    let lastShift = 0;
    const layoutObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        if (entry.startTime - lastShift > 1000 || entry.startTime - sessionStart > 5000) {
          sessionValue = 0;
          sessionStart = entry.startTime;
        }
        sessionValue += entry.value;
        lastShift = entry.startTime;
        metrics.cls = Math.max(metrics.cls, sessionValue);
        metrics.shifts.push({
          value: entry.value,
          time: entry.startTime,
          sources: entry.sources.map(source => {
            const node = source.node?.nodeType === Node.TEXT_NODE ? source.node.parentElement : source.node;
            return {
              element: node?.tagName,
              text: node?.textContent.slice(0, 80),
              confirmation: Boolean(node?.closest('[role="dialog"] section')),
              previous: source.previousRect.toJSON(),
              current: source.currentRect.toJSON(),
            };
          }),
        });
      }
    });
    layoutObserver.observe({ type: "layout-shift", buffered: true });
    window.__resetConfirmationMetrics = () => {
      layoutObserver.takeRecords();
      Object.assign(metrics, { cls: 0, shifts: [], headings: [], sectionHeights: [], fallbackSeen: false });
      sessionValue = 0;
      sessionStart = 0;
      lastShift = 0;
    };
    const sections = new WeakSet();
    new MutationObserver(() => {
      if (["/payment-success", "/thank-you"].includes(location.pathname) &&
          document.querySelector('[role="dialog"]')?.textContent.includes("Loading...")) metrics.fallbackSeen = true;
      const heading = [...document.querySelectorAll("h1")].map(node => node.textContent.trim()).join(" | ");
      if (heading && heading !== metrics.headings.at(-1)) metrics.headings.push(heading);
      const section = document.querySelector("h1")?.closest("section");
      if (section && !sections.has(section)) {
        sections.add(section);
        new ResizeObserver(entries => {
          for (const { target } of entries) {
            if (target.isConnected && target.offsetHeight > 0 && target.querySelector("h1") && !metrics.sectionHeights.includes(target.offsetHeight)) metrics.sectionHeights.push(target.offsetHeight);
          }
        }).observe(section);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.route("**/api/ref/sendBookingEmails", route => {
    flow.state.calls.push({ path: "/api/ref/sendBookingEmails", body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true, emailDispatch: { allSent: true } } });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) {
    const screenshot = testInfo.outputPath("confirmation.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach("confirmation", { path: screenshot, contentType: "image/png" });
  }
});

async function capture(page, testInfo, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(1100);
  const metrics = await page.evaluate(() => ({
    ...window.__confirmationMetrics,
    h1Count: document.querySelectorAll("h1").length,
    heading: document.querySelector("h1")?.textContent.trim(),
    sectionHeight: document.querySelector("h1")?.closest("section")?.getBoundingClientRect().height,
    documentWidth: document.documentElement.scrollWidth,
  }));
  metrics.baseline = {
    commit: "45bbda83",
    limits: mainCLS[page.viewportSize().width][new URL(page.url()).pathname],
  };
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(metrics, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  return metrics;
}

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || /hydrat|server html|getServerSnapshot|#418/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const { route, heading, kind } of pages) {
      test(`direct visit to ${route} shows neutral recovery links`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        const response = await page.goto(route, { waitUntil: "networkidle" });
        const metrics = await capture(page, testInfo, "direct");
        expect(metrics.h1Count).toBe(1);
        expect(metrics.fallbackSeen).toBe(false);
        expect.soft(metrics.cls).toBeLessThanOrEqual(mainCLS[viewport.width][route].load);
        await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
        await expect(page.getByText(neutralBody, { exact: true })).toBeVisible();
        await expect(page.getByText(/Payment Successful|Booking confirmed|Your booking has been confirmed|your booking is confirmed/i)).toHaveCount(0);
        expect((await response.text()).includes(neutralHeading)).toBe(true);
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        await page.getByRole("link", { name: "Book a session", exact: true }).click();
        await expect(page).toHaveURL(/\/booking$/);
        await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
        await page.getByRole("link", { name: "Contact us", exact: true }).click();
        await expect(page).toHaveURL(/\/contact$/);
        await expect(page.locator("main")).toBeVisible();
        expect(errors).toEqual([]);
      });

      test(`${kind} booking arrival at ${route} keeps its receipt on reload`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        let finalizeRoute;
        const bookingConfirmation = { bookingId: `fixture-${kind}-receipt`, emailDispatchToken: `fixture-${kind}-email-token` };
        const quote = { grossAmount: 84.99, netAmount: 0, isFree: true };
        const providers = { dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } };
        if (kind === "free") {
          await page.route("**/api/payment/quote", route => route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-free-quote", providers, quote } }));
          await page.route("**/api/payment/start", route => {
            expect(route.request().postDataJSON().provider).toBe("free");
            return route.fulfill({ json: { ok: true, status: "booked", ...bookingConfirmation, quote } });
          });
        } else {
          await page.route("**/api/payment/finalize", route => {
            expect(route.request().headers().authorization).toBe("Bearer fixture-payment");
            finalizeRoute = route;
          });
        }
        await flow.review();
        await flow.payment();
        if (kind === "paid") {
          await page.getByRole("button", { name: "Pay your way", exact: true }).click();
          await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
          await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
          await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
          await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1000);
        await page.evaluate(() => window.__resetConfirmationMetrics());
        if (kind === "paid") await finalizeRoute.fulfill({ json: { ok: true, status: "booked", ...bookingConfirmation } });
        if (kind === "free") await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${route}$`));
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "Back to Home", exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.history.state.usr.bookingConfirmation)).toEqual(bookingConfirmation);
        const arrival = await capture(page, testInfo, "arrival");
        expect(arrival.h1Count).toBe(1);
        expect.soft(arrival.cls).toBeLessThanOrEqual(mainCLS[viewport.width][route].arrival);
        expect(arrival.headings).not.toContain(neutralHeading);
        await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails").length).toBe(1);
        await page.evaluate(() => sessionStorage.removeItem("booking_confirmation_state"));
        const response = await page.reload({ waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        const reloaded = await capture(page, testInfo, "reload");
        expect(reloaded.h1Count).toBe(1);
        expect(reloaded.fallbackSeen).toBe(false);
        expect(reloaded.sectionHeights).toHaveLength(1);
        expect.soft(reloaded.cls).toBeLessThanOrEqual(mainCLS[viewport.width][route].load);
        expect((await response.text()).includes(neutralHeading)).toBe(true);
        expect(await page.evaluate(() => window.history.state.usr.bookingConfirmation)).toEqual(bookingConfirmation);
        await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails").length).toBe(2);
        expect(errors).toEqual([]);
      });

      for (const stored of ["{", JSON.stringify({ emailDispatchToken: "fixture-token" }), JSON.stringify({ bookingId: "  " }), JSON.stringify({ bookingId: { id: "fixture-booking" } })]) {
        test(`${route} ignores unusable receipt ${stored}`, async ({ page, flow }) => {
          const errors = watchErrors(page);
          await page.addInitScript(value => {
            sessionStorage.setItem("booking_confirmation_state", value);
            history.replaceState({ ...history.state, usr: { backgroundLocation: { pathname: "/" }, bookingData: { email: "visitor@example.invalid" } } }, "");
          }, stored);
          await page.goto(route, { waitUntil: "networkidle" });
          await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
          await expect(page.locator("h1")).toHaveCount(1);
          expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
          expect(errors).toEqual([]);
        });
      }

      test(`${route} accepts a stored booking ID without an email token`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        await page.addInitScript(() => sessionStorage.setItem("booking_confirmation_state", JSON.stringify({ bookingId: "fixture-stored-booking" })));
        await page.goto(route, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        const metrics = await capture(page, testInfo, "stored");
        expect(metrics.h1Count).toBe(1);
        expect.soft(metrics.cls).toBeLessThanOrEqual(mainCLS[viewport.width][route].load);
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        expect(errors).toEqual([]);
      });

      test(`${route} reads history when browser storage is unavailable`, async ({ page }, testInfo) => {
        const errors = watchErrors(page);
        await page.addInitScript(() => {
          history.replaceState({ ...history.state, usr: { bookingConfirmation: { bookingId: "fixture-history-booking" }, modal: true, backgroundLocation: { pathname: "/" } } }, "");
          const getItem = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            if (key === "booking_confirmation_state") throw new Error("Storage unavailable");
            return getItem.call(this, key);
          };
        });
        await page.goto(route, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        const metrics = await capture(page, testInfo, "history");
        expect(metrics.h1Count).toBe(1);
        expect.soft(metrics.cls).toBeLessThanOrEqual(mainCLS[viewport.width][route].load);
        expect(errors).toEqual([]);
      });

      test(`${route} stays neutral when receipt storage is unavailable`, async ({ page, flow }) => {
        const errors = watchErrors(page);
        await page.addInitScript(() => {
          const getItem = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            if (key === "booking_confirmation_state") throw new Error("Storage unavailable");
            return getItem.call(this, key);
          };
        });
        await page.goto(route, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
        await expect(page.locator("h1")).toHaveCount(1);
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  });
}

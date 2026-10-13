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
const cpuRate = Number(process.env.ROO_CONFIRMATION_CPU_RATE || 1);

test.beforeEach(async ({ page, flow }) => {
  if (!Number.isFinite(cpuRate) || cpuRate < 1) throw new Error("Invalid confirmation CPU rate");
  if (cpuRate > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  }
  await page.addInitScript(() => {
    const metrics = window.__confirmationMetrics = {
      cls: 0,
      shifts: [],
      headings: [],
      sectionHeights: [],
      receiptDecisionAt: null,
      panelLayouts: [],
      panelChanges: [],
      panelLayoutChecks: 0,
      fallbackSeen: false,
      dialogResizes: [],
    };
    const nodeScopes = new WeakMap();
    const panels = new Set();
    const dialogSizes = new WeakMap();
    const dialogObserver = new ResizeObserver(entries => {
      for (const { target, contentRect } of entries) {
        if (!target.isConnected) continue;
        const size = `${Math.round(contentRect.width)}x${Math.round(contentRect.height)}`;
        const previous = dialogSizes.get(target);
        dialogSizes.set(target, size);
        if (previous && previous !== size) metrics.dialogResizes.push({
          time: performance.now(), from: previous, to: size, visible: getComputedStyle(target).visibility === "visible",
        });
      }
    });
    let panelLayouts = new WeakMap();
    let awaitingReceiptDecision = false;
    const position = node => {
      let x = 0, y = 0;
      for (let current = node; current; current = current.offsetParent) {
        x += current.offsetLeft;
        y += current.offsetTop;
      }
      return { x, y };
    };
    const samplePanels = () => {
      for (const panel of panels) {
        if (!panel.isConnected || !panel.offsetHeight) continue;
        const content = [panel.querySelector("h1"), panel.querySelector("p"), panel.querySelector("a[href]")?.parentElement];
        if (content.some(node => !node)) continue;
        const origin = position(panel);
        const layout = {
          width: panel.offsetWidth,
          height: panel.offsetHeight,
          top: panel.offsetTop,
          content: content.map(node => {
            const point = position(node);
            return { x: point.x - origin.x, y: point.y - origin.y, width: node.offsetWidth, height: node.offsetHeight };
          }),
        };
        metrics.panelLayoutChecks += 1;
        const previous = panelLayouts.get(panel);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(layout)) {
          metrics.panelLayouts.push({ time: performance.now(), ...layout });
          if (previous) metrics.panelChanges.push({ time: performance.now(), before: previous, after: layout });
          panelLayouts.set(panel, layout);
        }
        if (!metrics.sectionHeights.includes(layout.height)) metrics.sectionHeights.push(layout.height);
      }
    };
    const identifyNodes = () => {
      const dialog = document.querySelector('[role="dialog"].ri-booking');
      const scaler = dialog?.querySelector('[data-booking-scaler]');
      if (dialog && !dialogSizes.has(dialog)) {
        dialogSizes.set(dialog, "");
        dialogObserver.observe(dialog);
      }
      for (const [node, selector] of [
        [dialog, '[role="dialog"].ri-booking'],
        [scaler, '[data-booking-scaler]'],
        [scaler?.firstElementChild, '[data-booking-scaler] > div'],
        [dialog?.querySelector('#booking-modal-close'), '#booking-modal-close'],
      ]) {
        if (node) nodeScopes.set(node, { scope: "modal-shell", selector });
      }
      if (["/booking", "/payment"].includes(location.pathname)) {
        for (const node of dialog?.querySelectorAll("*") || []) {
          if (!nodeScopes.has(node)) nodeScopes.set(node, {
            scope: "checkout-content",
            selector: node.id ? "#" + node.id : '[role="dialog"] ' + node.tagName.toLowerCase(),
          });
        }
      }
      const heading = dialog?.querySelector("h1");
      if (!heading || !["Looking for your booking?", "Payment Successful", "Thank You!"].includes(heading.textContent.trim())) return;
      const panel = heading.closest("section");
      if (!panel) return;
      panels.add(panel);
      for (const node of [panel, ...panel.querySelectorAll("*")]) {
        nodeScopes.set(node, { scope: "receipt-panel", selector: node === panel ? '[role="dialog"] section' : '[role="dialog"] section ' + node.tagName.toLowerCase() });
      }
      if (awaitingReceiptDecision) {
        metrics.receiptDecisionAt = performance.now();
        awaitingReceiptDecision = false;
      }
    };
    let sessionValue = 0;
    let sessionStart = 0;
    let lastShift = 0;
    const layoutObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          if (entry.startTime - lastShift > 1000 || entry.startTime - sessionStart > 5000) {
            sessionValue = 0;
            sessionStart = entry.startTime;
          }
          sessionValue += entry.value;
          lastShift = entry.startTime;
          metrics.cls = Math.max(metrics.cls, sessionValue);
        }
        metrics.shifts.push({
          value: entry.value,
          time: entry.startTime,
          hadRecentInput: entry.hadRecentInput,
          sources: entry.sources.map(source => {
            const node = source.node?.nodeType === Node.TEXT_NODE ? source.node.parentElement : source.node;
            return {
              element: node?.tagName,
              text: node?.textContent.slice(0, 80),
              ...(nodeScopes.get(node) || { scope: "outside", selector: node?.id ? "#" + node.id : node?.tagName?.toLowerCase() }),
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
      Object.assign(metrics, { cls: 0, shifts: [], headings: [], sectionHeights: [], receiptDecisionAt: null, panelLayouts: [], panelChanges: [], panelLayoutChecks: 0, fallbackSeen: false, dialogResizes: [] });
      panelLayouts = new WeakMap();
      awaitingReceiptDecision = true;
      sessionValue = 0;
      sessionStart = 0;
      lastShift = 0;
      samplePanels();
    };
    window.__markReceiptDecision = () => {
      if (metrics.receiptDecisionAt === null) metrics.receiptDecisionAt = performance.now();
      awaitingReceiptDecision = false;
      samplePanels();
    };
    new MutationObserver(() => {
      if (["/payment-success", "/thank-you"].includes(location.pathname) &&
          document.querySelector('[role="dialog"]')?.textContent.includes("Loading...")) metrics.fallbackSeen = true;
      const heading = [...document.querySelectorAll("h1")].map(node => node.textContent.trim()).join(" | ");
      if (heading && heading !== metrics.headings.at(-1)) metrics.headings.push(heading);
      identifyNodes();
      samplePanels();
    }).observe(document, { childList: true, subtree: true, characterData: true });
    const sampleFrame = () => {
      samplePanels();
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
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
    if (window.__confirmationMetrics.receiptDecisionAt === null) window.__markReceiptDecision();
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
  metrics.cpuRate = cpuRate;
  for (const shift of metrics.shifts) {
    shift.panelSource = shift.sources.some(source => source.scope === "receipt-panel");
    shift.afterReceiptDecision = metrics.receiptDecisionAt !== null && shift.time >= metrics.receiptDecisionAt;
    shift.excludedModalTransition = shift.sources.length > 0 && shift.sources.every(source => ["modal-shell", "checkout-content"].includes(source.scope));
  }
  metrics.receiptShifts = metrics.shifts.filter(shift => shift.value > 0 &&
    (shift.panelSource || (shift.afterReceiptDecision && !shift.excludedModalTransition)));
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(metrics, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  return metrics;
}

function assertReceiptLayout(metrics) {
  expect(metrics.panelLayoutChecks).toBeGreaterThan(0);
  expect(metrics.panelLayouts).not.toEqual([]);
  expect(metrics.panelChanges).toEqual([]);
  expect(metrics.receiptShifts).toEqual([]);
}

function watchErrors(page, expectedEmailStatus = 0) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (expectedEmailStatus >= 400 && message.location().url.endsWith("/api/ref/sendBookingEmails") &&
        message.text().startsWith("Failed to load resource:") && message.text().includes(`status of ${expectedEmailStatus}`)) return;
    if (message.type() === "error" || /hydrat|server html|getServerSnapshot|#418/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function openPendingPaidCheckout(page, flow) {
  let finalizeRoute;
  await page.route("**/api/payment/finalize", route => {
    expect(route.request().headers().authorization).toBe("Bearer fixture-payment");
    finalizeRoute = route;
  });
  await flow.review();
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
  await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
  await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  return bookingId => finalizeRoute.fulfill({ json: {
    ok: true, status: "booked", provider: "dodo", bookingId,
    emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
    emailDispatchToken: "",
  } });
}

const focusIsInBookingDialog = page => page.evaluate(() =>
  Boolean(document.activeElement?.closest('[role="dialog"].ri-booking')));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const { route, heading, kind } of pages) {
      test(`direct visit to ${route} shows neutral recovery links`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        const response = await page.goto(route, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
        const metrics = await capture(page, testInfo, "direct");
        expect(metrics.h1Count).toBe(1);
        expect(metrics.fallbackSeen).toBe(false);
        assertReceiptLayout(metrics);
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
        const completed = { ok: true, status: "email_partial", ...bookingConfirmation,
          emailDispatch: { allSent: false, client: { sent: false }, owner: { sent: false } } };
        const quote = { grossAmount: 84.99, netAmount: 0, isFree: true };
        const providers = { dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } };
        if (kind === "free") {
          await page.route("**/api/payment/quote", route => route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-free-quote", providers, quote } }));
          await page.route("**/api/payment/start", route => {
            expect(route.request().postDataJSON().provider).toBe("free");
            return route.fulfill({ json: { ...completed, quote } });
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
        const completedAt = Date.now();
        if (kind === "paid") await finalizeRoute.fulfill({ json: completed });
        if (kind === "free") await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${route}$`), { timeout: 1000 });
        await testInfo.attach("arrival-navigation", { body: JSON.stringify({ elapsedMs: Date.now() - completedAt }), contentType: "application/json" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        expect(await focusIsInBookingDialog(page)).toBe(true);
        await expect(page.getByRole("link", { name: "Back to Home", exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.history.state.usr.bookingConfirmation)).toEqual({ bookingId: bookingConfirmation.bookingId });
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state")))).toEqual({ bookingId: bookingConfirmation.bookingId });
        const arrival = await capture(page, testInfo, "arrival");
        expect(arrival.h1Count).toBe(1);
        expect(arrival.fallbackSeen).toBe(false);
        assertReceiptLayout(arrival);
        expect(arrival.headings).not.toContain(neutralHeading);
        await expect.poll(() => flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails").length).toBe(1);
        await page.evaluate(() => sessionStorage.removeItem("booking_confirmation_state"));
        const response = await page.reload({ waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        const reloaded = await capture(page, testInfo, "reload");
        expect(reloaded.h1Count).toBe(1);
        expect(reloaded.fallbackSeen).toBe(false);
        expect(reloaded.sectionHeights).toHaveLength(1);
        assertReceiptLayout(reloaded);
        expect((await response.text()).includes(neutralHeading)).toBe(true);
        expect(await page.evaluate(() => window.history.state.usr.bookingConfirmation)).toEqual({ bookingId: bookingConfirmation.bookingId });
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toHaveLength(1);
        expect(errors).toEqual([]);
      });

      for (const stored of ["{", JSON.stringify({ emailDispatchToken: "fixture-token" }), JSON.stringify({ bookingId: "  " }), JSON.stringify({ bookingId: { id: "fixture-booking" } })]) {
        test(`${route} ignores unusable receipt ${stored}`, async ({ page, flow }, testInfo) => {
          const errors = watchErrors(page);
          await page.addInitScript(value => {
            sessionStorage.setItem("booking_confirmation_state", value);
            history.replaceState({ ...history.state, usr: { backgroundLocation: { pathname: "/" }, bookingData: { email: "visitor@example.invalid" } } }, "");
          }, stored);
          await page.goto(route, { waitUntil: "networkidle" });
          await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
          await expect(page.locator("h1")).toHaveCount(1);
          assertReceiptLayout(await capture(page, testInfo, "unusable"));
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
        assertReceiptLayout(metrics);
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        assertReceiptLayout(await capture(page, testInfo, "stored-reload"));
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
        assertReceiptLayout(metrics);
        expect(errors).toEqual([]);
      });

      test(`${route} stays neutral when receipt storage is unavailable`, async ({ page, flow }, testInfo) => {
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
        assertReceiptLayout(await capture(page, testInfo, "unavailable"));
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        expect(errors).toEqual([]);
      });
    }

    for (const { route, heading } of pages) {
      for (const outcome of ["delivered", 400, 401, 403, 404, "booking_inactive"]) {
        test(`${route} email cleanup ${outcome} preserves only active receipts`, async ({ page }, testInfo) => {
          const errors = watchErrors(page, outcome === "booking_inactive" ? 409 : typeof outcome === "number" ? outcome : 0);
          const receipt = { bookingId: "fixture-email-cleanup", emailDispatchToken: "fixture-email-retry" };
          let dispatchRoute;
          let dispatchCalls = 0;
          await page.addInitScript(confirmation => {
            if (sessionStorage.getItem("fixture-confirmation-seeded")) return;
            sessionStorage.setItem("fixture-confirmation-seeded", "1");
            sessionStorage.setItem("booking_confirmation_state", JSON.stringify(confirmation));
            history.replaceState({ ...history.state, usr: { bookingConfirmation: confirmation, modal: true, backgroundLocation: { pathname: "/" }, retained: "fixture-retained" } }, "");
          }, receipt);
          await page.route("**/api/ref/sendBookingEmails", request => {
            expect(request.request().postDataJSON()).toEqual(receipt);
            dispatchCalls += 1;
            dispatchRoute = request;
          });
          await page.goto(route, { waitUntil: "domcontentloaded" });
          await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
          await expect.poll(() => Boolean(dispatchRoute)).toBe(true);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(1000);
          assertReceiptLayout(await capture(page, testInfo, "before-email-cleanup"));
          const stateBefore = await page.evaluate(() => history.state.usr);
          await page.evaluate(() => window.__resetConfirmationMetrics());
          const inactive = outcome === "booking_inactive";
          const delivered = outcome === "delivered";
          await dispatchRoute.fulfill({ status: inactive ? 409 : delivered ? 200 : outcome, json: delivered
            ? { ok: true, emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } } }
            : inactive ? { ok: false, code: "booking_inactive", retryable: false, emailDispatch: { allSent: false, client: { sent: false }, owner: { sent: false } } }
              : { ok: false, error: "Booking email confirmation is not authorized." } });
          await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state"))))
            .toEqual(inactive ? null : { bookingId: receipt.bookingId });
          const stateAfter = { ...stateBefore };
          if (inactive) delete stateAfter.bookingConfirmation;
          else stateAfter.bookingConfirmation = { bookingId: receipt.bookingId };
          await expect.poll(() => page.evaluate(() => history.state.usr)).toEqual(stateAfter);
          const expectedHeading = inactive ? neutralHeading : heading;
          await expect(page.getByRole("heading", { level: 1, name: expectedHeading, exact: true })).toBeVisible();
          const cleaned = await capture(page, testInfo, "after-email-cleanup");
          expect(cleaned.h1Count).toBe(1);
          assertReceiptLayout(cleaned);
          if (!inactive) expect(cleaned.headings).not.toContain(neutralHeading);
          await page.reload({ waitUntil: "networkidle" });
          await expect(page.getByRole("heading", { level: 1, name: expectedHeading, exact: true })).toBeVisible();
          const reloaded = await capture(page, testInfo, "cleanup-reload");
          expect(reloaded.h1Count).toBe(1);
          assertReceiptLayout(reloaded);
          expect(await page.evaluate(() => history.state.usr)).toEqual(stateAfter);
          expect(dispatchCalls).toBe(1);
          expect(errors).toEqual([]);
        });
      }
    }

    test("paid arrival swaps checkout for the confirmation without moving the dialog", async ({ page, flow }, testInfo) => {
      const errors = watchErrors(page);
      const completePayment = await openPendingPaidCheckout(page, flow);
      await page.screenshot({ path: testInfo.outputPath("checkout.png") });
      await page.evaluate(() => window.__resetConfirmationMetrics());
      await completePayment("fixture-paid-steady-dialog");
      await expect(page).toHaveURL(/\/payment-success$/);
      await expect(page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })).toBeVisible();
      expect(await focusIsInBookingDialog(page)).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"].ri-booking').getBoundingClientRect();
        const content = document.querySelector("[data-booking-scaler] > div").getBoundingClientRect();
        return Math.abs(dialog.width - content.width) < 1 && Math.abs(dialog.height - content.height) < 1;
      })).toBe(true);
      const switchedAt = await page.evaluate(() => window.__confirmationMetrics.receiptDecisionAt);
      expect(switchedAt).not.toBeNull();
      const arrival = await capture(page, testInfo, "steady-arrival");
      expect(arrival.fallbackSeen).toBe(false);
      expect(arrival.shifts.filter(shift => shift.time >= switchedAt && shift.sources.some(source =>
        !source.element || ["modal-shell", "checkout-content"].includes(source.scope)))).toEqual([]);
      expect(arrival.dialogResizes.filter(resize => resize.time >= switchedAt && resize.visible)).toEqual([]);
      expect(arrival.cls).toBeLessThan(0.1);
      assertReceiptLayout(arrival);
      expect(await focusIsInBookingDialog(page)).toBe(true);
      expect(errors).toEqual([]);
    });

    test("paid arrival reveals the dialog when animation frames are stalled", async ({ page, flow }, testInfo) => {
      const errors = watchErrors(page);
      await page.addInitScript(() => {
        const request = window.requestAnimationFrame.bind(window);
        const cancel = window.cancelAnimationFrame.bind(window);
        const stalled = new Map();
        const resumed = new Map();
        let stalledHandle = 0;
        window.requestAnimationFrame = callback => {
          if (!window.__animationFramesStalled) return request(callback);
          stalledHandle -= 1;
          stalled.set(stalledHandle, callback);
          return stalledHandle;
        };
        window.cancelAnimationFrame = handle => {
          if (!stalled.delete(handle)) cancel(resumed.get(handle) ?? handle);
        };
        window.__resumeAnimationFrames = () => {
          window.__animationFramesStalled = false;
          for (const [handle, callback] of stalled) resumed.set(handle, request(callback));
          stalled.clear();
        };
      });
      const completePayment = await openPendingPaidCheckout(page, flow);
      await page.evaluate(() => { window.__animationFramesStalled = true; });
      const completedAt = Date.now();
      await completePayment("fixture-paid-stalled-frames");
      await expect(page).toHaveURL(/\/payment-success$/);
      await expect(page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })).toBeVisible();
      const shownAfterMs = Date.now() - completedAt;
      expect(await page.evaluate(() => window.__animationFramesStalled)).toBe(true);
      expect(await focusIsInBookingDialog(page)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("stalled-frames.png") });
      await page.evaluate(() => window.__resumeAnimationFrames());
      await expect.poll(() => page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })
        .evaluate(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))).toBe(true);
      await expect(page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to Home", exact: true })).toBeVisible();
      await testInfo.attach("stalled-frames", { body: JSON.stringify({ shownAfterMs }), contentType: "application/json" });
      expect(errors).toEqual([]);
    });

    for (const chunkState of ["failed", "delayed"]) {
      test(`paid arrival leaves checkout with a ${chunkState} confirmation chunk`, async ({ page, flow, baseURL }, testInfo) => {
        const pageErrors = [];
        const chunks = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.addInitScript(() => {
          window.__confirmationRejections = [];
          window.addEventListener("unhandledrejection", event => {
            window.__confirmationRejections.push(String(event.reason?.message || event.reason));
          });
        });
        const bookingId = `fixture-paid-confirmation-${chunkState}`;
        const completed = {
          ok: true, status: "booked", provider: "dodo", bookingId,
          emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
          emailDispatchToken: "",
        };
        let finalizeRoute;
        await page.route("**/api/payment/finalize", route => {
          expect(route.request().headers().authorization).toBe("Bearer fixture-payment");
          finalizeRoute = route;
        });
        await flow.review();
        await flow.payment();
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);

        let releaseChunk;
        let delayTimer;
        const delayedChunk = new Promise(resolve => { releaseChunk = resolve; });
        const interceptChunk = async route => {
          expect(new URL(route.request().url()).origin).toBe(new URL(baseURL).origin);
          const response = await route.fetch({ maxRetries: 2 });
          const body = await response.text();
          if (!body.includes(neutralHeading) || !body.includes("Payment Successful")) return route.fulfill({ response, body });
          const chunk = { url: route.request().url(), requestedAt: Date.now(), fulfilledAt: null };
          chunks.push(chunk);
          if (chunkState === "failed") return route.abort("failed");
          delayTimer = setTimeout(releaseChunk, 10_000);
          await delayedChunk;
          await route.fulfill({ response, body });
          chunk.fulfilledAt = Date.now();
        };
        await page.route("**/_next/static/chunks/**", interceptChunk);
        try {
          await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
          await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
          await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toBeVisible();
          await expect.poll(() => chunks.length).toBeGreaterThan(0);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(1000);
          await page.evaluate(() => window.__resetConfirmationMetrics());
          const completedAt = Date.now();
          await finalizeRoute.fulfill({ json: completed });
          await expect(page).toHaveURL(/\/payment-success$/, { timeout: 3000 });
          const navigationMs = Date.now() - completedAt;
          await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toHaveCount(0);
          expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state")))).toEqual({ bookingId });
          if (chunkState === "failed") {
            await expect(page.getByRole("heading", { name: "We couldn’t load this page.", exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeVisible();
          } else {
            expect(chunks.every(chunk => chunk.fulfilledAt === null)).toBe(true);
            await expect(page.getByRole("dialog").getByText("Loading...", { exact: true })).toBeVisible();
            await expect(page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })).toBeVisible({ timeout: 12_000 });
            expect(chunks.some(chunk => chunk.fulfilledAt !== null && chunk.fulfilledAt - chunk.requestedAt >= 10_000)).toBe(true);
          }
          const unhandledRejections = await page.evaluate(() => window.__confirmationRejections);
          await testInfo.attach("confirmation-chunk", { body: JSON.stringify({
            chunkState, navigationMs, url: page.url(), chunks, pageErrors, unhandledRejections,
          }), contentType: "application/json" });
          expect(unhandledRejections).toEqual([]);
          expect(pageErrors).toEqual([]);
          await capture(page, testInfo, `${chunkState}-chunk-arrival`);
          if (chunkState === "failed") {
            await page.unroute("**/_next/static/chunks/**", interceptChunk);
            await page.getByRole("button", { name: "Reload page", exact: true }).click();
            await expect(page.getByRole("heading", { level: 1, name: "Payment Successful", exact: true })).toBeVisible();
          }
          await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toHaveCount(0);
          expect(await page.evaluate(() => history.state.usr.bookingConfirmation)).toEqual({ bookingId });
          expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        } finally {
          clearTimeout(delayTimer);
          releaseChunk();
          await page.unrouteAll({ behavior: "wait" });
        }
      });
    }

    for (const completion of ["Dodo finalize", "free booking", "recovery poll", "webhook completed", "captured payment"]) {
      test(`${completion} keeps a tokenless receipt on arrival and reload`, async ({ page, flow }, testInfo) => {
        const errors = watchErrors(page);
        const free = completion === "free booking";
        const route = free ? "/thank-you" : "/payment-success";
        const heading = free ? "Thank You!" : "Payment Successful";
        const bookingId = `fixture-${completion.replaceAll(" ", "-")}`;
        const completed = {
          ok: true, status: "booked", provider: free ? "free" : "dodo", bookingId,
          emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
          emailDispatchToken: "",
        };
        let finalizeRoute;
        let statusCalls = 0;
        let cancelCalls = 0;
        if (free) {
          const quote = { grossAmount: 84.99, netAmount: 0, isFree: true };
          await page.route("**/api/payment/quote", request => request.fulfill({ json: {
            ok: true, quoteFingerprint: "fixture-free-quote", quote,
            providers: { dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } },
          } }));
          await page.route("**/api/payment/start", request => {
            expect(request.request().postDataJSON().provider).toBe("free");
            return request.fulfill({ json: { ...completed, quote } });
          });
        } else {
          await page.route("**/api/payment/finalize", request => {
            expect(request.request().headers().authorization).toBe("Bearer fixture-payment");
            finalizeRoute = request;
          });
          if (completion === "recovery poll") {
            await page.route("**/api/payment/status", request => {
              expect(request.request().headers().authorization).toBe("Bearer fixture-payment");
              statusCalls += 1;
              return request.fulfill({ json: {
                ...completed, recoveryReason: "", nextRecoveryAt: "", sessionExpiresAt: "",
                refundState: "", refundRequiresBookingSync: false, analyticsReceipt: null,
              } });
            });
          }
          if (completion === "webhook completed") {
            await page.route("**/api/payment/start", request => request.fulfill({ json: completed }));
          }
          if (completion === "captured payment") {
            await page.route("**/api/payment/cancel", request => {
              expect(request.request().headers().authorization).toBe("Bearer fixture-payment");
              cancelCalls += 1;
              return request.fulfill({ json: { ...completed, captured: true } });
            });
          }
        }
        await flow.review();
        await flow.payment();
        if (!free && completion !== "webhook completed") {
          await page.getByRole("button", { name: "Pay your way", exact: true }).click();
          await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
          if (completion === "captured payment") {
            await page.evaluate(() => {
              const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
              sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, phase: "payment_pending" }));
            });
            await page.goto("/booking", { waitUntil: "networkidle" });
            await expect(page.getByRole("button", { name: "Release payment", exact: true })).toBeVisible();
          } else {
            await page.goto("/payment?dodo_return=1", { waitUntil: "domcontentloaded" });
            await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
            await expect(page.getByRole("heading", { level: 2, name: "Complete Payment", exact: true })).toBeVisible();
          }
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1000);
        await page.evaluate(() => window.__resetConfirmationMetrics());
        if (free) await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
        else if (completion === "webhook completed") await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        else if (completion === "captured payment") await page.getByRole("button", { name: "Release payment", exact: true }).click();
        else await finalizeRoute.fulfill({ status: completion === "recovery poll" ? 202 : 200, json: completion === "recovery poll"
          ? { ok: true, status: "needs_recovery", bookingId: "", emailDispatchToken: "" } : completed });
        await expect(page).toHaveURL(new RegExp(`${route}$`));
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        expect(await focusIsInBookingDialog(page)).toBe(true);
        const arrival = await capture(page, testInfo, "tokenless-arrival");
        expect(arrival.h1Count).toBe(1);
        expect(arrival.headings).not.toContain(neutralHeading);
        assertReceiptLayout(arrival);
        expect(await page.evaluate(() => history.state.usr.bookingConfirmation)).toEqual({ bookingId });
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state")))).toEqual({ bookingId });
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        if (completion === "recovery poll") expect(statusCalls).toBe(1);
        if (completion === "captured payment") expect(cancelCalls).toBe(1);
        await page.evaluate(() => sessionStorage.removeItem("booking_confirmation_state"));
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        const reloaded = await capture(page, testInfo, "tokenless-reload");
        expect(reloaded.h1Count).toBe(1);
        assertReceiptLayout(reloaded);
        expect(await page.evaluate(() => history.state.usr.bookingConfirmation)).toEqual({ bookingId });
        expect(flow.state.calls.filter(call => call.path === "/api/ref/sendBookingEmails")).toEqual([]);
        expect(errors).toEqual([]);
      });
    }

    test("receipt layout guard catches a panel expanding after the decision", async ({ page }, testInfo) => {
      await page.goto("/payment-success", { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1, name: neutralHeading, exact: true })).toBeVisible();
      assertReceiptLayout(await capture(page, testInfo, "before-expansion"));
      await page.evaluate(() => {
        window.__resetConfirmationMetrics();
        window.__markReceiptDecision();
        document.querySelector('[role="dialog"] section p').style.paddingBottom = "32px";
      });
      const shifted = await capture(page, testInfo, "expanded-panel");
      expect(shifted.panelChanges[0].after.height - shifted.panelChanges[0].before.height).toBe(32);
      expect(() => assertReceiptLayout(shifted)).toThrow();
    });
  });
}

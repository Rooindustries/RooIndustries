const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 30000, trace: "off", video: "off" });

const dialogSelector = '[role="dialog"].ri-booking';
const fields = [
  ["discord", "Discord username"],
  ["email", "Booking email"],
  ["specs", "PC specifications"],
  ["mainGame", "Main game or application"],
  ["notes", "Extra booking requirements (optional)"],
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__dialogShifts = [];
    window.__dialogSizes = [];
    const watched = new WeakSet();
    const sizeObserver = new ResizeObserver(entries => {
      for (const { target, contentRect } of entries) {
        if (target.isConnected && contentRect.width && contentRect.height) window.__dialogSizes.push({ width: contentRect.width, height: contentRect.height });
      }
    });
    new MutationObserver(() => {
      const dialog = document.querySelector('[role="dialog"].ri-booking');
      if (dialog && !watched.has(dialog)) { watched.add(dialog); sizeObserver.observe(dialog); }
    }).observe(document, { childList: true, subtree: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__dialogShifts.push({
        value: entry.value,
        time: entry.startTime,
        hadRecentInput: entry.hadRecentInput,
        dialog: entry.sources.some(source => {
          const node = source.node?.nodeType === Node.TEXT_NODE ? source.node.parentElement : source.node;
          return Boolean(node?.closest('[role="dialog"].ri-booking'));
        }),
      });
    }).observe({ type: "layout-shift", buffered: true });
  });
});

async function save(page, testInfo, name, value) {
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(`${name}-screen`, { path: screenshot, contentType: "image/png" });
  if (process.env.ROO_SIZING_ARTIFACT_DIR) {
    const destination = path.join(process.env.ROO_SIZING_ARTIFACT_DIR, `${testInfo.project.name}-${testInfo.titlePath.slice(1).join("-").replace(/[^a-z0-9-]/gi, "-")}`);
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(artifact, path.join(destination, `${name}.json`));
    await fs.copyFile(screenshot, path.join(destination, `${name}.png`));
  }
}

async function measure(page) {
  return page.locator(dialogSelector).first().evaluate(dialog => {
    const body = dialog.querySelector(".booking-dialog-body") || dialog.querySelector("[data-booking-scaler] > div");
    const box = node => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const targets = [...dialog.querySelectorAll('button, a[href], input:not([type="hidden"]), textarea, select')]
      .filter(node => node.checkVisibility({ checkVisibilityCSS: true }) && !node.disabled)
      .map(node => ({ name: node.getAttribute("aria-label") || node.name || node.textContent.trim(), ...box(node) }));
    const scaler = dialog.querySelector("[data-booking-scaler]");
    const transform = new DOMMatrixReadOnly(getComputedStyle(scaler).transform);
    return {
      frame: box(dialog),
      body: { ...box(body), clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop },
      horizontalOverflow: {
        document: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        frame: Math.max(0, dialog.scrollWidth - dialog.clientWidth),
        body: Math.max(0, body.scrollWidth - body.clientWidth),
      },
      scale: { x: transform.a, y: transform.d },
      fontSize: getComputedStyle(body.querySelector("input") || body).fontSize,
      targets,
      smallTargets: targets.filter(target => target.width < 43.99 || target.height < 43.99),
    };
  });
}

async function ready(page) {
  await expect(page.locator(dialogSelector).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

async function captureStep(page, testInfo, name) {
  await ready(page);
  await page.locator(".booking-dialog-body").evaluateAll(bodies => bodies.forEach(body => body.scrollTo({ top: 0 })));
  const metrics = await measure(page);
  await save(page, testInfo, name, metrics);
  expect.soft(metrics.smallTargets, `${name} targets`).toEqual([]);
  expect.soft(metrics.horizontalOverflow, `${name} horizontal overflow`).toEqual({ document: 0, frame: 0, body: 0 });
  expect.soft(metrics.scale, `${name} native scale`).toEqual({ x: 1, y: 1 });
  return metrics;
}

async function controlBounds(target) {
  return target.evaluate(node => {
    const body = node.closest(".booking-dialog-body");
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const actions = body.querySelector(".booking-step-actions");
    return { control: rect(node), body: rect(body), actions: actions ? { ...rect(actions), position: getComputedStyle(actions).position } : null, scrollTop: body.scrollTop };
  });
}

function expectInsideBody(bounds) {
  expect.soft(bounds.control.top).toBeGreaterThanOrEqual(bounds.body.top);
  expect.soft(bounds.control.bottom).toBeLessThanOrEqual(bounds.body.bottom);
  expect.soft(bounds.control.left).toBeGreaterThanOrEqual(bounds.body.left);
  expect.soft(bounds.control.right).toBeLessThanOrEqual(bounds.body.right);
}

async function mockVisualViewport(page, values) {
  await page.addInitScript(values => {
    const visual = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, scale: 1 }, values);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    window.__setBookingViewport = next => {
      Object.assign(visual, next);
      visual.dispatchEvent(new Event("resize"));
    };
  }, values);
}

function sessionCls(shifts) {
  let cls = 0, session = 0, start = 0, last = 0;
  for (const shift of shifts.filter(shift => !shift.hadRecentInput)) {
    if (shift.time - last > 1000 || shift.time - start > 5000) { session = 0; start = shift.time; }
    session += shift.value;
    cls = Math.max(cls, session);
    last = shift.time;
  }
  return cls;
}

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768 });

    test("clearing a settled hold preserves checkout geometry until the route changes", async ({ page, flow }, testInfo) => {
      await flow.review();
      await flow.payment();
      await ready(page);
      const heading = page.getByRole("heading", { name: "Complete Payment", exact: true });
      const before = await heading.boundingBox();
      await page.waitForTimeout(700);
      await expect(page.locator(dialogSelector).getByRole("button", { name: "Release", exact: true })).toBeVisible();
      await page.evaluate(() => {
        window.__dialogShifts = [];
        window.dispatchEvent(new CustomEvent("hold-state", { detail: null }));
      });
      await page.waitForTimeout(200);
      const after = await heading.boundingBox();
      const shifts = await page.evaluate(() => window.__dialogShifts);
      await save(page, testInfo, "settled-hold-layout", { before, after, cls: sessionCls(shifts), shifts });
      await expect(page).toHaveURL(/\/payment$/);
      await expect(page.locator(dialogSelector).getByRole("button", { name: "Release", exact: true })).toHaveCount(0);
      expect.soft(after).toEqual(before);
      expect.soft(sessionCls(shifts)).toBeLessThanOrEqual(0.000001);
    });

    test("payment resets review scrolling and keeps the reservation countdown and release", async ({ page, flow }, testInfo) => {
      await flow.review();
      const body = page.locator(`${dialogSelector} .booking-dialog-body`);
      await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
      const reviewScrollTop = await body.evaluate(node => node.scrollTop);
      expect(reviewScrollTop).toBeGreaterThan(0);
      await flow.payment();
      await ready(page);
      const heading = page.getByRole("heading", { name: "Complete Payment", exact: true });
      const bounds = await controlBounds(heading);
      const padding = await body.evaluate(node => {
        const style = getComputedStyle(node);
        return { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom), left: parseFloat(style.paddingLeft) };
      });
      const reservation = body.getByText(/^Slot 10:00 AM/);
      const release = body.getByRole("button", { name: "Release", exact: true });
      await save(page, testInfo, "payment-reservation", { reviewScrollTop, ...bounds, padding, reservationCount: await reservation.count(), releaseCount: await release.count() });
      expect.soft(bounds.scrollTop).toBe(0);
      expectInsideBody(bounds);
      const expectedPadding = viewport.width < 768 ? 8 : 24;
      expect.soft(padding).toEqual({ top: expectedPadding, right: expectedPadding, bottom: expectedPadding, left: expectedPadding });
      await expect(reservation).toBeVisible();
      await expect(body.getByText(/^Expires in \d+:\d{2}$/)).toBeVisible();
      await expect(release).toBeVisible();
      const hold = await page.evaluate(() => JSON.parse(sessionStorage.getItem("my_slot_hold")));
      await release.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("#main-content")).toBeFocused();
      const released = flow.state.calls.filter(call => call.path === "/api/releaseHold");
      const storage = await page.evaluate(() => ({ hold: sessionStorage.getItem("my_slot_hold"), draft: sessionStorage.getItem("booking_draft") }));
      await save(page, testInfo, "payment-released", { released, storage });
      expect(released).toHaveLength(1);
      expect(released[0].body).toEqual({ holdId: hold.holdId, holdToken: hold.holdToken });
      expect(storage).toEqual({ hold: null, draft: null });
    });

    test("step actions stay visible while slots totals and field errors scroll above them", async ({ page, flow }, testInfo) => {
      flow.state.slots[0].times = Array.from({ length: 16 }, (_, index) => `${String(index + 8).padStart(2, "0")}:00`);
      const measurements = [];
      const capture = async (name, target, aboveActions = false) => {
        await ready(page);
        const value = await target.evaluate(node => {
          const body = node.closest(".booking-dialog-body");
          const actions = body.querySelector(".booking-step-actions");
          const rect = element => {
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
          };
          return { target: rect(node), body: rect(body), actions: rect(actions), scrollTop: body.scrollTop, focused: node === document.activeElement };
        });
        measurements.push({ name, ...value });
        await save(page, testInfo, name, value);
        expect.soft(value.target.top, `${name} top`).toBeGreaterThanOrEqual(value.body.top);
        expect.soft(value.target.bottom, `${name} bottom`).toBeLessThanOrEqual(aboveActions && value.actions ? value.actions.top : value.body.bottom);
        expect.soft(value.target.left, `${name} left`).toBeGreaterThanOrEqual(value.body.left);
        expect.soft(value.target.right, `${name} right`).toBeLessThanOrEqual(value.body.right);
        if (["slot-primary-visible", "details-primary-visible", "review-primary-visible"].includes(name)) {
          expect.soft(value.scrollTop, `${name} without scrolling`).toBe(0);
        }
        if (aboveActions) expect.soft(value.actions, `${name} action row`).not.toBeNull();
      };
      const resetScroll = async () => page.locator(`${dialogSelector} .booking-dialog-body`).evaluate(body => { body.scrollTop = 0; });
      await flow.booking();
      await resetScroll();
      const next = page.getByRole("button", { name: "Next", exact: true }).last();
      await capture("slot-primary-visible", next);
      const lastSlot = page.getByRole("button", { name: "11:00 PM", exact: true });
      await lastSlot.evaluate(node => { node.scrollIntoView({ block: "end" }); node.focus({ preventScroll: true }); });
      await capture("last-slot-above-actions", lastSlot, true);
      await lastSlot.click();
      await capture("selected-slot-primary-visible", next);
      await next.click();
      const email = page.getByRole("textbox", { name: "Booking email", exact: true });
      await expect(email).toBeVisible();
      await resetScroll();
      const review = page.getByRole("button", { name: "Review before payment", exact: true });
      await capture("details-primary-visible", review);
      await flow.details("invalid-email");
      await review.click();
      await expect(email).toBeFocused();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await capture("invalid-field-above-actions", email, true);
      await capture("invalid-error-above-actions", page.locator("#booking-email-error"), true);
      await email.fill("visitor@example.invalid");
      await review.click();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      await resetScroll();
      const payment = page.getByRole("button", { name: "Continue to payment", exact: true });
      await capture("review-primary-visible", payment);
      const total = page.getByText("Total", { exact: true }).locator("..");
      await total.evaluate(node => node.scrollIntoView({ block: "end" }));
      await capture("total-above-actions", total, true);
      await capture("review-scrolled-primary-visible", payment);
      await save(page, testInfo, "sticky-actions", { viewport, measurements });
    });

    test("native controls and long content fit through checkout", async ({ page, flow }, testInfo) => {
      const title = `Performance booking ${"ExtendedPackageName".repeat(9)}`;
      await page.addInitScript(title => {
        sessionStorage.setItem("booking_draft", JSON.stringify({ lastTitle: title, packages: { [title]: { selectedPackage: { title, price: "$84.99" } } } }));
      }, title);
      await flow.booking();
      await expect(page.locator(".ri-booking-package-title")).toHaveText(title);
      const booking = await captureStep(page, testInfo, "booking");
      expect.soft(booking.frame.width).toBeLessThanOrEqual(960);
      await page.getByRole("button", { name: "View My Plan", exact: true }).click();
      const plan = page.getByRole("dialog").last();
      await expect(plan).toBeVisible();
      await page.waitForTimeout(650);
      const planClose = await plan.getByRole("button", { name: "Close", exact: true }).boundingBox();
      await save(page, testInfo, "plan", { close: planClose });
      expect.soft(Math.round(planClose.width * 100) / 100).toBeGreaterThanOrEqual(44);
      expect.soft(Math.round(planClose.height * 100) / 100).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      await flow.details();
      await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("HardwareConfiguration".repeat(20));
      await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("GameApplication".repeat(20));
      await captureStep(page, testInfo, "details");
      await page.getByRole("button", { name: "Review before payment", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      for (const code of ["friend", "save20"]) {
        if (!await page.getByRole("textbox", { name: "Referral or coupon code", exact: true }).isVisible()) {
          await page.getByRole("button", { name: "Have a referral or coupon code?", exact: true }).focus();
          await page.keyboard.press("Enter");
        }
        await page.getByRole("textbox", { name: "Referral or coupon code", exact: true }).fill(code);
        await page.getByRole("button", { name: "Apply", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("button", { name: new RegExp(`^Remove .* ${code}$`) })).toBeVisible();
      }
      await captureStep(page, testInfo, "review");
      const invalidDescriptionChildren = await page.locator(`${dialogSelector} dl > div > :not(dt):not(dd):not(script):not(template)`).evaluateAll(nodes => nodes.map(node => node.outerHTML));
      await save(page, testInfo, "review-semantics", { invalidDescriptionChildren });
      expect.soft(invalidDescriptionChildren).toEqual([]);
      const providers = { dodo: { enabled: true, mode: "test" }, paypal: { enabled: true, clientId: "fixture-paypal-client", mode: "test" }, razorpay: { enabled: false, mode: "disabled" } };
      await page.route("**/api/payment/providers", route => route.fulfill({ json: { ok: true, providers } }));
      await page.route("**/api/payment/quote", route => route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-quote", providers, quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false } } }));
      await page.route("https://www.paypal.com/sdk/js?**", route => route.fulfill({ contentType: "application/javascript", body: `
        window.paypal = {
          version: "fixture",
          FUNDING: { PAYPAL: "paypal" },
          Buttons: options => {
            let frame;
            return {
            isEligible: () => true,
            render: target => {
              frame = document.createElement("iframe");
              frame.title = "PayPal payment";
              frame.style.cssText = "border:0;width:100%;height:" + options.style.height + "px";
              frame.srcdoc = '<html><body style="margin:0"><button style="box-sizing:border-box;width:100%;height:' + options.style.height + 'px">PayPal</button></body></html>';
              target.appendChild(frame);
              return Promise.resolve();
            },
            close: () => { frame?.remove(); return Promise.resolve(); },
            };
          },
        };
      ` }));
      await page.getByRole("button", { name: /^(Pay \$|Continue to payment$)/ }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      await captureStep(page, testInfo, "payment");
      const paypal = await page.frameLocator('iframe[title="PayPal payment"]').getByRole("button", { name: "PayPal", exact: true }).boundingBox();
      await save(page, testInfo, "paypal-target", paypal);
      expect.soft(paypal.height).toBeGreaterThanOrEqual(44);
      expect.soft(paypal.width).toBeGreaterThanOrEqual(44);
    });

    test("sixteen slots scroll inside a frame that keeps its size", async ({ page, flow }, testInfo) => {
      flow.state.slots[0].times = Array.from({ length: 16 }, (_, index) => `${String(index + 8).padStart(2, "0")}:00`);
      await flow.booking();
      await ready(page);
      const before = await measure(page);
      const body = page.locator(`${dialogSelector} .booking-dialog-body`);
      expect.soft(await body.count(), "one scrolling body").toBe(1);
      expect.soft(before.body.scrollHeight).toBeGreaterThan(before.body.clientHeight);
      expect.soft(before.scale).toEqual({ x: 1, y: 1 });
      await page.getByRole("button", { name: "11:00 PM", exact: true }).scrollIntoViewIfNeeded();
      await page.getByRole("button", { name: "11:00 PM", exact: true }).click();
      const afterSlot = await measure(page);
      await save(page, testInfo, "last-slot", { before, afterSlot });
      expect.soft(afterSlot.frame).toEqual(before.frame);
      expect.soft(afterSlot.body.scrollTop).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Next", exact: true }).last().scrollIntoViewIfNeeded();
      await save(page, testInfo, "next-reachable", await measure(page));
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      const afterDetails = await measure(page);
      expect.soft(afterDetails.frame).toEqual(before.frame);
    });

    test("focused fields stay inside the scroll viewport and progress stays on one line", async ({ page, flow }, testInfo) => {
      await flow.reserve();
      await flow.details();
      const focus = await page.getByRole("textbox", { name: "Main game or application", exact: true }).evaluate(input => {
        const body = input.closest(".booking-dialog-body") || input.closest('[data-booking-scaler] > div');
        const frame = input.closest('[role="dialog"]');
        const field = input.getBoundingClientRect();
        const viewport = body.getBoundingClientRect();
        const dialog = frame.getBoundingClientRect();
        return { field: { top: field.top, bottom: field.bottom }, viewport: { top: Math.max(viewport.top, dialog.top), bottom: Math.min(viewport.bottom, dialog.bottom) } };
      });
      await save(page, testInfo, "focused-field", focus);
      expect.soft(focus.field.top).toBeGreaterThanOrEqual(focus.viewport.top);
      expect.soft(focus.field.bottom).toBeLessThanOrEqual(focus.viewport.bottom);
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      const progress = await page.getByText("100%", { exact: true }).evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
      await save(page, testInfo, "progress-label", progress);
      expect.soft(progress.height).toBeLessThanOrEqual(progress.lineHeight + 0.1);
      expect.soft((await measure(page)).horizontalOverflow).toEqual({ document: 0, frame: 0, body: 0 });
    });

    test("persistent labels survive autofill errors draft restore and reload with keyboard focus", async ({ page, flow }, testInfo) => {
      await flow.reserve();
      const states = [];
      const captureLabels = async name => {
        const labels = await page.locator(dialogSelector).first().evaluate((dialog, fields) => fields.map(([name, text]) => {
          const input = dialog.querySelector(`[name="${name}"]`);
          const label = input?.id ? [...dialog.querySelectorAll("label")].find(label => label.htmlFor === input.id) : null;
          return { name, expected: text, text: label?.textContent.trim() || "", visible: Boolean(label?.checkVisibility({ checkVisibilityCSS: true })), value: input?.value };
        }), fields);
        states.push({ name, labels });
        await save(page, testInfo, name, { labels });
        for (const label of labels) {
          expect.soft(label.text).toBe(label.expected);
          expect.soft(label.visible).toBe(true);
        }
      };
      await captureLabels("empty-labels");
      await page.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
      await page.getByRole("textbox", { name: "Booking email", exact: true }).evaluate(input => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "visitor@example.invalid");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("Ryzen 7700 / RTX 4070");
      await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
      await captureLabels("autofill-labels");
      const email = page.getByRole("textbox", { name: "Booking email", exact: true });
      await email.fill("invalid-email");
      await page.getByRole("button", { name: "Review before payment", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(email).toBeFocused();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await captureLabels("error-labels");
      await email.fill("visitor@example.invalid");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("button", { name: "Continue booking", exact: true })).toBeVisible();
      await page.evaluate(() => { window.__dialogSizes = []; });
      await page.getByRole("button", { name: "Continue booking", exact: true }).click();
      await expect(email).toHaveValue("visitor@example.invalid");
      await captureLabels("restored-labels");
      await page.waitForTimeout(200);
      const reopenSizes = await page.evaluate(() => window.__dialogSizes);
      await save(page, testInfo, "reservation-reopen", { sizes: reopenSizes });
      expect.soft(reopenSizes.at(-1).width - reopenSizes[0].width).toBe(48);
      expect.soft(reopenSizes.at(-1).height - reopenSizes[0].height).toBe(48);
      await page.reload();
      await expect(email).toHaveValue("visitor@example.invalid");
      await captureLabels("reloaded-labels");
      const close = page.getByRole("button", { name: "Close", exact: true });
      await close.focus();
      await page.keyboard.press("Shift+Tab");
      expect.soft(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"].ri-booking')))).toBe(true);
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await save(page, testInfo, "labels-and-focus", { states, activeElement: await close.evaluate(node => node === document.activeElement) });
    });

    test("a delayed entry grows without layout shifts under CPU throttling", async ({ page, flow }, testInfo) => {
      void flow;
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      try {
        await page.addInitScript(() => document.addEventListener("click", event => {
          if (!event.target.closest('a[href="/booking"]')) return;
          const end = performance.now() + 600;
          while (performance.now() < end) {}
        }, { capture: true }));
        await page.goto("/");
        await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
        await page.evaluate(() => { window.__dialogShifts = []; });
        await page.locator('a[href="/booking"]').first().click();
        await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
        await page.waitForTimeout(650);
        const result = await page.evaluate(() => ({ shifts: window.__dialogShifts, sizes: window.__dialogSizes }));
        result.cls = sessionCls(result.shifts.filter(shift => shift.dialog));
        await save(page, testInfo, "delayed-entry-cls", result);
        expect(result.sizes.at(-1).width - result.sizes[0].width).toBe(48);
        expect(result.sizes.at(-1).height - result.sizes[0].height).toBe(48);
        expect(result.cls).toBe(0);
      } finally {
        await session.detach();
      }
    });

    test("open step changes payment arrival and confirmation keep session CLS at baseline", async ({ page, flow }, testInfo) => {
      let completePayment;
      await page.route("**/api/payment/finalize", route => { completePayment = route; });
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1600);
      await page.evaluate(() => { window.__dialogShifts = []; });
      const stages = [];
      const captureCls = async name => {
        await ready(page);
        await page.waitForTimeout(650);
        const shifts = await page.evaluate(() => window.__dialogShifts);
        const value = { name, cls: sessionCls(shifts), shifts, layout: await measure(page) };
        stages.push(value);
        await save(page, testInfo, name, value);
      };
      await page.locator(".ri-package-book-button").first().click();
      await page.getByRole("button", { name: /^Earliest available:/ }).click();
      await captureCls("open-cls");
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await flow.details();
      await captureCls("details-cls");
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await captureCls("review-cls");
      await flow.payment();
      await captureCls("payment-cls");
      const checkoutShifts = await page.evaluate(() => window.__dialogShifts);
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      await page.goto("/payment?dodo_return=1");
      await expect.poll(() => Boolean(completePayment)).toBe(true);
      await page.evaluate(() => { window.__dialogShifts = []; });
      await completePayment.fulfill({ json: { ok: true, status: "booked", bookingId: "fixture-sizing-booking" } });
      await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
      await captureCls("confirmation-cls");
      const result = { viewport, stages, checkoutCls: sessionCls(checkoutShifts), confirmationCls: stages.at(-1).cls };
      await save(page, testInfo, "session-cls", result);
      expect(result.checkoutCls).toBeLessThan(0.1);
      expect(result.confirmationCls).toBeLessThan(0.1);
      const baselineDir = process.env.ROO_SIZING_BASELINE_DIR;
      if (baselineDir) {
        const baselineRoot = await fs.stat(baselineDir).catch(() => null);
        expect(baselineRoot?.isDirectory(), `Missing CLS baseline directory: ${baselineDir}`).toBe(true);
        const directories = await fs.readdir(baselineDir);
        const directory = directories.find(name => name.includes(`${viewport.width}x${viewport.height}`) && name.includes("open-step-changes"));
        expect(directory, `Missing CLS baseline for ${viewport.width}x${viewport.height} in ${baselineDir}`).toBeDefined();
        const baseline = JSON.parse(await fs.readFile(path.join(baselineDir, directory, "session-cls.json"), "utf8"));
        expect(result.checkoutCls).toBeLessThanOrEqual(baseline.checkoutCls + 0.000001);
        expect(result.confirmationCls).toBeLessThanOrEqual(baseline.confirmationCls + 0.000001);
      }
    });
  });
}

for (const scenario of [
  { width: 844, height: 390 },
  { width: 390, height: 568, longTitle: true },
  { width: 320, height: 568, keyboardHeight: 260 },
]) {
  test.describe(`${scenario.width}x${scenario.height}${scenario.keyboardHeight ? " with keyboard" : ""}`, () => {
    test.use({ viewport: { width: scenario.width, height: scenario.height }, hasTouch: true });

    test("short bodies keep actions reachable and invalid fields uncovered", async ({ page, flow }, testInfo) => {
      if (scenario.keyboardHeight) await mockVisualViewport(page, { width: scenario.width, height: scenario.height });
      if (scenario.longTitle) {
        const title = `Performance booking ${"ExtendedPackageName".repeat(24)}`;
        await page.addInitScript(title => sessionStorage.setItem("booking_draft", JSON.stringify({ lastTitle: title, packages: { [title]: { selectedPackage: { title, price: "$84.99" } } } })), title);
      }
      flow.state.slots[0].times = Array.from({ length: 16 }, (_, index) => `${String(index + 8).padStart(2, "0")}:00`);
      await flow.booking();
      const next = page.getByRole("button", { name: "Next", exact: true }).last();
      if (scenario.longTitle) {
        await page.locator(`${dialogSelector} .booking-dialog-body`).evaluate(node => { node.scrollTop = 0; });
        await ready(page);
        const initial = await controlBounds(next);
        await save(page, testInfo, "long-title-initial-action", initial);
        expectInsideBody(initial);
      }
      await next.evaluate(node => node.scrollIntoView({ block: "end" }));
      await ready(page);
      const slotBounds = await controlBounds(next);
      await save(page, testInfo, "short-slot-action", slotBounds);
      expectInsideBody(slotBounds);
      if (slotBounds.body.height < 360) expect.soft(slotBounds.actions.position).not.toBe("sticky");
      await page.getByRole("button", { name: "11:00 PM", exact: true }).click();
      await next.click();
      await flow.details("invalid-email");
      if (scenario.keyboardHeight) {
        await page.evaluate(height => window.__setBookingViewport({ height }), scenario.keyboardHeight);
        await page.waitForTimeout(250);
      }
      const review = page.getByRole("button", { name: "Review before payment", exact: true });
      await review.evaluate(node => node.scrollIntoView({ block: "end" }));
      await ready(page);
      const detailsBounds = await controlBounds(review);
      await save(page, testInfo, "short-details-action", detailsBounds);
      expectInsideBody(detailsBounds);
      if (detailsBounds.body.height < 360) expect.soft(detailsBounds.actions.position).not.toBe("sticky");
      await review.click();
      const email = page.getByRole("textbox", { name: "Booking email", exact: true });
      await expect(email).toBeFocused();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await ready(page);
      const field = await controlBounds(email);
      const error = await controlBounds(page.locator("#booking-email-error"));
      await save(page, testInfo, "short-invalid-field", { field, error, visualHeight: scenario.keyboardHeight || scenario.height });
      expectInsideBody(field);
      expectInsideBody(error);
      if (field.actions.position === "sticky") {
        expect.soft(field.control.bottom).toBeLessThanOrEqual(field.actions.top);
        expect.soft(error.control.bottom).toBeLessThanOrEqual(error.actions.top);
      }
      await email.fill("visitor@example.invalid");
      await review.click();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
      const payment = page.getByRole("button", { name: "Continue to payment", exact: true });
      await payment.evaluate(node => node.scrollIntoView({ block: "end" }));
      await ready(page);
      const reviewBounds = await controlBounds(payment);
      await save(page, testInfo, "short-review-action", reviewBounds);
      expectInsideBody(reviewBounds);
    });
  });
}

test.describe("narrow frames and reservation focus", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("pinch zoom keeps the frame width tied to the layout viewport", async ({ page, flow }, testInfo) => {
    await mockVisualViewport(page, { width: 384, height: 512, scale: 2 });
    await flow.booking();
    await ready(page);
    const metrics = await measure(page);
    await save(page, testInfo, "pinch-layout-width", metrics);
    expect(metrics.frame.width).toBeGreaterThan(650);
    expect(metrics.horizontalOverflow).toEqual({ document: 0, frame: 0, body: 0 });
  });

  test("a 336 pixel frame stacks the calendar and slots without clipping", async ({ page, flow }, testInfo) => {
    await flow.booking();
    await ready(page);
    await page.locator(dialogSelector).evaluate(node => { node.style.width = "336px"; });
    await page.waitForTimeout(250);
    const layout = await page.locator(".booking-calendar-layout").evaluate(node => {
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width }; };
      return { calendar: rect(node.children[0]), slots: rect(node.children[1]), body: rect(node.closest(".booking-dialog-body")), columns: getComputedStyle(node).gridTemplateColumns };
    });
    const metrics = await measure(page);
    await save(page, testInfo, "narrow-frame", { layout, metrics });
    const close = metrics.targets.find(target => target.name === "Close");
    expect.soft(close.x).toBeGreaterThanOrEqual(metrics.frame.x);
    expect.soft(close.x + close.width).toBeLessThanOrEqual(metrics.frame.x + metrics.frame.width);
    expect.soft(metrics.horizontalOverflow).toEqual({ document: 0, frame: 0, body: 0 });
    expect.soft(layout.slots.top).toBeGreaterThanOrEqual(layout.calendar.bottom);
    for (const child of [layout.calendar, layout.slots]) {
      expect.soft(child.left).toBeGreaterThanOrEqual(layout.body.left);
      expect.soft(child.right).toBeLessThanOrEqual(layout.body.right);
    }
  });

  test("closing a reopened reservation restores focus to the replacement Continue button", async ({ page, flow }, testInfo) => {
    await flow.reserve();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const resume = page.getByRole("button", { name: "Continue booking", exact: true });
    await expect(resume).toBeVisible();
    await resume.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(resume).toBeVisible();
    await save(page, testInfo, "reservation-return-focus", await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent.slice(0, 200) })));
    await expect(resume).toBeFocused();
  });

  test("details accessible names come from their visible labels", async ({ page, flow }, testInfo) => {
    await flow.reserve();
    const labels = [];
    for (const [name, text] of fields) {
      const input = page.locator(`#booking-${name}`);
      labels.push({ name, expected: text, override: await input.getAttribute("aria-label") });
      await expect.soft(input).toHaveAccessibleName(text);
      await expect.soft(input).not.toHaveAttribute("aria-label");
    }
    await save(page, testInfo, "visible-accessible-labels", labels);
  });
});

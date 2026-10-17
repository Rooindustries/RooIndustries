const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", actionTimeout: 10000, reducedMotion: "reduce", trace: "off", video: "off" });
const bookingId = "booking.summary-order";
const summary = { bookingId, packageTitle: "Performance Vertex Overhaul", startTimeUTC: "2026-03-08T07:30:00.000Z", localTimeZone: "America/New_York" };
const complete = (changes = {}) => ({ ok: true, status: "booked", bookingId, emailDispatchToken: "fixture-email-token", bookingSummary: summary, ...changes });
const record = async (page, info, name, data) => {
  const file = info.outputPath(`${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  await info.attach(name, { path: file, contentType: "application/json" });
  const heading = page.getByRole("dialog").locator("h1");
  if (await heading.count()) {
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("opacity", "1");
  }
  const root = process.env.ROO_CONFIRMATION_ARTIFACT_DIR;
  if (root) {
    await fs.mkdir(root, { recursive: true });
    await fs.copyFile(file, path.join(root, `${info.title.replace(/[^a-z0-9]+/gi, "-")}-${name}.json`));
    await page.screenshot({ path: path.join(root, `${info.title.replace(/[^a-z0-9]+/gi, "-")}-${name}.png`) });
  }
};
const assertSummary = async page => {
  await expect(page.getByText(bookingId, { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(summary.packageTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(/America\/New_York.*UTC-04:00/)).toBeVisible();
  await expect(page.getByText(/March 8, 2026.*3:30 AM/)).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  page.confirmationRequests = [];
  page.on("response", response => { if (response.url().includes("sendBookingEmails")) page.confirmationRequests.push({ url: response.url(), status: response.status() }); });
  await page.route("**/api/ref/sendBookingEmails", route => route.fulfill({ json: { ok: true, emailDispatch: { allSent: true } } }));
});

test.afterEach(async ({ page }, info) => {
  await record(page, info, "result", { status: info.status, url: page.url(), errors: info.errors.map(error => error.message), requests: page.confirmationRequests, stored: await page.evaluate(() => { try { return { receipt: sessionStorage.getItem("booking_confirmation_state"), history: window.history.state }; } catch { return null; } }), text: await page.locator("body").innerText().catch(() => "Page unavailable") });
});

for (const failure of ["write fails", "storage blocked"]) for (const reschedule of [true, false]) test(`${reschedule ? "reschedule" : "paid"} completion keeps the reference when ${failure}`, async ({ page, flow }, info) => {
  await flow.review();
  await flow.payment();
  await page.route("**/api/payment/start", route => route.fulfill({ json: complete({ provider: "dodo", ...(reschedule ? { requiresReschedule: true, bookingSummary: null } : {}) }) }));
  const breakStorage = failure => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage unavailable", "QuotaExceededError"); };
    if (failure === "storage blocked") {
      Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
      Storage.prototype.removeItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
    }
  };
  await page.addInitScript(breakStorage, failure);
  await page.evaluate(breakStorage, failure);
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
    await expect(page.getByText(bookingId, { exact: true })).toBeVisible();
    await expect(page.getByText("Looking for your booking?", { exact: true })).toHaveCount(0);
    if (reschedule) {
      await expect(page.getByText("Your payment went through, but we couldn't confirm the time you selected. Reply to our email or contact us and we'll arrange another time.", { exact: true })).toBeVisible();
      await expect(page.getByText(/booking is confirmed/)).toHaveCount(0);
      await expect(page.getByRole("dialog").getByText(summary.packageTitle, { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText("Check your confirmation email for the package and appointment details.", { exact: true })).toBeVisible();
    }
    await expect.poll(() => page.evaluate(() => history.state?.usr?.bookingConfirmation)).toEqual({ bookingId, ...(reschedule ? { requiresReschedule: true } : {}) });
  }
  const receipt = await page.evaluate(() => history.state.usr.bookingConfirmation);
  await record(page, info, "storage-failure", { failure, reschedule, receipt });
});

for (const invalidation of ["new checkout", "explicit null"]) test(`history cannot restore an appointment after ${invalidation}`, async ({ page, flow }, info) => {
  await flow.review();
  await flow.payment();
  await page.route("**/api/payment/start", route => route.fulfill({ json: complete({ provider: "dodo" }) }));
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await assertSummary(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state"))?.emailDispatchToken || null)).toBeNull();
  await page.getByRole("link", { name: "Back to Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  if (invalidation === "new checkout") {
    await page.locator('a[href="/booking"]').first().click();
    await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
    await expect.poll(() => page.evaluate(id => sessionStorage.getItem(`booking_confirmation_summary:${id}`), bookingId)).toBeNull();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    await page.evaluate(id => sessionStorage.setItem(`booking_confirmation_summary:${id}`, "null"), bookingId);
  }
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
  await expect(page.getByText(bookingId, { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(summary.packageTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByText(/America\/New_York/)).toHaveCount(0);
  await expect(page.getByText("Check your confirmation email for the package and appointment details.", { exact: true })).toBeVisible();
  const receipt = await page.evaluate(() => history.state.usr.bookingConfirmation);
  expect(receipt).toEqual({ bookingId });
  await record(page, info, "history-invalidation", { invalidation, receipt });
});

for (const kind of ["paid", "free", "status recovery", "session replay", "captured cancel", "captured booking"]) {
  test(`${kind} completion shows the authorized reference and appointment`, async ({ page, flow }, info) => {
    const body = complete();
    await flow.review();
    if (kind === "captured booking") {
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/checkout-handoff/);
      await page.route("**/api/payment/cancel", route => route.fulfill({ json: { ...body, captured: true, cancelled: false } }));
      await page.evaluate(() => { const hold = JSON.parse(sessionStorage.getItem("my_slot_hold")); hold.phase = "payment_pending"; sessionStorage.setItem("my_slot_hold", JSON.stringify(hold)); });
      await page.goto("/booking");
      await page.getByRole("button", { name: "Release payment", exact: true }).click();
    } else {
      await flow.payment();
      if (kind === "free") {
        await page.route("**/api/payment/quote", route => route.fulfill({ json: { ok: true, quoteFingerprint: "fixture-free", quote: { grossAmount: 84.99, netAmount: 0, isFree: true } } }));
        await page.reload();
        await page.route("**/api/payment/start", route => route.fulfill({ json: { ...body, provider: "free" } }));
        await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
      } else {
        await page.route("**/api/payment/start", route => route.fulfill({ json: kind === "session replay" ? { ...body, provider: "dodo" } : { ok: true, status: "started", paymentAccessToken: "fixture-payment", providerPayload: { checkoutUrl: `${new URL(page.url()).origin}/__test/checkout-handoff` } } }));
        if (kind === "captured cancel") await page.route("**/api/payment/cancel", route => route.fulfill({ json: { ...body, captured: true, cancelled: false } }));
        if (kind === "status recovery") await page.route("**/api/payment/status", route => route.fulfill({ json: body }));
        await page.getByRole("button", { name: "Pay your way", exact: true }).click();
        if (kind !== "session replay") {
          await expect(page).toHaveURL(/checkout-handoff/);
          await page.route("**/api/payment/finalize", route => route.fulfill({ status: kind === "status recovery" ? 202 : 200, json: kind === "status recovery" ? { ok: true, status: "finalizing" } : body }));
          await page.goto(kind === "captured cancel" ? "/payment?dodo_cancel=1" : "/payment?dodo_return=1");

        }
      }
    }
    await expect(page.getByRole("heading", { name: kind === "free" ? "Thank You!" : "Payment Successful", exact: true })).toBeVisible();
    await expect(page.getByText(kind === "free" ? "Your booking has been confirmed. You'll receive a confirmation email shortly." : "Your payment was processed and your booking is confirmed. You'll receive a confirmation email shortly.", { exact: true })).toBeVisible();
    await record(page, info, "completion", { response: body, text: await page.getByRole("dialog").innerText() });
    await assertSummary(page);
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state"))?.emailDispatchToken || null)).toBeNull();
    await page.reload();
    await assertSummary(page);
    await record(page, info, "reload", { receipt: await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state"))) });
    if (kind === "paid" || kind === "free") {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(viewport);
        await assertSummary(page);
        const measurements = await page.getByRole("dialog").evaluate(frame => {
          const body = frame.querySelector(".booking-dialog-body");
          const copy = [...frame.querySelectorAll("button")].find(node => node.textContent === "Copy").getBoundingClientRect();
          return { frameOverflow: frame.scrollWidth - frame.clientWidth, bodyOverflow: body.scrollWidth - body.clientWidth, copy: { width: copy.width, height: copy.height } };
        });
        expect(measurements.frameOverflow).toBe(0);
        expect(measurements.bodyOverflow).toBe(0);
        expect(measurements.copy.width).toBeGreaterThanOrEqual(44);
        expect(measurements.copy.height).toBeGreaterThanOrEqual(44);
        await record(page, info, `summary-${viewport.width}`, measurements);
      }
    }
  });
}

for (const reject of [false, true]) test(`copy reference ${reject ? "rejection keeps a manual path" : "writes the exact order ID"}`, async ({ page, flow }, info) => {
  void flow;
  await page.addInitScript(({ receipt, reject }) => {
    sessionStorage.setItem("booking_confirmation_state", JSON.stringify({ bookingId: receipt.bookingId }));
    sessionStorage.setItem(`booking_confirmation_summary:${receipt.bookingId}`, JSON.stringify(receipt.bookingSummary));
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { if (reject) throw new Error("Clipboard unavailable"); window.__copiedReference = value; } } });
  }, { receipt: { bookingId, bookingSummary: summary }, reject });
  await page.goto("/payment-success");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(reject ? "Couldn't copy. Select and copy the reference." : "Copied.");
  const actual = await page.evaluate(() => window.__copiedReference || null);
  await record(page, info, "clipboard", { actual, reject });
  expect(actual).toBe(reject ? null : bookingId);
  expect(await page.getByText(bookingId, { exact: true }).evaluate(node => getComputedStyle(node).userSelect)).not.toBe("none");
});

for (const sample of [
  { instant: "2026-01-01T00:30:00.000Z", zone: "Pacific/Honolulu", date: "December 31, 2025", time: "2:30 PM", offset: "UTC-10:00" },
  { instant: "2026-03-08T06:30:00.000Z", zone: "America/New_York", date: "March 8, 2026", time: "1:30 AM", offset: "UTC-05:00" },
  { instant: "2026-03-08T07:30:00.000Z", zone: "America/New_York", date: "March 8, 2026", time: "3:30 AM", offset: "UTC-04:00" },
]) test(`appointment uses its timezone at ${sample.instant}`, async ({ page, flow }, info) => {
  void flow;
  await page.addInitScript(receipt => {
    sessionStorage.setItem("booking_confirmation_state", JSON.stringify({ bookingId: receipt.bookingId }));
    sessionStorage.setItem(`booking_confirmation_summary:${receipt.bookingId}`, JSON.stringify(receipt.bookingSummary));
  }, { bookingId, bookingSummary: { ...summary, startTimeUTC: sample.instant, localTimeZone: sample.zone } });
  await page.goto("/payment-success");
  await record(page, info, "timezone", { sample, text: await page.getByRole("dialog").innerText() });
  await expect(page.getByText(new RegExp(`${sample.date}.*${sample.time}`))).toBeVisible();
  await expect(page.getByText(new RegExp(`${sample.zone}.*${sample.offset.replace("+", "\\+")}`))).toBeVisible();
});

for (const state of ["missing", "mismatch", "malformed", "explicit null", "blocked", "inactive", "reschedule", "reference only"]) test(`${state} confirmation never shows unrelated appointment data`, async ({ page, flow }, info) => {
  void flow;
  await page.addInitScript(({ bookingId, summary, state }) => {
    const receipt = { bookingId, ...(state === "inactive" ? { emailDispatchToken: "fixture-inactive" } : {}) };
    let cachedSummary = summary;
    if (state === "mismatch") cachedSummary = { ...summary, bookingId: "booking.other-browser", packageTitle: "Unrelated package" };
    if (state === "malformed") cachedSummary = { ...summary, startTimeUTC: "2026-02-30T10:00:00Z", localTimeZone: "Invalid/Zone" };
    if (["explicit null", "reference only", "reschedule"].includes(state)) cachedSummary = null;
    if (state === "explicit null") receipt.bookingSummary = summary;
    if (state === "reschedule") receipt.requiresReschedule = true;
    if (state !== "missing") sessionStorage.setItem("booking_confirmation_state", JSON.stringify(receipt));
    sessionStorage.setItem(`booking_confirmation_summary:${bookingId}`, JSON.stringify(cachedSummary));
    if (state === "blocked") { sessionStorage.clear(); Storage.prototype.getItem = () => { throw new Error("Storage unavailable"); }; Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); }; }
  }, { bookingId, summary, state });
  if (state === "inactive") await page.route("**/api/ref/sendBookingEmails", route => route.fulfill({ status: 409, json: { ok: false, code: "booking_inactive" } }));
  await page.goto("/payment-success");
  const neutral = ["missing", "blocked", "inactive"].includes(state);
  await expect(page.getByRole("heading", { name: neutral ? "Looking for your booking?" : "Payment Successful", exact: true })).toBeVisible();
  await expect(page.getByText("Unrelated package", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/America\/New_York/)).toHaveCount(0);
  if (state === "reschedule") { await expect(page.getByText("Your payment went through, but we couldn't confirm the time you selected. Reply to our email or contact us and we'll arrange another time.", { exact: true })).toBeVisible(); await expect(page.getByText(/booking is confirmed/)).toHaveCount(0); }
  if (!neutral && state !== "reschedule") {
    await expect(page.getByText("Your payment was processed and your booking is confirmed. You'll receive a confirmation email shortly.", { exact: true })).toBeVisible();
    await expect(page.getByText("Check your confirmation email for the package and appointment details.", { exact: true })).toBeVisible();
  }
  await record(page, info, "safe-confirmation", { state, text: await page.getByRole("dialog").innerText() });
  if (state === "reference only") {
    await page.goto("/booking");
    await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key === "booking_confirmation_state" || key.startsWith("booking_confirmation_summary:")))).toEqual([]);
  }
  if (state === "inactive") expect(page.confirmationRequests).toHaveLength(1);
});

test("copy acknowledgment follows the reference restored from history", async ({ page, flow }, info) => {
  void flow;
  await page.addInitScript(receipt => {
    sessionStorage.setItem("booking_confirmation_state", JSON.stringify({ bookingId: receipt.bookingId }));
    sessionStorage.setItem(`booking_confirmation_summary:${receipt.bookingId}`, JSON.stringify(receipt.bookingSummary));
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.__copiedReference = value; } } });
  }, { bookingId, bookingSummary: summary });
  await page.goto("/payment-success");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Copied.");
  const nextId = "booking.next-confirmation";
  await page.evaluate(({ nextId, summary }) => {
    sessionStorage.setItem(`booking_confirmation_summary:${nextId}`, JSON.stringify({ ...summary, bookingId: nextId }));
    const state = { ...history.state, __rooLegacy: true, usr: { bookingConfirmation: { bookingId: nextId } } };
    history.pushState(state, "", location.href);
    dispatchEvent(new PopStateEvent("popstate", { state }));
  }, { nextId, summary });
  await expect(dialog.getByText(nextId, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("");
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => window.__copiedReference)).toBe(nextId);
  await record(page, info, "restored-reference", { nextId, copied: await page.evaluate(() => window.__copiedReference) });
});

test("reschedule completion keeps its recovery wording after reload and another checkout", async ({ page, flow }, info) => {
  await flow.review();
  await flow.payment();
  await page.route("**/api/payment/start", route => route.fulfill({ json: complete({ provider: "dodo", requiresReschedule: true, bookingSummary: null }) }));
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  const message = "Your payment went through, but we couldn't confirm the time you selected. Reply to our email or contact us and we'll arrange another time.";
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_confirmation_state"))?.emailDispatchToken || null)).toBeNull();
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to Home", exact: true }).click();
  await page.locator('a[href="/booking"]').first().click();
  await expect(page.getByRole("button", { name: /^Earliest available:/ })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/booking is confirmed/)).toHaveCount(0);
  const receipt = await page.evaluate(() => history.state.usr.bookingConfirmation);
  expect(receipt).toEqual({ bookingId, requiresReschedule: true });
  await record(page, info, "reschedule-history", { receipt });
});

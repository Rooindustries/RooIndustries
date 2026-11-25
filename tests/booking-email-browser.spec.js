const { test: base, expect } = require("./fixtures/booking-flow.cjs");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const test = base.extend({
  native: [async ({}, use) => {
    const child = fork(require.resolve("./fixtures/booking-email-browser.mjs"), [], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const pending = new Map();
    let nextId = 0;
    const ready = new Promise((resolve, reject) => {
      child.on("message", message => {
        if (message.ready) return resolve();
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      });
      child.on("exit", code => {
        const error = new Error(`Booking fixture exited (${code})`);
        reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      });
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.send({ id, method, args });
    });
    try {
      await ready;
      await use({ call });
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        await call("stop");
        await exited;
      }
    }
  }, { scope: "worker" }],
});

test.use({ javaScriptEnabled: true, timezoneId: "America/Los_Angeles", reducedMotion: "reduce", trace: "off" });
const nativeBinaries = [process.env.PG_BIN && path.join(process.env.PG_BIN, "postgres"), process.env.POSTGREST_BIN];
test.skip(!nativeBinaries.every(file => file && fs.existsSync(file)), "Needs PG_BIN and POSTGREST_BIN for the native PostgreSQL 17 fixture.");
const paypalSdk = `window.paypal = { version: "5.0.0", Buttons(options) { return {
  isEligible: () => true,
  render(container) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Fixture PayPal";
    button.addEventListener("click", async () => {
      const allowed = await options.onClick({}, { resolve: () => true, reject: () => false });
      if (!allowed) return;
      const orderID = await options.createOrder({}, {});
      await options.onApprove({ orderID }, { order: { capture: async () => ({ id: orderID,
        payer: { email_address: "visitor@example.invalid" } }) } });
    });
    container.appendChild(button);
    return Promise.resolve();
  }, close: () => Promise.resolve(), updateProps: () => Promise.resolve(),
}; } };`;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    test("a paid booking is saved and the confirmation emails are sent once", async ({ page, context, flow, native }) => {
      const date = await native.call("nextDate");
      const initialEmails = (await native.call("evidence")).providerRequests.filter(request => request.path === "/emails").length;
      await context.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
        const response = await native.call("availability");
        const dateSlots = [{ date, times: ["10:00"] }];
        const body = { ...response.body, settings: { ...response.body.settings, dateSlots,
          xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] } };
        await route.fulfill({ status: response.status, json: body });
      });
      let lastDodoReturnTag = "";
      await context.route(/\/api\/(holdSlot|payment\/(quote|start|finalize|status|cancel)|ref\/sendBookingEmails)(?:\?|$)/, async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        const token = (request.headers().authorization || "").replace(/^Bearer /, "");
        const response = await native.call("post", pathname, request.postDataJSON(), token);
        if (pathname === "/api/payment/start" && response.body?.providerPayload?.dodoReturnTag) {
          lastDodoReturnTag = response.body.providerPayload.dodoReturnTag;
        }
        await route.fulfill({ status: response.status, json: response.body });
      });
      await context.route("https://test.checkout.dodopayments.com/session/**", route => route.fulfill({
        contentType: "text/html", body: `<a href="${new URL(page.url()).origin}/payment?dodo_return=1&dodo_session=${encodeURIComponent(lastDodoReturnTag)}">Return to booking</a>`,
      }));
      await context.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({ contentType: "application/javascript", body: paypalSdk }));
      await flow.booking();
      await page.getByRole("button", { name: "8:30 PM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
      await flow.details();
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await page.getByRole("link", { name: "Return to booking", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
      await expect.poll(async () => (await native.call("evidence")).providerRequests.filter(request => request.path === "/emails").length).toBe(initialEmails + 2);
      const evidence = await native.call("evidence");
      const finalized = evidence.http.findLast(entry => entry.path === "/api/payment/finalize");
      expect(finalized.response.bookingId).toBeTruthy();
      const hold = evidence.http.findLast(entry => entry.path === "/api/holdSlot");
      expect(new Date(hold.response.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect((await native.call("document", hold.response.holdId)).phase).toBe("consumed");
      expect(await native.call("slotCounts", `${date}T04:30:00.000Z`)).toEqual({ booking: 1, slotHold: 1 });
      expect(finalized.status).toBe(200);
      await expect.poll(async () => (await native.call("document", finalized.response.bookingId))?.emailDispatchStatus).toBe("sent");
      const booking = await native.call("document", finalized.response.bookingId);
      expect(booking).toMatchObject({ email: "visitor@example.invalid", packageTitle: "Performance Vertex Overhaul",
        startTimeUTC: `${date}T04:30:00.000Z`, localTimeZone: "America/Los_Angeles", hostTimeZone: "Asia/Kolkata", emailDispatchStatus: "sent" });
      const start = new Date(booking.startTimeUTC);
      expect(booking.displayDate).toBe(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(start));
      expect(booking.displayTime).toBe("8:30 PM");
      const host = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short", month: "short", day: "2-digit", year: "numeric" }).formatToParts(start).map(part => [part.type, part.value]));
      expect(booking.hostDate).toBe(`${host.weekday} ${host.month} ${host.day} ${host.year}`);
      expect(booking.hostTime).toBe("10:00 AM");
      expect(booking.emailDispatchClientSentAt).toBeTruthy();
      expect(booking.emailDispatchOwnerSentAt).toBeTruthy();
      const emails = evidence.providerRequests.filter(request => request.path === "/emails").slice(initialEmails);
      expect(emails.map(request => request.body.to).sort()).toEqual(["owner@example.invalid", "visitor@example.invalid"]);
      const client = emails.find(request => request.body.to === "visitor@example.invalid");
      expect(client.body.attachments).toBeUndefined();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
      expect((await native.call("evidence")).providerRequests.filter(request => request.path === "/emails")).toHaveLength(initialEmails + 2);
    });

    test("two confirmation tabs send deferred emails once using the latest booking", async ({ page, context, flow, native }) => {
      const date = await native.call("nextDate");
      const initialEmails = (await native.call("evidence")).providerRequests.filter(request => request.path === "/emails").length;
      const initialKeys = (await native.call("emailKeys")).length;
      const responses = [];
      let receipt;
      let pending;
      let held = false;
      await context.route(/\/api\/bookingAvailability(?:\?|$)/, async route => {
        const response = await native.call("availability");
        const dateSlots = [{ date, times: ["10:00"] }];
        await route.fulfill({ status: response.status, json: { ...response.body, settings: { ...response.body.settings,
          dateSlots, xocDateSlots: dateSlots, vertexEssentialsDateSlots: dateSlots, packageDateSlots: [] } } });
      });
      await context.route(/https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js/, route => route.fulfill({ contentType: "application/javascript", body: paypalSdk }));
      await context.route(/\/api\/payment\/providers(?:\?|$)/, route => route.fulfill({ json: { ok: true, providers: {
        dodo: { enabled: true, mode: "test" }, razorpay: { enabled: false, mode: "disabled" },
        paypal: { enabled: true, mode: "sandbox", clientId: "fixture-paypal-client" },
      } } }));
      await context.route(/\/api\/(holdSlot|payment\/(quote|start|finalize|status|cancel)|ref\/sendBookingEmails)(?:\?|$)/, async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/ref/sendBookingEmails" && !receipt) {
          receipt = request.postDataJSON();
          pending = { booking: await native.call("document", receipt.bookingId), evidence: await native.call("evidence") };
          await native.call("changeMessageAfterRead", receipt.bookingId, '<script>alert("preview")</script>');
          await native.call("holdEmails");
          held = true;
        }
        const token = (request.headers().authorization || "").replace(/^Bearer /, "");
        const response = await native.call("post", pathname, request.postDataJSON(), token);
        if (pathname === "/api/ref/sendBookingEmails") responses.push(response);
        await route.fulfill({ status: response.status, json: response.body });
      });
      try {
        await flow.booking();
        await page.getByRole("button", { name: "8:30 PM", exact: true }).click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
        await flow.details();
        await page.getByRole("button", { name: "Review before payment", exact: true }).click();
        await flow.payment();
        await page.getByRole("button", { name: "Fixture PayPal", exact: true }).click();
        await expect.poll(async () => (await native.call("emailKeys")).length).toBe(initialKeys + 1);
        expect(pending.booking).toMatchObject({ emailDispatchDeferred: true, emailDispatchStatus: "pending" });
        expect(pending.booking.emailDispatchQueuedAt).toBeTruthy();
        expect(pending.evidence.providerRequests.filter(request => request.path === "/emails")).toHaveLength(initialEmails);
        const finalized = pending.evidence.http.findLast(entry => entry.path === "/api/payment/finalize");
        const hold = pending.evidence.http.findLast(entry => entry.path === "/api/holdSlot");
        expect(new Date(hold.response.expiresAt).getTime()).toBeGreaterThan(Date.now());
        expect(finalized.status).toBe(200);
        expect(finalized.response).toMatchObject({ bookingId: receipt.bookingId, emailDispatchToken: receipt.emailDispatchToken,
          emailDispatch: { allSent: false } });
        expect(receipt.bookingId).toBeTruthy();
        expect(receipt.emailDispatchToken).toBeTruthy();
        const second = await context.newPage();
        await second.goto("/__test/checkout-handoff");
        await second.evaluate(value => sessionStorage.setItem("booking_confirmation_state", JSON.stringify(value)), receipt);
        await second.goto("/payment-success");
        await expect.poll(() => responses.map(response => response.status)).toContain(202);
        await native.call("releaseEmails");
        held = false;
        await expect.poll(() => responses.map(response => response.status)).toContain(200);
        expect(responses.map(response => response.status).sort()).toEqual([200, 202]);
        expect(responses.find(response => response.status === 200).body).toMatchObject({ ok: true, emailDispatch: { allSent: true } });
        await expect.poll(async () => (await native.call("document", receipt.bookingId))?.emailDispatchStatus).toBe("sent");
        const booking = await native.call("document", receipt.bookingId);
        expect(booking.emailDispatchStatus).toBe("sent");
        expect(booking.emailDispatchClientSentAt).toBeTruthy();
        expect(booking.emailDispatchOwnerSentAt).toBeTruthy();
        const emails = (await native.call("evidence")).providerRequests.filter(request => request.path === "/emails").slice(initialEmails);
        expect(emails).toHaveLength(2);
        const owner = emails.find(request => request.body.to === "owner@example.invalid");
        const host = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short", month: "short", day: "2-digit", year: "numeric" }).formatToParts(new Date(`${date}T04:30:00.000Z`)).map(part => [part.type, part.value]));
        expect(owner.body.subject).toMatch(new RegExp(`^New booking [A-Z0-9]{6} - Performance Vertex Overhaul \\(${host.weekday} ${host.month} ${host.day} ${host.year} 10:00 AM\\)$`));
        expect(owner.body.html).toContain("&lt;script&gt;alert(&quot;preview&quot;)&lt;/script&gt;");
        expect(owner.body.html).not.toContain('<script>alert("preview")</script>');
        for (const text of ["fixture_visitor", "Ryzen 7700 / RTX 4070", "CS2", "$54.95"]) expect(owner.body.html).toContain(text);
        for (const style of ["margin:0;padding:0;background:#e9edf3", "max-width:640px;background:#0f172a;border:1px solid #2a3f5c", "text-align:center;background:#0b1120"]) expect(owner.body.html).toContain(style);
        expect(owner.body.html).not.toContain("undefined");
        expect(owner.body.html).not.toContain("margin:0;padding:0;background:#0f172a");
        expect(owner.body.html).not.toContain("#020617");
        expect((await native.call("emailKeys")).slice(initialKeys)).toEqual([expect.stringMatching(/-client$/), expect.stringMatching(/-owner$/)]);
        await second.reload();
        await expect.poll(() => responses.filter(response => response.status === 200).length).toBe(2);
        expect(responses.filter(response => response.status === 200).map(response => response.body.ok)).toEqual([true, true]);
        expect((await native.call("evidence")).providerRequests.filter(request => request.path === "/emails")).toHaveLength(initialEmails + 2);
        expect((await native.call("evidence")).blocked).toEqual([]);
        await second.close();
      } finally {
        if (held) await native.call("releaseEmails");
      }
    });
  });
}

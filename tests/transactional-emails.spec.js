const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const check = expect.configure({ soft: true });
let capture;

test.use({ trace: "off", video: "off" });
test.beforeAll(() => {
  capture = JSON.parse(execFileSync(process.execPath, ["tests/fixtures/transactional-emails.mjs"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--no-experimental-webstorage" },
  }));
});
test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});
const escapeAttribute = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`transactional email details, safety and layout on ${name}`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/robots.txt");
    const frames = capture.captured.map((item, index) => {
      const html = item.payload.html.replaceAll("https://www.rooindustries.com/embed_logo.png", `${baseURL}/embed_logo.png`);
      return `<iframe id="email-${index}" style="position:absolute;top:0;left:0;visibility:hidden;width:${viewport.width}px;height:1200px;border:0" srcdoc="${escapeAttribute(html)}"></iframe>`;
    }).join("");
    await page.setContent(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><body style="margin:0">${frames}</body>`);
    const rendered = await page.locator("iframe").evaluateAll(frames => frames.map(frame => {
      const doc = frame.contentDocument;
      const fields = Object.fromEntries(Array.from(doc.querySelectorAll("tr")).flatMap(row => {
        const cells = row.querySelectorAll(":scope > td");
        return cells.length === 2 ? [[cells[0].textContent.trim(), cells[1].textContent.trim()]] : [];
      }));
      frame.style.height = `${doc.documentElement.scrollHeight}px`;
      return { fields, text: doc.body.textContent, scrollWidth: doc.documentElement.scrollWidth,
        unsafeNodes: doc.querySelectorAll("script, img[src=x]").length,
        imagesWithoutAlt: doc.querySelectorAll("img:not([alt])").length };
    }));
    const messages = caseName => capture.captured.flatMap((item, index) => item.case === caseName ? [{ ...item, index, ...rendered[index] }] : []);
    const clocks = [
      ["stale", "Sunday, March 8, 2026", "1:30 AM", "GMT-05:00 (America/New_York)", "12:00 PM"],
      ["spring-after", "Sunday, March 8, 2026", "3:30 AM", "GMT-04:00 (America/New_York)", "1:00 PM"],
      ["fold-first", "Sunday, November 1, 2026", "1:30 AM", "GMT-04:00 (America/New_York)", "11:00 AM"],
      ["fold-second", "Sunday, November 1, 2026", "1:30 AM", "GMT-05:00 (America/New_York)", "12:00 PM"],
      ["london-first", "Sunday, October 25, 2026", "1:30 AM", "GMT+01:00 (Europe/London)", "6:00 AM"],
      ["london-second", "Sunday, October 25, 2026", "1:30 AM", "GMT+00:00 (Europe/London)", "7:00 AM"],
      ["sydney-before", "Sunday, October 4, 2026", "1:30 AM", "GMT+10:00 (Australia/Sydney)", "9:00 PM"],
      ["sydney-after", "Sunday, October 4, 2026", "3:30 AM", "GMT+11:00 (Australia/Sydney)", "10:00 PM"],
      ["midnight", "Friday, January 1, 2027", "12:00 AM", "GMT+05:30 (Asia/Kolkata)", "12:00 AM"],
      ["missing-zone", "Sunday, November 1, 2026", "5:30 AM", "UTC", "11:00 AM"],
      ["invalid-zone", "Sunday, November 1, 2026", "5:30 AM", "UTC", "11:00 AM"],
    ];
    for (const [caseName, date, time, zone, hostTime] of clocks) {
      for (const prefix of ["clock", "requested"]) {
        for (const item of messages(`${prefix}-${caseName}`)) {
          const { fields } = item;
          const customer = item.payload.to === "customer-a@fixture.invalid";
          const requested = prefix === "requested";
          check(fields[requested ? "Requested Date" : customer ? "Date" : "Client Date"], item.case).toBe(date);
          check(fields[requested ? "Requested Time" : customer ? "Time" : "Client Time"], item.case).toBe(time);
          check(fields[requested || customer ? "Time Zone" : "Client Time Zone"], item.case).toBe(zone);
          if (!customer) {
            const hostLabel = requested ? "Host " : "";
            check(fields[`${hostLabel}Time`], item.case).toBe(hostTime);
            check(fields[`${hostLabel}Time Zone`], item.case).toBe("GMT+05:30 (Asia/Kolkata)");
            check(item.payload.subject, item.case).toContain(`(${fields[`${hostLabel}Date`]} ${fields[`${hostLabel}Time`]})`);
          }
        }
      }
    }
    for (const caseName of ["missing-instant", "requested-missing-instant", "invalid-instant", "requested-invalid-instant"]) {
      for (const item of messages(caseName)) {
        check(item.text, caseName).toContain("Unavailable");
        check(item.text, caseName).not.toContain("stale");
      }
    }
    for (const item of [...messages("requested-original-only"), ...messages("requested-different-instant")]) {
      check(item.fields["Requested Time"], item.case).toBe("1:30 AM");
    }
    for (const item of capture.captured.map((item, index) => ({ ...item, ...rendered[index] }))) {
      check(item.scrollWidth, `${item.case}: ${item.payload.to}`).toBeLessThanOrEqual(viewport.width);
    }
    for (const caseName of ["normal", "long-fields", "recovery-usd", "recovery-long-fields", "registration_verification-long-name", "password_reset-long-name"]) {
      for (const item of messages(caseName)) {
        const frame = page.locator(`#email-${item.index}`);
        await frame.evaluate(element => { element.style.visibility = "visible"; });
        await frame.screenshot({ path: testInfo.outputPath(`${caseName}-${String(item.payload.to).startsWith("configured") ? "owner" : "customer"}.png`) });
        await frame.evaluate(element => { element.style.visibility = "hidden"; });
      }
    }
    for (const caseName of ["net-missing", "net-null", "net-empty", "net-nan", "net-infinity", "net-invalid"]) {
      for (const item of messages(caseName)) {
        check(item.fields.Price, caseName).toBe("$84.99");
        check(item.fields.Discount, caseName).toBeUndefined();
        check(item.fields["Coupon Code"], caseName).toBe("SAVE10");
      }
    }
    for (const item of messages("free")) check(item.fields.Price).toBe("$0.00 (was $84.99)");
    for (const item of messages("missing-title")) check(item.payload.subject).not.toMatch(/\b(null|undefined)\b/);
    for (const [currency, symbol] of [["usd", "$"], ["eur", "€"], ["gbp", "£"]]) {
      for (const item of messages(`money-${currency}`)) {
        check(item.fields.Price).toBe(`${symbol}76.49 (was ${symbol}84.99)`);
        check(item.fields["Coupon Code"]).toBe(`SAVE10 (10% - ${symbol}8.50)`);
        if (item.payload.to.startsWith("configured")) check(item.fields.Discount).toBe(`10% (${symbol}8.50)`);
      }
      for (const item of messages(`fixed-${currency}`)) check(item.fields["Coupon Code"]).toBe(`SAVE15 (${symbol}15.00 off - ${symbol}15.00)`);
      for (const item of messages(`recovery-${currency}`)) check(item.fields["Paid Amount"]).toBe(`${symbol}84.99`);
    }
    for (const kind of ["registration_verification", "password_reset"]) {
      for (const [caseName, wording] of [["ten-minutes", "This private link expires Oct 11, 2026, 12:10 AM UTC."], ["one-hour", "This private link expires Oct 11, 2026, 1:00 AM UTC."], ["utc-minute", "This private link expires Oct 11, 2026, 12:01 AM UTC."], ["utc-midnight", "This private link expires Oct 12, 2026, 12:00 AM UTC."], ["utc-afternoon", "This private link expires Oct 11, 2026, 3:30 AM UTC."], ["expired", "has expired"], ["missing", "expiry is unavailable"]]) {
        check(messages(`${kind}-${caseName}`)[0].text, `${kind}-${caseName}`).toContain(wording);
      }
    }
    check(messages("normal")[0].text).toContain("using the button below");
    for (const caseName of ["retry-booking", "retry-recovery", "retry-booking-no-receipt", "retry-recovery-no-receipt"]) {
      const input = capture.inputs.find(item => item.case === caseName);
      const recovery = caseName.startsWith("retry-recovery");
      const prefix = recovery ? "recoveryNotification" : "emailDispatch";
      check(input.after[`${prefix}Status`], caseName).toBe("delivery_unknown");
      const outcome = recovery ? input.result : input.result.body;
      check(outcome, caseName).toMatchObject({ retryable: false, deliveryUnknown: true });
      check(outcome.ok, caseName).toBe(false);
      check(recovery ? outcome.notificationRequired : outcome.emailDispatch.allSent, caseName).toBe(false);
      check(recovery ? input.repeat : input.repeat.body, `${caseName} repeat`).toMatchObject({ retryable: false, deliveryUnknown: true });
      check(input.after[`${prefix}NextAttemptAt`], caseName).toBe("");
      check(input.attempts, caseName).toBe(2);
      for (const recipient of ["Client", "Owner"]) {
        const recipientPrefix = recovery ? `recovery${recipient}` : `emailDispatch${recipient}`;
        check(input.after[`${recipientPrefix}FirstAttemptAt`]).toBe(input.booking[`${recipientPrefix}FirstAttemptAt`]);
        check(input.after[`${recipientPrefix}ProviderId`] || "").toBe(input.booking[`${recipientPrefix}ProviderId`] || "");
        check(input.after[recovery ? `${recipientPrefix}NotifiedAt` : `${recipientPrefix}SentAt`]).toBeFalsy();
      }
      check(messages(caseName).slice(0, 2).map(item => item.options.idempotencyKey)).toEqual([
        `booking-${input.booking._id}-${recovery ? "reschedule-" : ""}client`,
        `booking-${input.booking._id}-${recovery ? "reschedule-" : ""}owner`,
      ]);
    }
    for (const kind of ["registration_verification", "password_reset"]) {
      const input = capture.inputs.find(item => item.case === `${kind}-retry`);
      check(input.result).toMatchObject({ sent: 0, retry: 1, deadLetter: 0 });
      check(input.completion).toMatchObject({ p_success: false, p_error_code: "email_idempotency_conflict", p_provider_message_id: null });
      check(input.completion.p_retry_delay_seconds).toBe(120);
      check(capture.inputs.find(item => item.case === `${kind}-direct-conflict`).error).toMatchObject({ code: "email_idempotency_conflict" });
      const stable = messages(`${kind}-deterministic`).map(({ payload }) => ({ subject: payload.subject, html: payload.html, text: payload.text }));
      check(stable).toHaveLength(3);
      for (const payload of stable.slice(1)) check(payload).toEqual(stable[0]);
      check(messages(input.case)[0].options.idempotencyKey).toBe(input.dispatch.idempotency_key);
    }
    for (const caseName of ["concurrent-booking", "concurrent-recovery"]) {
      const input = capture.inputs.find(item => item.case === caseName);
      check(input.after[caseName === "concurrent-booking" ? "emailDispatchStatus" : "recoveryNotificationStatus"]).not.toBe("sent");
      check(caseName === "concurrent-booking" ? input.result.body : input.result).toMatchObject({ retryable: true, deliveryUnknown: false });
    }
    for (const caseName of ["deterministic-booking", "deterministic-recovery"]) {
      const stable = messages(caseName).map(({ payload }) => ({ subject: payload.subject, html: payload.html, text: payload.text }));
      check(stable).toHaveLength(4);
      check(stable.slice(2)).toEqual(stable.slice(0, 2));
    }
    expect(capture.safety).toEqual({ resend: "module replaced before import", externalRequests: 0 });
    for (const [index, item] of capture.captured.entries()) {
      expect(item.payload.subject).toBeTruthy();
      check(rendered[index].unsafeNodes, item.case).toBe(0);
      check(rendered[index].imagesWithoutAlt, item.case).toBe(0);
      if (item.case === "escaping") check(rendered[index].text).toContain("धन्यवाद 🦘");
      if (!Array.isArray(item.payload.to)) check(item.payload.html).not.toContain("#token=");
    }
    fs.writeFileSync(testInfo.outputPath("captures.json"), JSON.stringify(capture, null, 2));
    fs.writeFileSync(testInfo.outputPath("rendered.json"), JSON.stringify(rendered, null, 2));
  });
}

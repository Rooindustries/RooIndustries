const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", reducedMotion: "reduce" });

for (const width of [1280, 360, 390]) {
  for (const completion of ["paid", "free", "captured"]) {
    for (const newer of ["none", "details", "revision"]) {
      test(`${width}px ${completion} confirmation ${newer === "none" ? "clears completed details" : `preserves newer ${newer}`}`, async ({ page, flow }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        const bookingId = `fixture-completed-${completion}`;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const endpoint = completion === "captured" ? "cancel" : "start";
        await page.route(`**/api/payment/${endpoint}`, async route => {
          await gate;
          await route.fulfill({ json: { ok: true, status: "booked", bookingId,
            captured: completion === "captured", provider: completion === "free" ? "free" : "dodo",
            emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
          } });
        });
        if (completion === "free") {
          await page.route("**/api/payment/quote", route => route.fulfill({ json: {
            ok: true, quoteFingerprint: "fixture-free-completion",
            quote: { grossAmount: 84.99, netAmount: 0, isFree: true },
            providers: { paypal: { enabled: false }, razorpay: { enabled: false } },
          } }));
        }
        try {
          await flow.review();
          await flow.payment();
          if (completion === "captured") {
            await page.evaluate(() => {
              const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
              sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, phase: "payment_pending" }));
              sessionStorage.setItem("payment_session_state", JSON.stringify({ paymentAccessToken: "fixture-completed-access" }));
            });
            await page.goto("/booking");
          }
          const request = page.waitForRequest(`**/api/payment/${endpoint}`);
          await page.getByRole("button", { name: completion === "captured" ? "Release payment"
            : completion === "free" ? "Confirm Free Booking" : "Pay your way", exact: true }).click();
          await request;
          const before = await page.evaluate(preserve => {
            const checkout = JSON.parse(sessionStorage.getItem("checkout_booking_state"));
            const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
            const key = checkout.packageTitle;
            draft.packages["Performance Vertex Max"] = { selectedPackage: { title: "Performance Vertex Max" },
              formRevision: 42, form: { email: "other@example.invalid", discord: "other_visitor" } };
            if (preserve !== "none") {
              if (preserve === "details") draft.packages[key].form.email = "newer@example.invalid";
              draft.packages[key].formRevision += 1000000;
            }
            sessionStorage.setItem("booking_draft", JSON.stringify(draft));
            return { key, draft };
          }, newer);
          release();
          await expect(page.getByRole("heading", { name: completion === "free" ? "Thank You!" : "Payment Successful", exact: true })).toBeVisible();
          const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem("booking_draft")));
          expect(after.packages["Performance Vertex Max"]).toEqual(before.draft.packages["Performance Vertex Max"]);
          if (newer !== "none") expect(after.packages[before.key]).toEqual(before.draft.packages[before.key]);
          else {
            expect(Object.values(after.packages[before.key].form || {}).every(value => !value)).toBe(true);
            expect(after.packages[before.key].formRevision).toBeGreaterThan(before.draft.packages[before.key].formRevision);
          }
          flow.state.holds.clear();
          await flow.reserve();
          await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toHaveValue(newer === "details" ? "newer@example.invalid" : newer === "revision" ? "visitor@example.invalid" : "");
          if (newer === "none") {
            for (const name of ["Discord username", "PC specifications", "Main game or application"]) {
              await expect(page.getByRole("textbox", { name, exact: true })).toHaveValue("");
            }
          }
          await testInfo.attach("completed-draft", { body: JSON.stringify({ before, after, newer, completion }), contentType: "application/json" });
        } finally {
          release();
        }
      });
    }
  }
}

import assert from "node:assert/strict";
import { captureConsole, fixtureMail, readRollback, withEnv } from "./payment-sweep-ads-fixtures.mjs";

const uniqueMigration = "20261114000000_require_one_booking_per_payment_record.sql";
const eventsMigration = "20261114001000_record_booking_paid_events.sql";
const contactMigration = "20261114003000_record_contact_messages.sql";
const recordId = "paymentRecord.fixture";
const bookingId = "booking.fixture";
const missingFunctionCode = "PGRST202";
const contactFields = {
  name: "Fixture Person",
  email: "person@fixture.invalid",
  message: "Synthetic contact message before its store exists.",
};

const withMail = (fn) => () => withEnv(fixtureMail, fn);

const paidLines = (lines) =>
  lines.filter((line) => line.startsWith('{"event":"booking_paid"')).map((line) => JSON.parse(line));

export const registerBookingPaidScenarios = async (ctx) => {
  if (!process.argv.includes("--full-chain")) return;
  const { bookingEventId } = await import("../../src/server/api/payment/salesReceipt.ts");
  const { run, seed, requestFlow, sql, row, commerce, fixture, origin, a1Start, a1Hook } = ctx;

  const clearEvents = () => sql`delete from ops.booking_paid_events`;
  const events = () => sql`select * from ops.booking_paid_events order by created_at, event_id`;
  const reconcileRoute = async () => {
    const response = await fetch(`${origin}/reconcile-route`, { method: "POST" });
    return { status: response.status, body: await response.json() };
  };
  const finalize = async (checkout) => {
    const result = await requestFlow("finalize", {
      paymentAccessToken: checkout.started.body.paymentAccessToken,
      body: checkout.proof,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.ok(result.body.analyticsReceipt, JSON.stringify(result.body));
    return result.body.analyticsReceipt;
  };
  const rebuildShadow = async () => {
    for (const rpc of ["roo_project_operational_shadow", "roo_refresh_operational_shadow"]) {
      assert.equal((await fixture.client.rpc(rpc)).error, null);
    }
  };
  const tableExists = async (name) => (await sql`select to_regclass(${name}) is not null as present`)[0].present;
  const indexExists = (name) => tableExists(`commerce.${name}`);
  const eventsTableExists = () => tableExists("ops.booking_paid_events");
  const rpcMissing = async (name, args) => (await fixture.client.rpc(name, args)).error?.code === missingFunctionCode;
  const awaitSchemaCache = async (missing) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const states = await Promise.all([
        rpcMissing("roo_claim_booking_paid_events", { p_limit: 1 }),
        rpcMissing("roo_claim_contact_retries", { p_limit: 1 }),
      ]);
      if (states.every((state) => state === missing)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`PostgREST schema cache did not ${missing ? "drop" : "load"} the ads functions`);
  };
  const postContactMessage = async () => {
    const { POST } = await import("../../app/api/contact/route.js");
    const response = await POST(new Request(`${origin}/api/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(contactFields),
    }));
    return { status: response.status, body: await response.json() };
  };

  const assertOneEvent = async (paymentRecordId, receipt) => {
    const rows = (await events()).filter((event) => event.payment_record_ref === paymentRecordId);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    const [event] = rows;
    const payment = (await row(paymentRecordId)).payload;
    assert.ok(payment.bookingId, JSON.stringify(payment));
    const bookings = await sql`select id, payment_record_id from commerce.bookings
      where booking_payload->>'paymentRecordId' = ${paymentRecordId}`;
    assert.equal(bookings.length, 1, JSON.stringify(bookings));
    const [typed] = await sql`select id from commerce.payment_records where legacy_sanity_id = ${paymentRecordId}`;
    assert.equal(bookings[0].payment_record_id, typed.id);
    assert.equal(event.booking_id, bookings[0].id);
    assert.equal(event.event_id, bookingEventId(paymentRecordId));
    assert.ok(Number(event.value) > 0);
    if (receipt) {
      assert.equal(receipt.eventId, event.event_id);
      assert.equal(Number(event.value), receipt.amount);
      assert.equal(event.currency, receipt.currency);
      assert.equal(event.provider, receipt.provider);
    }
    return event;
  };

  for (const provider of ["paypal", "razorpay", "dodo"]) {
    await run(`ads-booking-paid-${provider}-webhook-twice`, withMail(async () => {
      await clearEvents();
      const checkout = await a1Start(provider);
      const first = await a1Hook(provider);
      const second = await a1Hook(provider);
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.equal(second.status, 200, JSON.stringify(second));
      const receipt = await finalize(checkout);
      const event = await assertOneEvent(checkout.id, receipt);
      assert.equal(event.status, "pending");
      const settled = await events();
      const saved = (await row(checkout.id)).payload;
      await commerce.patch(saved.bookingId).set({ adminNotes: "Customer asked for a call first" }).commit();
      await rebuildShadow();
      let refund;
      if (provider === "paypal") {
        refund = await requestFlow("paypal", { req: ctx.paypalReq("PAYMENT.CAPTURE.REFUNDED", {
          id: "refund-ads", status: "COMPLETED", amount: { value: "1.00", currency_code: receipt.currency },
          links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/capture-fixture" }],
        }, `event-ads-refund-${checkout.id}`) });
        assert.equal(refund.status, 200, JSON.stringify(refund));
        assert.equal((await row(saved.bookingId)).payload.refundStatus, "partial");
      }
      assert.deepEqual(await events(), settled);
      return { provider, receipt, event, webhookStatuses: [first.status, second.status], refund: refund?.body };
    }));
  }

  const paymentStatus = (checkout) =>
    requestFlow("status", { paymentAccessToken: checkout.started.body.paymentAccessToken });

  await run("ads-receipt-rules", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    const unconfirmed = await paymentStatus(checkout);
    assert.equal(unconfirmed.status, 200, JSON.stringify(unconfirmed));
    assert.equal(unconfirmed.body.status, "started", JSON.stringify(unconfirmed.body));
    assert.equal(unconfirmed.body.analyticsReceipt, null, JSON.stringify(unconfirmed.body));
    assert.equal((await a1Hook("paypal")).status, 200);
    const receipt = await finalize(checkout);
    const status = await paymentStatus(checkout);
    assert.equal(status.status, 200, JSON.stringify(status));
    assert.deepEqual(status.body.analyticsReceipt, receipt);
    assert.equal(receipt.paymentType, "paid");
    assert.equal(receipt.provider, "paypal");
    assert.match(receipt.eventId, /^[a-f0-9]{40}$/);
    const event = await assertOneEvent(checkout.id, receipt);
    return { unconfirmed: unconfirmed.body.status, receipt, eventId: event.event_id };
  }));

  await run("ads-receipt-rules-free", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("free");
    const receipt = checkout.started.body.analyticsReceipt;
    assert.equal(checkout.started.body.status, "booked", JSON.stringify(checkout.started.body));
    assert.deepEqual({ paymentType: receipt?.paymentType, provider: receipt?.provider, amount: receipt?.amount },
      { paymentType: "free", provider: "free", amount: 0 }, JSON.stringify(receipt));
    assert.equal(receipt.eventId, bookingEventId(checkout.id));
    const status = await paymentStatus(checkout);
    assert.equal(status.status, 200, JSON.stringify(status));
    assert.deepEqual(status.body.analyticsReceipt, receipt);
    assert.equal((await events()).length, 0);
    return { receipt };
  }));

  await run("ads-booking-paid-webhook-then-reconcile", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    const hook = await a1Hook("paypal");
    assert.equal(hook.status, 200, JSON.stringify(hook));
    assert.equal((await assertOneEvent(checkout.id)).status, "pending");
    const cron = await reconcileRoute();
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    assert.deepEqual(cron.body.summary.bookingPaidEvents, { reported: 1 });
    const flowReconcile = await requestFlow("reconcile");
    assert.equal(flowReconcile.status, 200, JSON.stringify(flowReconcile));
    const event = await assertOneEvent(checkout.id, await finalize(checkout));
    assert.equal(event.status, "reported");
    return { event, summary: cron.body.summary.bookingPaidEvents };
  }));

  await run("ads-booking-paid-reconcile-recovery", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    const stale = new Date(Date.now() - 3600000).toISOString();
    await commerce.patch(checkout.id).set({ nextRecoveryAt: "", createdAt: stale, updatedAt: stale }).commit();
    assert.equal((await events()).length, 0);
    const cron = await reconcileRoute();
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    const saved = (await row(checkout.id)).payload;
    assert.ok(["booked", "email_partial"].includes(saved.status), JSON.stringify(saved));
    assert.ok(saved.events.some((entry) => entry.status === "booked" && entry.source === "reconcile"));
    assert.deepEqual(cron.body.summary.bookingPaidEvents, { reported: 1 });
    const event = await assertOneEvent(checkout.id, await finalize(checkout));
    assert.equal(event.status, "reported");
    const again = await reconcileRoute();
    assert.deepEqual(again.body.summary.bookingPaidEvents, { reported: 0 });
    return { event, recoveredStatus: saved.status };
  }));

  await run("ads-booking-paid-late-capture-reschedule", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    await commerce.patch(checkout.id).set({
      status: "abandoned", verificationState: "server_verified",
      recoveryAttemptCount: 11, recoveryFailureCount: 11, reconciliationRecoveryTerminal: true,
      providerRefundDetailsMissing: false, nextRecoveryAt: "9999-12-31T23:59:59.999Z",
    }).commit();
    const first = await a1Hook("paypal");
    const second = await a1Hook("paypal");
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(second.status, 200, JSON.stringify(second));
    const saved = (await row(checkout.id)).payload;
    assert.equal(saved.requiresReschedule, true, JSON.stringify(saved));
    const [booking] = await sql`select requires_reschedule from commerce.bookings
      where legacy_sanity_id = ${saved.bookingId}`;
    assert.equal(booking.requires_reschedule, true);
    const event = await assertOneEvent(checkout.id);
    assert.equal(event.status, "pending");
    return { event, bookingId: saved.bookingId };
  }));

  await run("ads-booking-paid-upgrade", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal", "upgrade");
    const original = await events();
    assert.equal(original.length, 1, JSON.stringify(original));
    assert.equal(original[0].payment_record_ref, "paymentRecord.original");
    const first = await a1Hook("paypal");
    const second = await a1Hook("paypal");
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(second.status, 200, JSON.stringify(second));
    const event = await assertOneEvent(checkout.id, await finalize(checkout));
    await rebuildShadow();
    const rows = await events();
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.deepEqual(rows.find((entry) => entry.payment_record_ref === "paymentRecord.original"), original[0]);
    return { event, originalEvent: original[0] };
  }));

  await run("ads-booking-paid-free", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("free");
    assert.ok(checkout.started.body.bookingId, JSON.stringify(checkout.started.body));
    const bookings = await sql`select booking_payload->>'paymentProvider' as provider from commerce.bookings`;
    assert.deepEqual(bookings.map((booking) => booking.provider), ["free"]);
    await rebuildShadow();
    assert.equal((await events()).length, 0);
    const cron = await reconcileRoute();
    assert.deepEqual(cron.body.summary.bookingPaidEvents, { reported: 0 });
    return { bookingId: checkout.started.body.bookingId, events: 0 };
  }));

  await run("ads-booking-paid-report", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    assert.equal((await a1Hook("paypal")).status, 200);
    const { result: cron, lines } = await captureConsole("log", reconcileRoute);
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    assert.deepEqual(cron.body.summary.bookingPaidEvents, { reported: 1 });
    const logged = paidLines(lines);
    assert.equal(logged.length, 1, JSON.stringify(lines));
    const event = await assertOneEvent(checkout.id);
    assert.equal(event.status, "reported");
    assert.ok(event.reported_at);
    const loggedKeys = ["currency", "event", "event_id", "package_title", "provider", "value"];
    assert.deepEqual(Object.keys(logged[0]).sort(), loggedKeys);
    assert.equal(logged[0].event_id, event.event_id);
    assert.equal(logged[0].provider, "paypal");
    assert.equal(logged[0].value, Number(event.value));
    assert.equal(logged[0].currency, event.currency);
    assert.ok(lines.every((line) => !line.includes("@")), JSON.stringify(lines));
    const { result: again, lines: secondLines } = await captureConsole("log", reconcileRoute);
    assert.deepEqual(again.body.summary.bookingPaidEvents, { reported: 0 });
    assert.equal(paidLines(secondLines).length, 0);
    return { logged: logged[0], event };
  }));

  await run("ads-booking-paid-claim-failure", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    assert.equal((await a1Hook("paypal")).status, 200);
    fixture.setRequestHook(async (phase, request) => {
      if (phase === "before" && request.path.startsWith("/rest/v1/rpc/roo_claim_booking_paid_events")) {
        throw new Error("Synthetic booking paid claim failure");
      }
    });
    let outcome;
    try {
      outcome = await captureConsole("error", reconcileRoute);
    } finally {
      fixture.setRequestHook(null);
    }
    const { result: cron, lines } = outcome;
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    assert.equal(cron.body.summary.bookingPaidEvents.pending, true);
    assert.equal(cron.body.summary.bookingPaidEvents.errorCode, "FIXTURE_PROXY_ERROR");
    for (const key of ["contactMessages", "emailOnlyRecovery", "typedGapSnapshot", "reconciliationCheckpoint"]) {
      assert.ok(Object.hasOwn(cron.body.summary, key), `Independent duty missing: ${key}`);
    }
    assert.equal(cron.body.summary.contactMessages.pending, undefined, JSON.stringify(cron.body.summary));
    assert.ok(lines.some((line) => line.startsWith("bookingPaidEvents reconciliation failed")), JSON.stringify(lines));
    assert.equal((await assertOneEvent(checkout.id)).status, "pending");
    const retry = await reconcileRoute();
    assert.deepEqual(retry.body.summary.bookingPaidEvents, { reported: 1 });
    assert.equal((await assertOneEvent(checkout.id)).status, "reported");
    return { failedSummary: cron.body.summary.bookingPaidEvents, retried: retry.body.summary.bookingPaidEvents };
  }));

  await run("ads-booking-paid-lost-acknowledgement", withMail(async () => {
    await clearEvents();
    const checkout = await a1Start("paypal");
    assert.equal((await a1Hook("paypal")).status, 200);
    fixture.setRequestHook(async (phase, request) => {
      if (phase === "before" && request.path.startsWith("/rest/v1/rpc/roo_ack_booking_paid_events")) {
        throw new Error("Synthetic booking paid acknowledgement loss");
      }
    });
    let lost;
    try {
      lost = await captureConsole("log", reconcileRoute);
    } finally {
      fixture.setRequestHook(null);
    }
    assert.equal(lost.result.status, 200, JSON.stringify(lost.result.body));
    assert.equal(lost.result.body.summary.bookingPaidEvents.pending, true, JSON.stringify(lost.result.body));
    assert.equal(paidLines(lost.lines).length, 1, JSON.stringify(lost.lines));
    const claimed = await assertOneEvent(checkout.id);
    assert.equal(claimed.status, "claimed");
    assert.ok(claimed.claimed_until > new Date(), JSON.stringify(claimed));
    assert.equal(claimed.reported_at, null);
    const { result: leased, lines: leasedLines } = await captureConsole("log", reconcileRoute);
    assert.deepEqual(leased.body.summary.bookingPaidEvents, { reported: 0 });
    assert.equal(paidLines(leasedLines).length, 0);
    await sql`update ops.booking_paid_events set claimed_until = now() - interval '1 second'
      where event_id = ${claimed.event_id}`;
    const { result: retried, lines } = await captureConsole("log", reconcileRoute);
    assert.deepEqual(retried.body.summary.bookingPaidEvents, { reported: 1 });
    const logged = paidLines(lines);
    assert.deepEqual(logged.map((line) => line.event_id), [claimed.event_id]);
    const reported = await assertOneEvent(checkout.id);
    assert.equal(reported.status, "reported");
    assert.equal(reported.claimed_until, null);
    assert.ok(reported.reported_at);
    const { result: settled, lines: settledLines } = await captureConsole("log", reconcileRoute);
    assert.deepEqual(settled.body.summary.bookingPaidEvents, { reported: 0 });
    assert.equal(paidLines(settledLines).length, 0);
    return { lostSummary: lost.result.body.summary.bookingPaidEvents, claimed, reported, relogged: logged[0] };
  }));

  await run("ads-booking-paid-baseline", withMail(async () => {
    await clearEvents();
    await sql.unsafe(readRollback(eventsMigration));
    try {
      await seed("paypal", "booked", { booking: { paymentRecordId: recordId, paymentProvider: "paypal" } });
      await commerce.create({
        _id: "booking.ads-free", _type: "booking", backendOwner: "supabase", cutoverGeneration: 0,
        status: "captured", netAmount: 0, packageTitle: "Vertex Essentials", paymentProvider: "free",
        paymentRecordId: "paymentRecord.ads-free",
      });
    } finally {
      if (!(await eventsTableExists())) await fixture.apply(eventsMigration);
    }
    const baseline = await events();
    assert.equal(baseline.length, 1, JSON.stringify(baseline));
    assert.equal(baseline[0].status, "baseline");
    assert.equal(baseline[0].payment_record_ref, recordId);
    assert.equal(baseline[0].event_id, bookingEventId(recordId));
    assert.equal(baseline[0].reported_at, null);
    await rebuildShadow();
    await sql`delete from commerce.bookings where legacy_sanity_id = ${bookingId}`;
    await sql`select migration.project_commerce_document_ids(${[bookingId]}::text[])`;
    assert.equal((await sql`select count(*)::int as count from commerce.bookings
      where legacy_sanity_id = ${bookingId}`)[0].count, 1);
    await commerce.patch(bookingId).set({ adminNotes: "Moved to the afternoon" }).commit();
    assert.equal((await sql`select * from public.roo_claim_booking_paid_events(50)`).length, 0);
    assert.deepEqual(await events(), baseline);
    return { baseline: baseline[0], reprojectedWithoutNewEvent: true };
  }));

  await run("ads-unique-payment-record-guard", withMail(async () => {
    await clearEvents();
    await sql.unsafe(readRollback(uniqueMigration));
    let rejection;
    try {
      await seed("paypal", "booked");
      const [payment] = await sql`select id from commerce.payment_records where legacy_sanity_id = ${recordId}`;
      await sql`update commerce.bookings set payment_record_id = ${payment.id} where legacy_sanity_id = ${bookingId}`;
      await sql`insert into commerce.bookings (id, legacy_sanity_id, status, package_title, payment_record_id)
        values (migration.document_uuid('booking', 'booking.ads-duplicate'), 'booking.ads-duplicate',
          'captured', 'Vertex Essentials', ${payment.id})`;
      await assert.rejects(fixture.apply(uniqueMigration), (error) => {
        rejection = error.message;
        return error.message.includes(`duplicate bookings share a payment record: ${payment.id} `) &&
          error.message.includes("booking.ads-duplicate") && error.message.includes(bookingId);
      });
      assert.equal(await indexExists("bookings_payment_record_id_idx"), true);
      assert.equal(await indexExists("bookings_payment_record_id_key"), false);
    } finally {
      await sql`delete from commerce.bookings where legacy_sanity_id = 'booking.ads-duplicate'`;
      if (!(await indexExists("bookings_payment_record_id_key"))) await fixture.apply(uniqueMigration);
    }
    assert.equal(await indexExists("bookings_payment_record_id_idx"), false);
    const [index] = await sql`select indisunique, pg_get_expr(indpred, indrelid) as predicate from pg_index
      where indexrelid = 'commerce.bookings_payment_record_id_key'::regclass`;
    assert.equal(index.indisunique, true);
    assert.equal(index.predicate, "(payment_record_id IS NOT NULL)");
    const [payment] = await sql`select id from commerce.payment_records where legacy_sanity_id = ${recordId}`;
    await assert.rejects(sql`insert into commerce.bookings
      (id, legacy_sanity_id, status, package_title, payment_record_id)
      values (gen_random_uuid(), 'booking.ads-second', 'captured', 'Vertex Essentials', ${payment.id})`,
    (error) => error.code === "23505" && error.constraint_name === "bookings_payment_record_id_key");
    return { rejection, uniqueIndex: index };
  }));
  await run("ads-cron-duties-before-migrations", withMail(async () => {
    await clearEvents();
    await sql.unsafe(readRollback(contactMigration));
    await sql.unsafe(readRollback(eventsMigration));
    let outcome;
    try {
      await awaitSchemaCache(true);
      outcome = await captureConsole("error", async () => ({
        contact: await postContactMessage(),
        cron: await reconcileRoute(),
      }));
    } finally {
      if (!(await eventsTableExists())) await fixture.apply(eventsMigration);
      if (!(await tableExists("ops.contact_messages"))) await fixture.apply(contactMigration);
      await awaitSchemaCache(false);
    }
    const { result: { contact, cron }, lines } = outcome;
    assert.equal(contact.status, 503, JSON.stringify(contact));
    assert.equal(contact.body.ok, false, JSON.stringify(contact));
    const recordFailure = lines.find((line) => line.startsWith("contact_message_record_failed"));
    assert.ok(recordFailure?.includes(missingFunctionCode), JSON.stringify(lines));
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    const { summary } = cron.body;
    for (const duty of ["bookingPaidEvents", "contactMessages"]) {
      assert.deepEqual(summary[duty], { pending: true, errorCode: missingFunctionCode }, JSON.stringify(summary));
      assert.ok(lines.some((line) => line.startsWith(`${duty} reconciliation failed`)), JSON.stringify(lines));
    }
    const independentDuties = [
      "rateLimitBucketsCleaned", "emailOnlyRecovery", "typedGapSnapshot", "reconciliationCheckpoint",
    ];
    for (const duty of independentDuties) {
      assert.ok(Object.hasOwn(summary, duty), `Independent duty missing: ${duty}`);
      assert.notEqual(summary[duty]?.pending, true, JSON.stringify(summary));
    }
    for (const value of Object.values(contactFields)) {
      assert.ok(lines.every((line) => !line.includes(value)), JSON.stringify(lines));
    }
    const restored = await reconcileRoute();
    assert.deepEqual(restored.body.summary.bookingPaidEvents, { reported: 0 });
    assert.deepEqual(restored.body.summary.contactMessages, { claimed: 0, sent: 0, failed: 0 });
    return { contactStatus: contact.status, failedDuties: { bookingPaidEvents: summary.bookingPaidEvents,
      contactMessages: summary.contactMessages }, restored: restored.body.summary.contactMessages };
  }));
};

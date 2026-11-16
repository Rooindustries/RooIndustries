import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBookingHoldFixture } from "./fixtures/booking-hold.mjs";

let fixture;
before(async () => { fixture = await createBookingHoldFixture(); });
after(async () => { await fixture?.stop(); });

const refresh = (payload, credentials = {}) => fixture.post("/api/holdSlot", {
  startTimeUTC: payload.startTimeUTC,
  packageTitle: payload.packageTitle,
  previousHoldId: payload.slotHoldId,
  previousHoldToken: payload.slotHoldToken,
  ...credentials,
});
const paymentMessage = "This slot already has a payment session in progress.";

test("an owner can recognize a live payment hold without losing valid credentials", async () => {
  const payload = await fixture.hold();
  const before = await fixture.commerce.getDocument(payload.slotHoldId);
  const payment = await fixture.start(payload);
  assert.equal(payment.status, 200, JSON.stringify(payment));
  const response = await refresh(payload);
  const stored = await fixture.commerce.getDocument(payload.slotHoldId);
  const { verifyHoldToken } = await import("../src/server/booking/holdToken.js");
  assert.equal(stored.phase, "payment_pending");
  assert.equal(stored.holdNonce, before.holdNonce);
  assert.ok(verifyHoldToken({ token: payload.slotHoldToken, holdId: stored._id,
    startTimeUTC: stored.startTimeUTC, holdNonce: stored.holdNonce,
    backend: stored.backendOwner, cutoverGeneration: Number(stored.cutoverGeneration || 0) }));
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { ok: false, message: paymentMessage, code: "hold_payment_in_progress" });
  assert.deepEqual(fixture.evidence.blocked, []);
});

test("payment ownership is not exposed to missing, invalid, or foreign credentials", async () => {
  const payload = await fixture.hold();
  assert.equal((await fixture.start(payload)).status, 200);
  for (const credentials of [
    { previousHoldId: null, previousHoldToken: null },
    { previousHoldToken: "invalid-token" },
    { previousHoldId: "another-hold" },
  ]) {
    const response = await refresh(payload, credentials);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, message: paymentMessage });
  }
});

test("a token superseded before payment cannot identify the payment owner", async () => {
  const payload = await fixture.hold();
  const updated = await refresh(payload);
  assert.equal(updated.status, 200);
  assert.notEqual(updated.body.holdToken, payload.slotHoldToken);
  assert.equal((await fixture.start({ ...payload, slotHoldToken: updated.body.holdToken })).status, 200);
  const stale = await refresh(payload);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { ok: false, message: paymentMessage });
});

test("an ordinary foreign active hold keeps its existing 409 response", async () => {
  const payload = await fixture.hold();
  const response = await refresh(payload, { previousHoldToken: "invalid-token" });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { ok: false, message: "This slot is currently reserved by someone else." });
});

test("a legacy paid booking creates its missing payment record", async () => {
  const payload = await fixture.hold();
  const response = await fixture.post("/api/ref/createBooking", {
    ...payload,
    status: "captured",
    paymentProvider: "paypal",
    paypalOrderId: "fixture_legacy_order",
    payerEmail: payload.email,
    displayDate: "Monday, January 15, 2099",
    displayTime: "10:00 AM",
    deferEmailsUntilConfirmation: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response));
  const records = await fixture.commerce.fetch(
    '*[_type == "paymentRecord" && provider == "paypal" && providerOrderId == $id]',
    { id: "fixture_legacy_order" }
  );
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.status, "email_partial");
  assert.equal(record.bookingId, response.body.bookingId);
  assert.equal(record.payerEmail, payload.email);
  assert.equal(record.emailDispatchToken, response.body.emailDispatchToken);
  assert.equal(record.bookingPayload.packageTitle, payload.packageTitle);
  assert.equal(record.bookingPayload.email, payload.email);
  assert.equal(record.bookingPayload.paymentProvider, "paypal");
  assert.equal(record.pricingSnapshot.netAmount, 54.95);
});

test("historical reconstruction keeps delivered emails and accounting unchanged", async () => {
  const payload = await fixture.hold();
  fixture.setPaymentStatus("succeeded");
  try {
    const started = await fixture.start(payload);
    assert.equal(started.status, 200, JSON.stringify(started));
    const record = await fixture.commerce.fetch(
      '*[_type == "paymentRecord" && bookingPayload.slotHoldId == $id][0]',
      { id: payload.slotHoldId }
    );
    const referralId = "referral.fixture.historical";
    await fixture.content.create({ _id: referralId, _type: "referral", creatorEmail: "creator@example.invalid",
      registrationStatus: "active", successfulReferrals: 4 });
    const completedAt = "2099-01-15T10:05:00.000Z";
    await fixture.commerce.patch(record._id).set({ historicalBookingReconstruction: true,
      emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
      lastEmailDispatchAt: completedAt,
      pricingSnapshot: { ...record.pricingSnapshot, effectiveReferralId: referralId },
      bookingPayload: { ...record.bookingPayload, couponCode: "HISTORICAL" },
    }).commit();
    const emailsBefore = fixture.evidence.providerRequests.filter(request => request.path === "/emails").length;
    const redemptionsBefore = await fixture.commerce.fetch('*[_type == "couponRedemption"]{_id}');
    const response = await fixture.post("/api/payment/finalize", {}, `Bearer ${started.body.paymentAccessToken}`);
    assert.equal(response.status, 200, JSON.stringify(response));
    const booking = await fixture.commerce.getDocument(response.body.bookingId);
    const payment = await fixture.commerce.getDocument(record._id);
    const bookings = await fixture.commerce.fetch('*[_type == "booking" && paymentRecordId == $id]', { id: record._id });
    assert.equal(bookings.length, 1);
    assert.equal(booking.emailDispatchStatus, "sent");
    assert.equal(booking.emailDispatchClientSentAt, completedAt);
    assert.equal(booking.emailDispatchOwnerSentAt, completedAt);
    assert.equal(fixture.evidence.providerRequests.filter(request => request.path === "/emails").length, emailsBefore);
    assert.deepEqual(await fixture.commerce.fetch('*[_type == "couponRedemption"]{_id}'), redemptionsBefore);
    assert.equal((await fixture.content.getDocument(referralId)).successfulReferrals, 4);
    assert.equal(payment.status, "booked");
    assert.equal(payment.bookingId, booking._id);
  } finally {
    fixture.setPaymentStatus(null);
  }
});

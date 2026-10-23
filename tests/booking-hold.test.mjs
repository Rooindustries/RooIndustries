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

test("an owner whose copy of the token expired still recognizes their live payment hold", async () => {
  const payload = await fixture.hold();
  assert.equal((await fixture.start(payload)).status, 200);
  const stored = await fixture.commerce.getDocument(payload.slotHoldId);
  const { issueHoldToken } = await import("../src/server/booking/holdToken.js");
  const expiredCopy = issueHoldToken({
    holdId: stored._id, startTimeUTC: stored.startTimeUTC, expiresAt: new Date(Date.now() - 60000).toISOString(),
    holdNonce: stored.holdNonce, backend: stored.backendOwner, cutoverGeneration: Number(stored.cutoverGeneration || 0),
  });
  const response = await refresh(payload, { previousHoldToken: expiredCopy });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { ok: false, message: paymentMessage, code: "hold_payment_in_progress" });
  assert.equal((await fixture.commerce.getDocument(payload.slotHoldId)).phase, "payment_pending");
});

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
const seedHoldState = (id, values) => fixture.sql.begin(async sql => {
  await sql`update migration.source_documents set payload = payload || ${sql.json(values)}
    where legacy_sanity_id = ${id}`;
  await sql`update commerce.slot_holds set payload = payload || ${sql.json(values)},
    expires_at = coalesce(${values.expiresAt || null}::timestamptz, expires_at),
    phase = coalesce(${values.phase || null}, phase),
    released_at = case when ${values.phase === "released"} then now() else released_at end,
    payment_record_id = case when ${values.phase === "released"} then null else payment_record_id end
    where legacy_sanity_id = ${id}`;
  await sql`select migration.reconcile_slot_claims_for_times(array(
    select start_time_utc from commerce.slot_holds where legacy_sanity_id = ${id}
  ))`;
});

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

test("an expired pending payment keeps its hold ownership until the server releases it", async () => {
  const payload = await fixture.hold();
  assert.equal((await fixture.start(payload)).status, 200);
  const original = await fixture.commerce.getDocument(payload.slotHoldId);
  const expiresAt = new Date(Date.now() - 60000).toISOString();
  await seedHoldState(original._id, { expiresAt });
  const { issueHoldToken } = await import("../src/server/booking/holdToken.js");
  const expiredToken = issueHoldToken({ holdId: original._id, startTimeUTC: original.startTimeUTC,
    expiresAt, holdNonce: original.holdNonce, backend: original.backendOwner,
    cutoverGeneration: Number(original.cutoverGeneration || 0) });
  const before = await fixture.commerce.getDocument(original._id);
  const paymentBefore = await fixture.commerce.getDocument(before.paymentRecordId);
  const response = await refresh(payload, { previousHoldToken: expiredToken });
  assert.equal(response.status, 409, JSON.stringify(response));
  assert.deepEqual(response.body, { ok: false, message: paymentMessage, code: "hold_payment_in_progress" });
  assert.deepEqual(await fixture.commerce.getDocument(original._id), before);
  assert.deepEqual(await fixture.commerce.getDocument(before.paymentRecordId), paymentBefore);
  await seedHoldState(original._id, { phase: "released", paymentRecordId: "" });
  const recovered = await refresh(payload, { previousHoldToken: expiredToken });
  assert.equal(recovered.status, 200, JSON.stringify(recovered));
  assert.notEqual(recovered.body.holdToken, expiredToken);
  const final = await fixture.commerce.getDocument(original._id);
  assert.equal(final.phase, "active");
  assert.notEqual(final.holdNonce, before.holdNonce);
  assert.deepEqual(await fixture.commerce.getDocument(before.paymentRecordId), paymentBefore);
});

test("an expired payment hold can still be reserved by a different visitor", async () => {
  const payload = await fixture.hold();
  assert.equal((await fixture.start(payload)).status, 200);
  const original = await fixture.commerce.getDocument(payload.slotHoldId);
  const payment = await fixture.commerce.getDocument(original.paymentRecordId);
  await seedHoldState(original._id, { expiresAt: new Date(Date.now() - 60000).toISOString() });
  const response = await refresh(payload, { previousHoldId: null, previousHoldToken: null });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.notEqual((await fixture.commerce.getDocument(original._id)).holdNonce, original.holdNonce);
  assert.equal(response.body.code, undefined);
  assert.deepEqual(await fixture.commerce.getDocument(original.paymentRecordId), payment);
});

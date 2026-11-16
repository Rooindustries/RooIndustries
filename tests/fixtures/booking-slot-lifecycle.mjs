import assert from "node:assert/strict";
import { endOwnChannel } from "../../scripts/lib/own-channel.mjs";
import { createBookingContactFixture } from "./booking-contact.mjs";

const fixture = await createBookingContactFixture({ artifactName: "booking-slot-lifecycle" });
const { commerce, content } = fixture;
const { sql } = fixture.database;
const { buildBookingSlotId, buildSlotHoldId } = await import("../../src/server/booking/slotIdentity.js");
const { verifyHoldToken } = await import("../../src/server/booking/holdToken.js");
const { applyBookingRefund } = await import("../../src/server/api/ref/bookingRefunds.js");

const slotAt = startTimeUTC => ({
  startTimeUTC,
  date: startTimeUTC.slice(0, 10),
  lockId: buildBookingSlotId(startTimeUTC),
  holdId: buildSlotHoldId(startTimeUTC),
});
const adminStatus = (bookingId, status) =>
  fixture.post("/api/ref/updateBookingStatus", { bookingId, status }, "", { "x-admin-key": "fixture-only-admin" });

let seeded = 0;
let commerceLock;
let restore;

const operations = {
  post: fixture.post,
  availability: fixture.availability,
  adminStatus,
  document: id => commerce.getDocument(id),
  referral: id => content.getDocument(id),
  async book(codes) {
    const payload = await fixture.hold(codes);
    const started = await fixture.start(payload);
    assert.equal(started.status, 200, JSON.stringify(started));
    const record = await fixture.recordFor(payload);
    const paid = await fixture.dodoWebhook(`payment_${record.providerOrderId}`, "payment.succeeded", `lifecycle_${record._id}`);
    assert.equal(paid.status, 200, JSON.stringify(paid));
    return { ...slotAt(payload.startTimeUTC), bookingId: paid.body.bookingId };
  },
  async cancelledBooking() {
    const number = ++seeded;
    const day = new Date(Date.UTC(2099, 0, 241 - number)).toISOString().slice(0, 10);
    const slot = slotAt(`${day}T04:30:00.000Z`);
    const bookingId = `booking.lifecycle.cancelled.${number}`;
    await commerce.create({
      _id: bookingId, _type: "booking", backendOwner: "supabase", cutoverGeneration: 0, status: "cancelled",
      startTimeUTC: slot.startTimeUTC, packageTitle: "Vertex Essentials", email: "earlier@example.invalid",
    });
    return { ...slot, bookingId };
  },
  async discountCodes() {
    const number = ++seeded;
    const codes = {
      referralId: `referral.lifecycle.${number}`, referralCode: `friend${number}`,
      couponId: `coupon.lifecycle.${number}`, couponCode: `REFUND${number}`,
    };
    await content.create({
      _id: codes.referralId, _type: "referral", slug: { _type: "slug", current: codes.referralCode },
      registrationStatus: "verified", currentDiscountPercent: 5, currentCommissionPercent: 10, successfulReferrals: 0,
      backendOwner: "supabase", cutoverGeneration: 0,
    });
    await commerce.create({
      _id: codes.couponId, _type: "coupon", code: codes.couponCode, isActive: true, discountType: "percent",
      discountPercent: 10, canCombineWithReferral: true, timesUsed: 0, activeReservations: 0, maxUses: 1,
      backendOwner: "supabase", cutoverGeneration: 0,
    });
    return codes;
  },
  async latePartialRefund(bookingId) {
    const booking = await commerce.getDocument(bookingId);
    return applyBookingRefund({
      client: commerce,
      paymentRecord: await commerce.getDocument(booking.paymentRecordId),
      refund: { full: false, id: `late-partial-${bookingId}`, totalRefundedAmount: 1, currency: "USD" },
    });
  },
  async verifyHold({ token, holdId }) {
    const stored = await commerce.getDocument(holdId);
    return Boolean(verifyHoldToken({
      token, holdId, startTimeUTC: stored.startTimeUTC, holdNonce: stored.holdNonce,
      backend: stored.backendOwner, cutoverGeneration: Number(stored.cutoverGeneration || 0),
    }));
  },
  async holdCommerceLock() {
    const held = Promise.withResolvers();
    const released = Promise.withResolvers();
    const finished = sql.begin(async transaction => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('cms-reference-integrity', 0))`;
      held.resolve();
      await released.promise;
    });
    await Promise.race([held.promise, finished]);
    commerceLock = { release: released.resolve, finished };
  },
  async commerceLockWaiters() {
    const [{ waiting }] = await sql`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted`;
    return waiting;
  },
  async releaseCommerceLock() {
    commerceLock.release();
    await commerceLock.finished;
  },
  beginRestore(bookingId) {
    restore = adminStatus(bookingId, "captured");
  },
  restoreAnswer: () => restore,
};

const shutdown = async () => { await fixture.stop(); endOwnChannel(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.once("disconnect", () => { fixture.stop(); });
process.on("message", async ({ id, method, args }) => {
  try {
    if (method === "stop") {
      await fixture.stop();
      process.send({ id, value: true });
      endOwnChannel();
      return;
    }
    process.send({ id, value: await operations[method](...args) });
  } catch (error) { process.send({ id, error: error.stack || error.message }); }
});
process.send({ ready: true, operations: Object.keys(operations) });

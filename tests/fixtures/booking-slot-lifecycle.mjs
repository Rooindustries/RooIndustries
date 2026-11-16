import assert from "node:assert/strict";
import { endOwnChannel } from "../../scripts/lib/own-channel.mjs";
import { createBookingContactFixture } from "./booking-contact.mjs";

const fixture = await createBookingContactFixture({ artifactName: "booking-slot-lifecycle" });
const { commerce, content } = fixture;
const { sql } = fixture.database;
const { buildBookingSlotId, buildSlotHoldId } = await import("../../src/server/booking/slotIdentity.js");
const { verifyHoldToken } = await import("../../src/server/booking/holdToken.js");

const packageTitle = "Vertex Essentials";
const slotTimeUTC = "T04:30:00.000Z";
const latePartialSubunits = 100;
const adminStatus = (bookingId, status) =>
  fixture.post("/api/ref/updateBookingStatus", { bookingId, status }, "", { "x-admin-key": "fixture-only-admin" });
const paymentSucceeded = (orderId, delivery) =>
  fixture.dodoWebhook(`payment_${orderId}`, "payment.succeeded", `lifecycle_paid_${orderId}_${delivery}`);

let seeded = 0;
let commerceLock;
let restore;

const operations = {
  post: fixture.post,
  availability: fixture.availability,
  adminStatus,
  paymentSucceeded,
  document: id => commerce.getDocument(id),
  referral: id => content.getDocument(id),
  freeSlot() {
    const { date } = fixture.dateSlots.at(-1 - seeded++);
    const startTimeUTC = `${date}${slotTimeUTC}`;
    return { startTimeUTC, date, lockId: buildBookingSlotId(startTimeUTC), holdId: buildSlotHoldId(startTimeUTC) };
  },
  async book(slot, codes) {
    const held = await fixture.post("/api/holdSlot", { startTimeUTC: slot.startTimeUTC, packageTitle });
    assert.equal(held.status, 200, JSON.stringify(held));
    const started = await fixture.start({
      packageTitle, ...fixture.details, startTimeUTC: slot.startTimeUTC, slotHoldId: held.body.holdId,
      slotHoldToken: held.body.holdToken, deferEmailsUntilConfirmation: true, ...codes,
    });
    assert.equal(started.status, 200, JSON.stringify(started));
    const { orderId } = started.body.providerPayload;
    const paid = await paymentSucceeded(orderId, "first");
    assert.equal(paid.status, 200, JSON.stringify(paid));
    return { ...slot, bookingId: paid.body.bookingId, paymentId: `payment_${orderId}` };
  },
  async cancelledBooking() {
    const slot = operations.freeSlot();
    const bookingId = `booking.lifecycle.cancelled.${seeded}`;
    await commerce.create({
      _id: bookingId, _type: "booking", backendOwner: "supabase", cutoverGeneration: 0, status: "cancelled",
      startTimeUTC: slot.startTimeUTC, packageTitle, email: "earlier@example.invalid",
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
  async activeUpgrade({ bookingId, startTimeUTC }) {
    await commerce.create({
      _id: `${bookingId}.upgrade`, _type: "booking", backendOwner: "supabase", cutoverGeneration: 0, status: "captured",
      originalOrderId: bookingId, startTimeUTC, packageTitle: "Performance Vertex Overhaul", email: fixture.details.email,
    });
  },
  async sellAtPagePrice({ packageTitle, packagePrice }) {
    const sold = await content.fetch(`*[_type == "package" && title == $title][0]`, { title: packageTitle });
    await content.patch(sold._id).set({ price: packagePrice }).commit();
  },
  async markRefunded(bookingId) {
    await commerce.patch(bookingId).set({ status: "refunded" }).commit();
  },
  latePartialRefund: ({ paymentId }) => fixture.refundPayment(paymentId, [{
    refund_id: `late_partial_${paymentId}`, payment_id: paymentId, amount: latePartialSubunits, currency: "USD", status: "succeeded", is_partial: true,
  }], `lifecycle_late_partial_${paymentId}`),
  async bookingsAt(startTimeUTC) {
    const bookings = await commerce.fetch('*[_type == "booking" && startTimeUTC == $startTimeUTC]', { startTimeUTC });
    return bookings.map(booking => booking._id);
  },
  async slotClaims(startTimeUTC) {
    const claims = await sql`select claim_type from commerce.slot_claims where start_time_utc = ${startTimeUTC}`;
    return claims.map(claim => claim.claim_type);
  },
  emails: bookingId => fixture.evidence.providerRequests
    .filter(request => request.path === "/emails" && request.body.html.includes(`>${bookingId}<`))
    .map(request => request.body.to)
    .sort(),
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
      return;
    }
    process.send({ id, value: await operations[method](...args) });
  } catch (error) {
    process.send({ id, error: error.stack || error.message });
  } finally {
    if (method === "stop") endOwnChannel();
  }
});
process.send({ ready: true, operations: Object.keys(operations) });

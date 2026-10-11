import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { parse, evaluate } from "groq-js";
import { refuseEnvFiles, installNetworkGuard } from "../../scripts/lib/test-target-safety.mjs";

refuseEnvFiles();
installNetworkGuard([]);
const baseNow = Date.parse("2026-10-11T00:00:00Z");
let now = baseNow;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
const captured = [];
let documents = [];
let revision = 1;
let currentCase;
let providerError;
const client = {
  async fetch(query, params = {}) {
    return (await evaluate(parse(query), { dataset: structuredClone(documents), params })).get();
  },
  patch(id) {
    const changes = { set: {}, defaults: {}, increments: {} };
    const patch = {
      ifRevisionId(value) { changes.revision = value; return patch; },
      set(value) { Object.assign(changes.set, value); return patch; },
      setIfMissing(value) { Object.assign(changes.defaults, value); return patch; },
      inc(value) { Object.assign(changes.increments, value); return patch; },
      async commit() {
        const document = documents.find(value => value._id === id);
        assert.ok(document);
        if (changes.revision && changes.revision !== document._rev) {
          throw Object.assign(new Error("Fixture revision conflict"), { status: 409 });
        }
        for (const [key, value] of Object.entries(changes.defaults)) {
          if (document[key] === undefined) document[key] = value;
        }
        Object.assign(document, changes.set);
        for (const [key, value] of Object.entries(changes.increments)) {
          document[key] = Number(document[key] || 0) + value;
        }
        document._rev = `fixture-${revision++}`;
        return structuredClone(document);
      },
    };
    return patch;
  },
};
globalThis.rooEmailFixtureClient = client;
globalThis.rooEmailFixtureSend = async (payload, options) => {
  captured.push({ case: currentCase, payload: structuredClone(payload), options });
  if (providerError) return { data: null, error: providerError };
  return { data: { id: `capture-${captured.length}` }, error: null };
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "resend") return { url: "roo-email-fixture:resend", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "roo-email-fixture:resend") {
      return { format: "module", source: "export class Resend { constructor() { this.emails = { send: globalThis.rooEmailFixtureSend }; } }", shortCircuit: true };
    }
    if (url.endsWith("/src/server/data/documentClient.js")) {
      return { format: "module", source: "export const createDataClient = () => globalThis.rooEmailFixtureClient;", shortCircuit: true };
    }
    return next(url, context);
  },
});
Object.assign(process.env, {
  RESEND_API_KEY: "capture-only",
  FROM_EMAIL: "booking@fixture.invalid",
  OWNER_EMAIL: "fallback-owner@fixture.invalid",
  SITE_NAME: "Roo Industries",
});
const { sendBookingEmailsForBooking, dispatchRescheduleNotifications } = await import("../../src/server/api/ref/bookingEmails.js");
const { deliverReferralEmailDispatch, sendReferralEmailDirect } = await import("../../src/server/api/ref/referralEmailDispatches.js");
const { buildDeterministicBookingId } = await import("../../src/server/booking/slotIdentity.js");
const inputs = [];
const booking = (name, extra = {}) => ({
  _id: buildDeterministicBookingId({ paymentRecordId: `paymentRecord.${name}` }),
  _type: "booking", _rev: `fixture-${revision++}`, status: "captured", paymentProvider: "dodo",
  email: "customer-a@fixture.invalid", payerEmail: "payer-a@fixture.invalid",
  discord: "Maya#1234", specs: "Ryzen 9800X3D / RTX 5080 / 32 GB DDR5", mainGame: "Valorant",
  message: "Please preserve my streaming settings. धन्यवाद 🦘",
  packageTitle: "Performance Vertex Overhaul", packagePrice: "$84.99",
  grossAmount: 84.99, netAmount: 84.99, dodoTotalAmount: 84.99, currency: "USD",
  startTimeUTC: "2026-11-01T05:30:00Z", originalRequestedStartTimeUTC: "2026-11-01T05:30:00Z",
  localTimeZone: "America/New_York", displayDate: "Sunday, November 1, 2026", displayTime: "1:30 AM",
  hostDate: "Sun, Nov 01, 2026", hostTime: "11:00 AM", hostTimeZone: "Asia/Kolkata",
  ...extra,
});
async function captureBooking(name, extra = {}, recovery = false, error = null) {
  currentCase = name;
  providerError = error;
  const source = booking(name, extra);
  documents = [structuredClone(source), { _id: "settings", _type: "bookingSettings", ownerEmail: "configured-owner@fixture.invalid" }];
  const before = captured.length;
  const send = recovery ? dispatchRescheduleNotifications : sendBookingEmailsForBooking;
  const result = await send({ bookingId: source._id, client });
  if (!error) assert.equal(result.httpStatus ?? 200, 200, JSON.stringify(result));
  assert.equal(captured.length - before, 2, name);
  assert.deepEqual(captured.slice(before).map(item => item.payload.to), [source.email || source.payerEmail, "configured-owner@fixture.invalid"]);
  const after = structuredClone(documents[0]);
  const repeat = await send({ bookingId: source._id, client });
  if (!error) assert.equal(captured.length - before, 2, `${name}: no duplicate delivery`);
  assert.equal(documents[0].displayDate, source.displayDate);
  assert.equal(documents[0].displayTime, source.displayTime);
  inputs.push({ case: name, booking: source, result, repeat, after, attempts: captured.length - before });
  providerError = null;
}
await captureBooking("normal");
await captureBooking("long-fields", {
  email: `${"a".repeat(60)}@fixture.invalid`,
  specs: "Ryzen9800X3D-RTX5080-".repeat(10),
  message: `https://example.invalid/${"x".repeat(180)}`,
});
await captureBooking("recovery-long-fields", {
  email: `${"a".repeat(60)}@fixture.invalid`,
  packageTitle: "PerformanceVertex".repeat(20),
  requiresReschedule: true,
}, true);
const hostile = '<img src=x onerror="alert(1)"> & "quoted" \'single\' धन्यवाद 🦘';
await captureBooking("escaping", { discord: hostile, specs: hostile, mainGame: hostile, message: hostile, referralCode: hostile, couponCode: hostile });
await captureBooking("upgrade", { packageTitle: "Performance Vertex Max", packagePrice: "$64.96", grossAmount: 64.96, netAmount: 64.96, dodoTotalAmount: 64.96, isUpgrade: true });
await captureBooking("free", { netAmount: 0, paymentProvider: "free", couponCode: "FREE", couponDiscountType: "percent", couponDiscountPercent: 100, couponDiscountAmount: 84.99 });
await captureBooking("missing-title", { packageTitle: null });
for (const [name, netAmount] of [["missing", undefined], ["null", null], ["empty", ""], ["nan", NaN], ["infinity", Infinity], ["invalid", "not-money"]]) {
  await captureBooking(`net-${name}`, { netAmount, discountPercent: 10, discountAmount: 8.5, referralCode: "MAYA", couponCode: "SAVE10", couponDiscountPercent: 10, couponDiscountAmount: 8.5 });
}
for (const [name, currency, packagePrice] of [["usd", "USD", "$84.99"], ["eur", "EUR", "€84.99"], ["gbp", "GBP", "£84.99"]]) {
  await captureBooking(`money-${name}`, { currency, packagePrice, netAmount: 76.49, discountPercent: 10, discountAmount: 8.5, couponCode: "SAVE10", couponDiscountPercent: 10, couponDiscountAmount: 8.5 });
  await captureBooking(`fixed-${name}`, { currency, packagePrice, netAmount: 69.99, couponCode: "SAVE15", couponDiscountType: "fixed", couponDiscountValue: 15, couponDiscountAmount: 15 });
  await captureBooking(`recovery-${name}`, { currency, requiresReschedule: true }, true);
}
const clocks = [
  ["stale", "2026-03-08T06:30:00Z", "America/New_York"],
  ["spring-after", "2026-03-08T07:30:00Z", "America/New_York"],
  ["fold-first", "2026-11-01T05:30:00Z", "America/New_York"],
  ["fold-second", "2026-11-01T06:30:00Z", "America/New_York"],
  ["london-first", "2026-10-25T00:30:00Z", "Europe/London"],
  ["london-second", "2026-10-25T01:30:00Z", "Europe/London"],
  ["sydney-before", "2026-10-03T15:30:00Z", "Australia/Sydney"],
  ["sydney-after", "2026-10-03T16:30:00Z", "Australia/Sydney"],
  ["midnight", "2026-12-31T18:30:00Z", "Asia/Kolkata"],
  ["missing-zone", "2026-11-01T05:30:00Z", ""],
  ["invalid-zone", "2026-11-01T05:30:00Z", "Mars/Olympus"],
];
for (const [name, startTimeUTC, localTimeZone] of clocks) {
  const extra = { startTimeUTC, originalRequestedStartTimeUTC: startTimeUTC, localTimeZone, displayDate: "stale date", displayTime: "3:30 AM", hostDate: "stale host date", hostTime: "stale host time" };
  await captureBooking(`clock-${name}`, extra);
  await captureBooking(`requested-${name}`, { ...extra, requiresReschedule: true }, true);
}
await captureBooking("missing-instant", { startTimeUTC: "", originalRequestedStartTimeUTC: "", displayDate: "stale", displayTime: "stale" });
await captureBooking("requested-missing-instant", { startTimeUTC: "", originalRequestedStartTimeUTC: "", requiresReschedule: true, displayDate: "stale", displayTime: "stale" }, true);
await captureBooking("invalid-instant", { startTimeUTC: "not-an-instant", displayDate: "stale", displayTime: "stale" });
await captureBooking("requested-invalid-instant", { originalRequestedStartTimeUTC: "not-an-instant", requiresReschedule: true, displayDate: "stale", displayTime: "stale" }, true);
await captureBooking("requested-original-only", { startTimeUTC: "", originalRequestedStartTimeUTC: "2026-03-08T06:30:00Z", requiresReschedule: true, displayDate: "stale", displayTime: "stale" }, true);
await captureBooking("requested-different-instant", { startTimeUTC: "2026-11-01T05:30:00Z", originalRequestedStartTimeUTC: "2026-03-08T06:30:00Z", requiresReschedule: true }, true);
const conflictError = { name: "invalid_idempotent_request", statusCode: 409, message: "This idempotency key has already been used on a different payload." };
for (const recovery of [false, true]) {
  const prefix = recovery ? "recoveryNotification" : "emailDispatch";
  const fields = {
    requiresReschedule: recovery,
    [`${prefix}Status`]: "retry", [`${prefix}AttemptCount`]: 1,
    [`${prefix}LastAttemptAt`]: new Date(now - 1800000).toISOString(),
    [`${recovery ? "recoveryClient" : "emailDispatchClient"}FirstAttemptAt`]: new Date(now - 1800000).toISOString(),
    [`${recovery ? "recoveryOwner" : "emailDispatchOwner"}FirstAttemptAt`]: new Date(now - 1800000).toISOString(),
    [`${recovery ? "recoveryClient" : "emailDispatchClient"}ProviderId`]: "existing-client-receipt",
    [`${recovery ? "recoveryOwner" : "emailDispatchOwner"}ProviderId`]: "existing-owner-receipt",
  };
  await captureBooking(recovery ? "retry-recovery" : "retry-booking", fields, recovery, conflictError);
  await captureBooking(recovery ? "retry-recovery-no-receipt" : "retry-booking-no-receipt", {
    ...fields,
    [`${recovery ? "recoveryClient" : "emailDispatchClient"}ProviderId`]: "",
    [`${recovery ? "recoveryOwner" : "emailDispatchOwner"}ProviderId`]: "",
  }, recovery, conflictError);
  await captureBooking(recovery ? "concurrent-recovery" : "concurrent-booking", fields, recovery, { name: "concurrent_idempotent_requests", statusCode: 409 });
}
for (const kind of ["registration_verification", "password_reset"]) {
  for (const [name, remaining] of [["ten-minutes", 600000], ["one-hour", 3600000], ["utc-minute", 60000], ["utc-midnight", 86400000], ["utc-afternoon", 12600000], ["expired", -1], ["missing", null], ["long-name", 600000]]) {
    currentCase = `${kind}-${name}`;
    const token = kind === "registration_verification" ? "a".repeat(64) : "b".repeat(64);
    const dispatch = {
      claimed: true, idempotency_key: currentCase, dispatch_kind: kind,
      recipient_email: "creator-a@fixture.invalid", delivery_payload: { token, name: name === "long-name" ? "W".repeat(80) : hostile },
      attempt_count: 3, expires_at: remaining === null ? null : new Date(now + remaining).toISOString(),
    };
    const rpc = async (name, parameters) => {
      if (name === "roo_claim_referral_email_dispatch") return { data: dispatch, error: null };
      if (name === "roo_complete_referral_email_dispatch") return { data: { status: parameters.p_success ? "sent" : "retry" }, error: null };
      throw new Error(`Unexpected fixture RPC ${name}`);
    };
    const before = captured.length;
    await deliverReferralEmailDispatch({ idempotencyKey: dispatch.idempotency_key, adminClient: { rpc }, env: { FROM_EMAIL: "accounts@fixture.invalid" } });
    assert.equal(captured.length - before, 1);
    assert.deepEqual(captured.at(-1).payload.to, [dispatch.recipient_email]);
    inputs.push({ case: currentCase, dispatch });
  }
  currentCase = `${kind}-retry`;
  providerError = conflictError;
  const dispatch = { claimed: true, idempotency_key: `${kind}-original-key`, dispatch_kind: kind, recipient_email: "creator-a@fixture.invalid", delivery_payload: { token: "c".repeat(64), name: "Maya" }, attempt_count: 2, expires_at: new Date(now + 600000).toISOString() };
  let completion;
  const result = await deliverReferralEmailDispatch({
    idempotencyKey: dispatch.idempotency_key,
    adminClient: { rpc: async (name, parameters) => {
      if (name === "roo_claim_referral_email_dispatch") return { data: dispatch, error: null };
      completion = parameters;
      return { data: { status: parameters.p_success ? "sent" : "retry" }, error: null };
    } },
    env: { FROM_EMAIL: "accounts@fixture.invalid" },
  });
  inputs.push({ case: currentCase, dispatch, result, completion });
  currentCase = `${kind}-direct-conflict`;
  let directError = null;
  try {
    await sendReferralEmailDirect({
      dispatchKind: kind, referralId: "referral.fixture", recipientEmail: dispatch.recipient_email,
      token: dispatch.delivery_payload.token, name: "Maya", expiresAt: dispatch.expires_at,
      env: { RESEND_API_KEY: "capture-only", FROM_EMAIL: "accounts@fixture.invalid" },
    });
  } catch (error) {
    directError = { code: error.code, message: error.message };
  }
  inputs.push({ case: currentCase, error: directError });
  providerError = null;
  currentCase = `${kind}-deterministic`;
  const stableDispatch = { ...dispatch, expires_at: new Date(baseNow + 7200000).toISOString() };
  for (const elapsed of [0, 61000, 1800000]) {
    now = baseNow + elapsed;
    await deliverReferralEmailDispatch({
      idempotencyKey: stableDispatch.idempotency_key,
      adminClient: { rpc: async (operation) => ({
        data: operation === "roo_claim_referral_email_dispatch" ? stableDispatch : { status: "sent" }, error: null,
      }) },
      env: { FROM_EMAIL: "accounts@fixture.invalid" },
    });
  }
  now = baseNow;
}
for (const recovery of [false, true]) {
  for (const elapsed of [0, 61000]) {
    now = baseNow + elapsed;
    await captureBooking(recovery ? "deterministic-recovery" : "deterministic-booking", { requiresReschedule: recovery }, recovery);
  }
  now = baseNow;
}
console.log(JSON.stringify({ captured, inputs, safety: { resend: "module replaced before import", externalRequests: 0 } }));

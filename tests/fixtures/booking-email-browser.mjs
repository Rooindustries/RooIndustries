import { createBookingContactFixture } from "./booking-contact.mjs";
import { endOwnChannel } from "../../scripts/lib/own-channel.mjs";

process.env.BOOKING_EMAIL_TOKEN_SECRET = "fixture-only-booking-email";
process.env.PAYPAL_CLIENT_ID = "fixture-paypal-client";
process.env.PAYPAL_CLIENT_SECRET = "fixture-paypal-secret";
process.env.PAYPAL_ENV = "sandbox";
const fixture = await createBookingContactFixture({ artifactName: "booking-email-browser" });
const originalFetch = globalThis.fetch;
const orders = new Map();
const emailKeys = [];
let releaseEmail;
let emailGate;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.origin === "https://api-m.sandbox.paypal.com") {
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "fixture-token" });
    if (url.pathname === "/v2/checkout/orders" && init.method === "POST") {
      const id = `fixture-order-${orders.size + 1}`;
      orders.set(id, JSON.parse(init.body).purchase_units[0].amount);
      return Response.json({ id });
    }
    const id = url.pathname.split("/").at(-1);
    const amount = orders.get(id);
    if (!amount) throw new Error(`Unknown fixture order ${id}`);
    return Response.json({ id, status: "COMPLETED", payer: { email_address: "visitor@example.invalid" },
      purchase_units: [{ payments: { captures: [{ id: `capture-${id}`, status: "COMPLETED", amount }] } }] });
  }
  if (url.origin === "https://api.resend.com" && url.pathname === "/emails") {
    emailKeys.push(new Headers(init.headers).get("idempotency-key"));
    if (emailGate) await emailGate;
  }
  return originalFetch(input, init);
};
let date = 0;
process.on("message", async ({ id, method, args = [] }) => {
  try {
    let value;
    if (method === "post") value = await fixture.post(...args);
    else if (method === "availability") value = await fixture.availability();
    else if (method === "nextDate") value = new Date(Date.UTC(2099, 0, ++date)).toISOString().slice(0, 10);
    else if (method === "document") value = await fixture.commerce.getDocument(...args);
    else if (method === "evidence") value = fixture.evidence;
    else if (method === "emailKeys") value = emailKeys;
    else if (method === "holdEmails") { emailGate = new Promise(resolve => { releaseEmail = resolve; }); value = true; }
    else if (method === "releaseEmails") { emailGate = null; releaseEmail(); value = true; }
    else if (method === "changeMessageAfterRead") {
      const [bookingId, message] = args;
      fixture.setRequestHook(async (phase, request) => {
        if (phase !== "after" || !request.path.endsWith("/roo_fetch_shadow_documents_targeted") ||
            !request.body.p_document_types?.includes("booking") || !request.body.p_ids?.includes(bookingId)) return;
        fixture.setRequestHook(null);
        await fixture.commerce.patch(bookingId).set({ message }).commit();
      });
      value = true;
    }
    else if (method === "stop") {
      await fixture.stop();
      process.send({ id, value: true });
      endOwnChannel();
      return;
    } else throw new Error(`Unknown booking fixture operation: ${method}`);
    process.send({ id, value });
  } catch (error) {
    process.send({ id, error: error.stack || error.message });
  }
});
process.once("disconnect", () => { fixture.stop(); });
process.send({ ready: true });

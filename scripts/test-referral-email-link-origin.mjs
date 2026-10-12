import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  deliverReferralEmailDispatch,
  enqueueReferralEmailMutation,
  reconcileReferralEmailDispatches,
  requeueReferralEmailDispatch,
  sendReferralEmailDirect,
} from "../src/server/api/ref/referralEmailDispatches.js";
import { createSweepPostgresFixture } from "./lib/sweep-postgres-fixture.mjs";
import { installNetworkGuard, localOrigin, refuseEnvFiles } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const host = process.env.ROO_TEST_HOST || "127.0.0.1";
const port = Number(process.env.EMAIL_TEST_PORT || 4582);
const origins = [port + 1, port + 2].map(value => localOrigin(`http://${host}:${value}`));
const restoreNetwork = installNetworkGuard(origins);
const originalError = console.error;
const alerts = [];
console.error = (...args) => { alerts.push(args); originalError(...args); };
let fixture;
const results = [];
const sent = [];
const good = ["https://www.rooindustries.com", "https://www.rooindustries.com/", "https://rooindustries.com", "https://rooindustries.com/"];
const bad = [
  "http://www.rooindustries.com", "https://roo-preview.vercel.app", "http://localhost:3000",
  "https://www.rooindustries.com/preview", "https://user:secret@www.rooindustries.com",
  "https://www.rooindustries.com:443", "https://www.rooindustries.com:8443",
  "https://www.rooindustries.com//", "https://www.rooindustries.com?preview=1",
  "https://www.rooindustries.com#preview", "https://www.rooindustries.com/../",
  "https://accounts.rooindustries.com", " https://www.rooindustries.com ", "not-a-url",
];
try {
  fixture = await createSweepPostgresFixture({ ports: { postgres: port, rest: port + 1, proxy: port + 2 } });
  await fixture.apply("20260715110000_add_referral_email_dispatch_ledger.sql");
  const resolutionMigration = "20260717211139_fix_backbone_parity_and_referral_alerts.sql";
  const resolutionSql = await fs.readFile(`supabase/migrations/${resolutionMigration}`, "utf8");
  await fixture.apply(resolutionMigration, resolutionSql.slice(
    resolutionSql.indexOf("alter table accounts.referral_email_dispatches"),
    resolutionSql.indexOf("create or replace function public.roo_resolve_referral_email_dispatch")
  ), "referral email resolved-state DDL and terminal guard");
  await fixture.apply("20260720091000_harden_referral_email_dispatch_source_state.sql");
  await fixture.sql`notify pgrst, 'reload schema'`;
  for (let attempt = 0; ; attempt++) {
    const readiness = await fixture.client.rpc("roo_referral_email_readiness");
    if (!readiness.error) break;
    assert.equal(readiness.error.code, "PGRST202");
    assert.ok(attempt < 40, "PostgREST did not reload the email dispatch schema");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fixture.setProviderHandler(request => {
    assert.equal(request.path, "/emails");
    sent.push(request.body);
    return { body: { data: { id: `fixture-email-${sent.length}` }, error: null } };
  });
  const resendClient = { emails: { send: async (message, options) => {
    const response = await fetch(`${fixture.origin}/provider/emails`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, options }),
    });
    assert.equal(response.status, 200);
    return response.json();
  } } };
  const production = { VERCEL_ENV: "production", NEXT_PUBLIC_BASE_URL: good[0], FROM_EMAIL: "accounts@fixture.invalid" };
  const enqueue = async (kind, suffix, env = production) => {
    const id = `referral.origin-${kind}-${suffix}`;
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const tokenFields = kind === "password_reset"
      ? { resetTokenHash: tokenHash, resetTokenExpiresAt: expiresAt, registrationStatus: "active" }
      : { registrationVerificationTokenHash: tokenHash, registrationVerificationExpiresAt: expiresAt, registrationStatus: "pending_email" };
    return enqueueReferralEmailMutation({
      mutations: [{ operation: "create", document: {
        _id: id, _type: "referral", creatorEmail: `${id}@fixture.invalid`, name: "Origin Fixture", ...tokenFields,
      } }],
      referralId: id, dispatchKind: kind, recipientEmail: `${id}@fixture.invalid`, token, expiresAt,
      adminClient: fixture.client, env,
    });
  };
  const stateOf = async dispatch => (await fixture.sql`
    select status, attempt_count, last_error_code, sent_at, provider_message_id, next_attempt_at,
      lease_id, lease_expires_at, delivery_payload ? 'token' has_token
    from accounts.referral_email_dispatches where idempotency_key=${dispatch.idempotency_key}
  `)[0];
  for (const kind of ["password_reset", "registration_verification"]) {
    const pending = await enqueue(kind, "pending");
    for (const [index, baseUrl] of bad.entries()) {
      const env = { ...production, NEXT_PUBLIC_BASE_URL: baseUrl };
      const before = fixture.requestLog.length;
      const alertCount = alerts.length;
      await assert.rejects(enqueue(kind, `blocked-${index}`, env), { code: "email_link_origin_invalid" });
      await assert.rejects(requeueReferralEmailDispatch({ referralId: `referral.origin-${kind}-pending`, dispatchKind: kind, adminClient: fixture.client, env }), { code: "email_link_origin_invalid" });
      await assert.rejects(deliverReferralEmailDispatch({ idempotencyKey: pending.idempotency_key, adminClient: fixture.client, resendClient, env }), { code: "email_link_origin_invalid" });
      await assert.rejects(reconcileReferralEmailDispatches({ adminClient: fixture.client, resendClient, env }), { code: "email_link_origin_invalid" });
      await assert.rejects(sendReferralEmailDirect({ dispatchKind: kind, referralId: "referral.direct", recipientEmail: "direct@fixture.invalid", token: "fixture-token", resendClient, env }), { code: "email_link_origin_invalid" });
      assert.equal(fixture.requestLog.length, before, "Refused origins must not enqueue, claim or send");
      assert.ok(alerts.slice(alertCount).some(args => args[1]?.code === "email_link_origin_invalid"));
      const state = await stateOf(pending);
      assert.equal(state.status, "pending");
      assert.equal(state.attempt_count, 0);
      results.push({ kind, baseUrl, state });
    }
    await deliverReferralEmailDispatch({ idempotencyKey: pending.idempotency_key, adminClient: fixture.client, resendClient, env: production });
    for (const [index, baseUrl] of good.entries()) {
      const dispatch = await enqueue(kind, `allowed-${index}`, { ...production, NEXT_PUBLIC_BASE_URL: baseUrl });
      const result = await deliverReferralEmailDispatch({ idempotencyKey: dispatch.idempotency_key, adminClient: fixture.client, resendClient, env: { ...production, NEXT_PUBLIC_BASE_URL: baseUrl } });
      assert.equal(result.sent, 1);
      const target = `${baseUrl.replace(/\/$/, "")}/referrals/${kind === "password_reset" ? "reset" : "verify"}#token=`;
      assert.ok(sent.at(-1).message.html.includes(target));
      const before = sent.length;
      await deliverReferralEmailDispatch({ idempotencyKey: dispatch.idempotency_key, adminClient: fixture.client, resendClient, env: production });
      assert.equal(sent.length, before);
      results.push({ kind, baseUrl, state: await stateOf(dispatch) });
    }
    const claimed = await enqueue(kind, "changes-after-claim");
    const before = sent.length;
    for (let attempt = 1; attempt <= 12; attempt++) {
      let reads = 0;
      const env = { ...production, get NEXT_PUBLIC_BASE_URL() { return ++reads === 1 ? good[0] : bad[0]; } };
      const result = await deliverReferralEmailDispatch({ idempotencyKey: claimed.idempotency_key, adminClient: fixture.client, resendClient, env });
      const state = await stateOf(claimed);
      assert.equal(result.sent, 0);
      assert.equal(state.attempt_count, attempt);
      assert.equal(state.status, attempt === 12 ? "dead_letter" : "retry");
      assert.equal(state.last_error_code, "email_link_origin_invalid");
      assert.equal(state.has_token, true);
      assert.ok(state.next_attempt_at);
      assert.equal(state.lease_id, null);
      assert.equal(state.lease_expires_at, null);
      if (attempt < 12) await fixture.sql`update accounts.referral_email_dispatches set next_attempt_at=now() where idempotency_key=${claimed.idempotency_key}`;
    }
    assert.equal(sent.length, before);
    results.push({ kind, case: "changes-after-claim", state: await stateOf(claimed) });
  }
  for (const [allowed, env] of [
    [true, { VERCEL_ENV: "production", SITE_URL: good[1] }],
    [true, { VERCEL_ENV: "production" }],
    [true, { VERCEL_ENV: "production", NEXT_PUBLIC_BASE_URL: good[0], SITE_URL: bad[0] }],
    [false, { VERCEL_ENV: "production", SITE_URL: bad[0] }],
    [false, { VERCEL_ENV: "production", NEXT_PUBLIC_BASE_URL: "", SITE_URL: bad[0] }],
    [false, { VERCEL_ENV: "production", NEXT_PUBLIC_BASE_URL: bad[0], SITE_URL: good[0] }],
    [false, { NODE_ENV: "production", NEXT_PUBLIC_BASE_URL: bad[1] }],
    [true, { VERCEL_ENV: "preview", NODE_ENV: "production", NEXT_PUBLIC_BASE_URL: bad[1] }],
    [true, { VERCEL_ENV: "development", NEXT_PUBLIC_BASE_URL: bad[2] }],
  ]) {
    const send = () => sendReferralEmailDirect({ dispatchKind: "password_reset", referralId: "referral.fallback", recipientEmail: "fallback@fixture.invalid", token: "fixture-token", resendClient, env });
    if (allowed) await send();
    else await assert.rejects(send(), { code: "email_link_origin_invalid" });
  }
  const batch = await reconcileReferralEmailDispatches({ adminClient: fixture.client, resendClient, env: production });
  assert.deepEqual(batch, { claimed: 0, sent: 0, retry: 0, deadLetter: 0 });
  assert.ok(!JSON.stringify(alerts).includes("user:secret"));
  assert.ok(!JSON.stringify(alerts).includes("fixture-token"));
  const artifact = "test-results/referral-email-link-origin.json";
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile(artifact, JSON.stringify({ results, batch, alerts, postgres: fixture.postgresVersion, postgrest: fixture.postgrestVersion, requests: fixture.requestLog }, null, 2));
  console.log(JSON.stringify({ ok: true, scenarios: results.length, artifact }));
} finally {
  console.error = originalError;
  await fixture?.stop();
  restoreNetwork();
}

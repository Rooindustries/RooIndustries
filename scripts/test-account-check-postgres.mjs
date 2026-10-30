import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { bootstrapSupabaseNativeAccount } from "../src/server/supabase/accounts.js";
import { createSweepPostgresFixture } from "./lib/sweep-postgres-fixture.mjs";
import { installNetworkGuard, localOrigin, refuseEnvFiles } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const host = process.env.ROO_TEST_HOST || "127.0.0.1";
const port = Number(process.env.ACCOUNT_CHECK_TEST_PORT || 4682);
const restoreNetwork = installNetworkGuard([port + 1, port + 2].map(value => localOrigin(`http://${host}:${value}`)));
const accountCount = 40;
const results = [];
let fixture;

const scenario = async (name, run) => {
  try {
    const detail = await run();
    results.push({ name, passed: true, ...(detail || {}) });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    throw error;
  }
};

const rowVersions = async (sql) => {
  const rows = await sql`
    select 'identity_links:' || id::text as key, xmin::text || '/' || xmax::text as version from accounts.identity_links
    union all select 'profiles:' || user_id::text, xmin::text || '/' || xmax::text from public.profiles
    union all select 'principals:' || id::text, xmin::text || '/' || xmax::text from accounts.principals
    union all select 'principal_auth_users:' || user_id::text, xmin::text || '/' || xmax::text from accounts.principal_auth_users
    union all select 'account_roles:' || user_id::text || ':' || role, xmin::text || '/' || xmax::text from accounts.account_roles`;
  return new Map(rows.map(row => [row.key, row.version]));
};

const changedRows = (before, after) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).sort();

const runAccountCheck = async () => {
  const { data, error } = await fixture.client.rpc("roo_reconcile_account_security", { p_guild_id: null });
  assert.equal(error, null, error?.message);
  return data;
};

const createAuthUser = async (sql, { social = "" } = {}) => {
  const id = crypto.randomUUID();
  const email = `account.${id.slice(0, 8)}@example.test`;
  await sql`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (${id}, ${email}, now(), ${sql.json({ full_name: `Fixture ${id.slice(0, 8)}` })})`;
  await sql`insert into auth.identities (user_id, provider, provider_id, email, identity_data, last_sign_in_at)
    values (${id}, 'email', ${id}, ${email}, ${sql.json({ sub: id, email })}, now() - interval '1 day')`;
  if (social) {
    await sql`insert into auth.identities (user_id, provider, provider_id, email, identity_data, last_sign_in_at)
      values (${id}, ${social}, ${crypto.randomBytes(9).toString("hex")}, ${email},
        ${sql.json({ email, email_verified: true, full_name: "Fixture" })}, now() - interval '2 days')`;
  }
  return { id, email, social };
};

const principalOf = async (sql, userId) => {
  const [{ principal_id: principalId }] = await sql`select principal_id from accounts.principal_auth_users where user_id = ${userId}`;
  return principalId;
};

const linkOf = async (sql, account, provider = account.social) => {
  const [link] = await sql`select * from accounts.identity_links where user_id = ${account.id} and provider = ${provider}`;
  return link;
};

const mergeSecondaryLogin = async (sql, primary) => {
  const secondary = await createAuthUser(sql);
  await sql`insert into accounts.principal_auth_users (principal_id, user_id, is_primary, source)
    values (${await principalOf(sql, primary.id)}, ${secondary.id}, false, 'merge')`;
  return secondary;
};

try {
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true, ports: { postgres: port, rest: port + 1, proxy: port + 2 } });
  const { sql } = fixture;
  const accounts = [];
  const byProvider = social => accounts.filter(account => account.social === social);

  await scenario("sign-in creates each account's links and profile", async () => {
    for (let index = 0; index < accountCount; index += 1) {
      const account = await createAuthUser(sql, { social: ["", "google", "discord"][index % 3] });
      await bootstrapSupabaseNativeAccount({ userId: account.id, adminClient: fixture.client });
      accounts.push(account);
    }
    const [{ links, verified, profiles }] = await sql`select
      (select count(*)::int from accounts.identity_links) links,
      (select count(*)::int from accounts.identity_links where email_verified) verified,
      (select count(*)::int from public.profiles where primary_email is not null) profiles`;
    const socialAccounts = accounts.filter(account => account.social).length;
    assert.equal(links, accountCount + socialAccounts);
    assert.equal(verified, accountCount + socialAccounts);
    assert.equal(profiles, accountCount);
    return { links, profiles };
  });

  await scenario("an account check with nothing to repair leaves every account row untouched", async () => {
    const first = await runAccountCheck();
    assert.equal(first.reconciled, accountCount);
    assert.equal(first.failed, 0);
    const before = await rowVersions(sql);
    const second = await runAccountCheck();
    assert.equal(second.reconciled, accountCount);
    assert.equal(second.failed, 0);
    const changed = changedRows(before, await rowVersions(sql));
    assert.deepEqual(changed, [], `${changed.length} account rows were rewritten or locked`);
    return { rows: before.size, changed: changed.length };
  });

  await scenario("signing in again without changes leaves the account's links untouched", async () => {
    const [account] = byProvider("google");
    const before = await rowVersions(sql);
    await bootstrapSupabaseNativeAccount({ userId: account.id, adminClient: fixture.client });
    const changed = changedRows(before, await rowVersions(sql)).filter(key => key.startsWith("identity_links:"));
    assert.deepEqual(changed, []);
  });

  await scenario("the account check repairs each kind of drift and nothing else", async () => {
    const [staleEmail, staleSignIn, foreignOwner, unverified] = byProvider("google");
    const [unlinked, staleMetadata, movedOwner, signedIn, renumbered] = byProvider("discord");
    const [relinked, clearedProfile, ownedElsewhere, emailOwner] = byProvider("");
    const secondary = await mergeSecondaryLogin(sql, movedOwner);
    await sql`update auth.identities set identity_data = identity_data || '{"rank": 1.0}'::jsonb
      where user_id = ${renumbered.id} and provider = 'discord'`;
    assert.equal((await runAccountCheck()).failed, 0);

    const unlinkedLink = await linkOf(sql, unlinked);
    const movedLink = await linkOf(sql, movedOwner);
    const signedInAt = new Date(Date.now() - 60_000).toISOString();
    await sql`update accounts.identity_links set provider_email = ${`stale.${staleEmail.email}`}
      where user_id = ${staleEmail.id} and provider = 'google'`;
    await sql`update accounts.identity_links set last_seen_at = '2020-01-01T00:00:00Z'
      where user_id = ${staleSignIn.id} and provider = 'google'`;
    await sql`update accounts.identity_links set metadata = metadata || '{"stale": true}'::jsonb
      where user_id = ${staleMetadata.id} and provider = 'discord'`;
    await sql`update accounts.identity_links set metadata = jsonb_set(metadata, '{rank}', '1.00'::jsonb)
      where user_id = ${renumbered.id} and provider = 'discord'`;
    await sql`update accounts.identity_links set backend_owner = 'referral_link'
      where user_id = ${foreignOwner.id} and provider = 'google'`;
    await sql`update accounts.identity_links set user_id = ${secondary.id}
      where user_id = ${movedOwner.id} and provider = 'discord'`;
    await sql`update accounts.identity_links set email_verified = false
      where user_id = ${unverified.id} and provider = 'google'`;
    await sql`update auth.identities set last_sign_in_at = ${signedInAt},
        identity_data = identity_data || '{"avatar_url": "https://cdn.example.test/avatar.png"}'::jsonb
      where user_id = ${signedIn.id} and provider = 'discord'`;
    await sql`delete from auth.identities where user_id = ${unlinked.id} and provider = 'discord'`;
    const subject = crypto.randomBytes(9).toString("hex");
    await sql`insert into auth.identities (user_id, provider, provider_id, email, identity_data, last_sign_in_at)
      values (${relinked.id}, 'google', ${subject}, ${relinked.email}, ${sql.json({ email: relinked.email, email_verified: true })}, now())`;
    await sql`update public.profiles set primary_email = null where user_id in (${clearedProfile.id}, ${ownedElsewhere.id})`;
    await sql`update auth.users set email_confirmed_at = null where id = ${emailOwner.id}`;
    await sql`update public.profiles set primary_email = ${ownedElsewhere.email} where user_id = ${emailOwner.id}`;

    const before = await rowVersions(sql);
    const result = await runAccountCheck();
    assert.equal(result.failed, 0);
    const changed = changedRows(before, await rowVersions(sql));

    const repaired = {
      staleEmail: await linkOf(sql, staleEmail),
      staleSignIn: await linkOf(sql, staleSignIn),
      staleMetadata: await linkOf(sql, staleMetadata),
      renumbered: await linkOf(sql, renumbered),
      foreignOwner: await linkOf(sql, foreignOwner),
      movedOwner: await linkOf(sql, movedOwner),
      unverified: await linkOf(sql, unverified),
      signedIn: await linkOf(sql, signedIn),
      relinked: await linkOf(sql, relinked, "google"),
      emailOwner: await linkOf(sql, emailOwner, "email"),
    };
    assert.equal(repaired.staleEmail.provider_email, staleEmail.email);
    const [{ last_sign_in_at: lastSignIn }] = await sql`select last_sign_in_at from auth.identities
      where user_id = ${staleSignIn.id} and provider = 'google'`;
    assert.equal(repaired.staleSignIn.last_seen_at.toISOString(), lastSignIn.toISOString());
    assert.equal(repaired.staleMetadata.metadata.stale, undefined);
    const [{ rank }] = await sql`select metadata->>'rank' as rank from accounts.identity_links where id = ${repaired.renumbered.id}`;
    assert.equal(rank, "1.0");
    assert.equal(repaired.foreignOwner.backend_owner, "supabase");
    assert.notEqual(repaired.movedOwner.id, movedLink.id);
    assert.equal(repaired.unverified.email_verified, true);
    assert.equal(repaired.signedIn.last_seen_at.toISOString(), signedInAt);
    assert.equal(repaired.signedIn.metadata.avatar_url, "https://cdn.example.test/avatar.png");
    assert.equal(repaired.relinked.provider_subject, subject);
    assert.equal(repaired.emailOwner.email_verified, false);
    assert.equal(await linkOf(sql, unlinked), undefined);
    const profiles = await sql`select user_id, primary_email from public.profiles
      where user_id in (${clearedProfile.id}, ${ownedElsewhere.id}, ${emailOwner.id})`;
    assert.deepEqual(
      Object.fromEntries(profiles.map(row => [row.user_id, row.primary_email])),
      { [clearedProfile.id]: clearedProfile.email, [ownedElsewhere.id]: null, [emailOwner.id]: ownedElsewhere.email }
    );

    assert.deepEqual(changed, [
      ...Object.values(repaired).map(link => `identity_links:${link.id}`),
      `identity_links:${unlinkedLink.id}`,
      `identity_links:${movedLink.id}`,
      `principals:${await principalOf(sql, relinked.id)}`,
      `principals:${await principalOf(sql, movedOwner.id)}`,
      `profiles:${clearedProfile.id}`,
    ].sort());
    return { changed: changed.length };
  });

  await scenario("a merged secondary login keeps no primary email of its own", async () => {
    const primary = byProvider("google").at(-1);
    const secondary = await mergeSecondaryLogin(sql, primary);
    const principalId = await principalOf(sql, primary.id);
    await sql`insert into public.profiles (user_id, principal_id, primary_email, display_name)
      values (${secondary.id}, ${principalId}, ${secondary.email}, 'Secondary login')`;

    const result = await runAccountCheck();
    assert.equal(result.failed, 0);
    const profiles = await sql`select user_id, primary_email from public.profiles where principal_id = ${principalId}`;
    assert.deepEqual(
      Object.fromEntries(profiles.map(row => [row.user_id, row.primary_email])),
      { [primary.id]: primary.email, [secondary.id]: null }
    );

    const before = await rowVersions(sql);
    await runAccountCheck();
    assert.deepEqual(changedRows(before, await rowVersions(sql)), []);
  });

  const artifact = "test-results/account-check.json";
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile(artifact, JSON.stringify({ results, postgres: fixture.postgresVersion, postgrest: fixture.postgrestVersion, migrations: fixture.manifest.length }, null, 2));
  console.log(JSON.stringify({ ok: true, scenarios: results.length, artifact }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, results }));
  throw error;
} finally {
  await fixture?.stop();
  restoreNetwork();
}

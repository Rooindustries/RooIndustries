import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {evaluate, parse} from 'groq-js';

export const createLegacyPayoutClient = (sql) => ({
  async fetch(query, params = {}) {
    const rows = await sql`
      select payload from migration.source_documents
      where document_type = 'booking' and not tombstoned
      order by legacy_sanity_id
    `;
    const result = await evaluate(parse(query), {
      dataset: rows.map(row => row.payload),
      params,
    });
    return result.get();
  },
});

export const checkPayoutReadScale = async ({sql, seed, summary}) => {
  const state = await seed('dodo', {booking: false, amount: 1, rate: 1});
  const count = 1100;
  await sql`
    insert into migration.source_documents (
      legacy_sanity_id, document_type, source_revision, source_hash, payload
    )
    select
      ${state.key} || '.history.' || index,
      'booking',
      'scale-history',
      repeat('a', 64),
      jsonb_build_object(
        '_id', ${state.key} || '.history.' || index,
        '_type', 'booking',
        'status', case when index % 2 = 0 then 'captured' else 'completed' end,
        'packageTitle', ${state.packageDoc.title}::text,
        'referral', jsonb_build_object('_type', 'reference', '_ref', ${state.creator._id}::text),
        'referralCode', ${state.key}::text,
        'grossAmount', 1,
        'netAmount', 1,
        'commissionPercent', 1,
        'commissionAmount', 0.01,
        'commissionCalculationVersion', 2
      )
    from generate_series(1, ${count}) as history(index)
  `;
  await sql`select public.roo_project_operational_shadow()`;
  const rows = await sql`
    select payload from migration.source_documents
    where document_type = 'booking' and payload->>'referralCode' = ${state.key}
      and not tombstoned
    order by legacy_sanity_id
  `;
  const bytes = Buffer.byteLength(JSON.stringify(rows.map(row => row.payload)));
  const firstPageBytes = Buffer.byteLength(JSON.stringify(rows.slice(0, 1000).map(row => row.payload)));
  assert.equal(rows.length, count);
  assert.ok(firstPageBytes > 250 * 1024);
  const earnings = await summary(state.creator, 11);
  return {count, bytes, firstPageBytes, earnings};
};

export const checkPayoutCronScale = async ({sql, seed, documents, commerce, fixture, origin, post, mode}) => {
  const state = await seed('dodo');
  const oversized = mode === 'oversized';
  const growing = mode === 'growing';
  const count = oversized ? 3 : growing ? 250 : 525;
  const prefix = `referral.${state.key}.scale.`;
  await sql`
    insert into migration.source_documents (
      legacy_sanity_id, document_type, source_revision, source_hash, payload
    )
    select ${prefix} || lpad(index::text, 4, '0'), 'referral', 'scale', repeat('b', 64),
      jsonb_build_object(
        '_id', ${prefix} || lpad(index::text, 4, '0'), '_type', 'referral', '_rev', 'scale',
        'name', 'Fixture creator', 'slug', jsonb_build_object('current', ${state.key} || '-' || index),
        'notes', repeat('x', case when ${oversized} and index = 2 then 260000 else 2048 end)
      )
    from generate_series(1, ${count}) as creators(index)
  `;
  const [size] = await sql`
    select sum(octet_length(payload::text))::integer as bytes
    from migration.source_documents
    where legacy_sanity_id like ${`${prefix}%`} and not tombstoned
  `;
  assert.ok(size.bytes > 250 * 1024);
  const [access] = await sql`
    select has_function_privilege('anon',
      'public.roo_fetch_shadow_document_sizes(text[],text,integer,text[],jsonb)', 'execute') as anon,
      has_function_privilege('authenticated',
      'public.roo_fetch_shadow_document_sizes(text[],text,integer)', 'execute') as authenticated
  `;
  assert.deepEqual(access, {anon: false, authenticated: false});
  let grew = false;
  if (growing) fixture.setRequestHook(async (phase, request) => {
    if (grew || phase !== 'after' || !request.path.endsWith('/roo_fetch_shadow_document_sizes')) return;
    if (!request.response.some(row => row._id === `${prefix}0002`)) return;
    grew = true;
    await sql`
      update migration.source_documents
      set payload = jsonb_set(payload, '{notes}', to_jsonb(repeat('x', 260000)))
      where legacy_sanity_id = ${`${prefix}0002`}
    `;
  });
  const monitor = Symbol.for('roo.reportServerError');
  const previousReporter = globalThis[monitor];
  const errors = [];
  globalThis[monitor] = (label, error, metadata) => errors.push({label, code: error.code, metadata});
  const cron = async () => {
    const response = await fetch(`${origin}/api/ref/cronSyncAll`, {
      headers: {authorization: 'Bearer fixture'},
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(new Set(body.results.map(row => row.id)).size, body.total);
    const rows = body.results.filter(row => row.id.startsWith(prefix));
    assert.equal(rows.length, count);
    if (oversized || growing) {
      const failed = rows.find(row => row.id === `${prefix}0002`);
      assert.equal(failed.pending, true);
      assert.equal(failed.errorCode, 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED');
      assert.equal(body.complete, false);
      assert.ok(rows.filter(row => row.id !== failed.id).every(row => !row.pending));
      assert.equal(rows.find(row => row.id === `${prefix}${String(count).padStart(4, '0')}`).pending, undefined);
      assert.ok(errors.some(error => error.label === 'Referral cron batch failed' &&
        error.code === 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'));
    } else {
      assert.ok(rows.every(row => !row.pending));
      assert.equal(errors.length, 0);
    }
    return {total: body.total, synced: body.synced, pending: rows.filter(row => row.pending).length};
  };
  try {
    const first = await cron();
    if (growing) assert.equal(first.pending, 1);
    const body = {
      referralId: state.creator._id, packageType: 'vertex', amount: 2,
      payoutId: `transfer-${state.key}`, paidOn: '2026-11-08T10:00:00.000Z',
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post('/api/ref/updatePayments', body, {'x-admin-key': 'fixture-admin'});
      assert.equal(response.status, 200, JSON.stringify(response));
    }
    const second = await cron();
    if (growing) {
      assert.equal(grew, true);
      assert.equal((await cron()).synced, 0);
    } else assert.equal(second.synced, 0);
    if (oversized || growing) {
      await assert.rejects(commerce.getDocument(`${prefix}0002`), {code: 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'});
    }
    const creator = await documents.getDocument(state.creator._id);
    assert.equal(creator.earnedTotal, 5.5);
    assert.equal(creator.paidTotal, 2);
    assert.equal(creator.owedTotal, 3.5);
    assert.equal(creator.vertexPayments.length, 1);
    const receipts = await sql`
      select legacy_sanity_id from migration.source_documents
      where document_type = 'creatorPayout' and payload->>'referralId' = ${state.creator._id}
        and not tombstoned
    `;
    assert.equal(receipts.length, 1);
    const ledger = await sql`
      select amount_subunits from commerce.referral_ledger
      where legacy_sanity_id = ${receipts[0].legacy_sanity_id}
    `;
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0].amount_subunits), 200);
    return {count, bytes: size.bytes, first, second, errors, payments: creator.vertexPayments.length};
  } finally {
    fixture.setRequestHook(null);
    if (previousReporter === undefined) delete globalThis[monitor];
    else globalThis[monitor] = previousReporter;
    await sql`
      update migration.source_documents set tombstoned = true
      where legacy_sanity_id like ${`${prefix}%`}
    `;
  }
};

export const checkPayoutPackageScale = async ({sql, seed, origin, post}) => {
  const state = await seed('dodo');
  const prefix = `package.${state.key}.scale.`;
  const count = 150;
  await sql`
    insert into migration.source_documents (
      legacy_sanity_id, document_type, source_revision, source_hash, payload
    )
    select ${prefix} || index, 'package', 'scale', repeat('c', 64),
      jsonb_build_object('_id', ${prefix} || index, '_type', 'package', '_rev', 'scale',
        'title', 'Scale package ' || lpad(index::text, 4, '0'), 'order', ${count} - index,
        'description', repeat('x', 3000))
    from generate_series(1, ${count}) as packages(index)
  `;
  const userId = crypto.randomUUID();
  await sql`insert into auth.users(id, email) values (${userId}::uuid, ${`${state.key}@example.invalid`})`;
  await sql`insert into public.profiles(user_id) values (${userId}::uuid)`;
  await sql`insert into accounts.account_roles(user_id, role) values (${userId}::uuid, 'creator')`;
  await sql`
    insert into accounts.creator_profiles(user_id, referral_code, legacy_sanity_id)
    values (${userId}::uuid, ${state.key}, ${state.creator._id})
  `;
  const {createReferralSessionCookie} = await import('../../src/server/api/ref/auth.js');
  const cookie = createReferralSessionCookie({
    referralId: state.creator._id, code: state.key, authBackend: 'supabase', sessionVersion: 1,
  });
  const payout = {
    referralId: state.creator._id, packageType: 'vertex', amount: 2,
    payoutId: `transfer-${state.key}`, paidOn: '2026-11-08T10:00:00.000Z',
  };
  try {
    const results = [];
    const calls = [];
    for (const action of ['payouts', 'syncPayouts', 'updatePayments']) {
      let response;
      if (action === 'payouts') {
        const result = await fetch(`${origin}/api/ref/payouts`, {
          headers: {cookie: `${cookie.name}=${cookie.value}`},
        });
        response = {status: result.status, body: await result.json()};
      } else {
        response = await post(`/api/ref/${action}`, action === 'syncPayouts'
          ? {referralId: state.creator._id} : payout, {'x-admin-key': 'fixture-admin'});
      }
      calls.push({action, ...response});
    }
    assert.deepEqual(calls.filter(call => call.status !== 200).map(({action, status, body}) =>
      ({action, status, error: body.error})), []);
    for (const response of calls) {
      assert.equal(response.body.earnings.total, 5.5);
      const packages = response.body.packageBreakdown.filter(row => row.title.startsWith('Scale package '));
      assert.equal(packages.length, count);
      assert.equal(packages[0].title, 'Scale package 0150');
      assert.equal(packages.at(-1).title, 'Scale package 0001');
      results.push({action: response.action, count: packages.length, earnings: response.body.earnings.total});
    }
    return {count, results};
  } finally {
    await sql`
      update migration.source_documents set tombstoned = true
      where legacy_sanity_id like ${`${prefix}%`}
    `;
  }
};

import assert from 'node:assert/strict';
export const checkPayoutCronScale = async ({sql, seed, documents, fixture, origin, post, mode}) => {
  const state = await seed('dodo');
  const count = ['volume', 'read-failure'].includes(mode) ? 40 : 3;
  const prefix = `referral.${state.key}.scale.`;
  const failedId = `${prefix}0002`;
  const monitor = Symbol.for('roo.reportServerError');
  const previousReporter = globalThis[monitor];
  const errors = [];
  let tombstoned = false;
  let failedRead = false;
  try {
    await sql`
      insert into migration.source_documents (
        legacy_sanity_id, document_type, source_revision, source_hash, payload
      )
      select ${prefix} || lpad(index::text, 4, '0'), 'referral', 'scale', repeat('b', 64),
        jsonb_build_object(
          '_id', ${prefix} || lpad(index::text, 4, '0'), '_type', 'referral', '_rev', 'scale',
          'name', 'Fixture creator', 'slug', jsonb_build_object('current', ${state.key} || '-' || index),
          'notes', repeat('x', case when ${mode} = 'oversized' and index = 2 then 260000
            when ${['volume', 'read-failure'].includes(mode)} then 12000 else 1 end)
        )
      from generate_series(1, ${count}) as creators(index)
    `;
    globalThis[monitor] = (label, error, metadata) => errors.push({label, code: error.code, referralId: metadata.referralId});
    if (mode === 'missing') fixture.setRequestHook(async (phase, request) => {
      if (tombstoned || phase !== 'after' || !request.path.endsWith('/roo_commerce_canonical_manifest_for_types')) return;
      if (!request.response.some(row => row.id === failedId && !row.tombstoned)) return;
      tombstoned = true;
      await sql`update migration.source_documents set tombstoned = true where legacy_sanity_id = ${failedId}`;
    });
    if (mode === 'read-failure') fixture.setRequestHook((phase, request) => {
      if (phase === 'before' && request.path.endsWith('/roo_fetch_shadow_documents_targeted') &&
        request.body.p_ids.includes(`${prefix}0040`) && !request.body.p_ids.includes(`${prefix}0001`) && !failedRead) {
        failedRead = true;
        throw new Error('Synthetic referral read failure');
      }
    });
    const cron = async (expectUpdates = true) => {
      const errorStart = errors.length;
      const response = await fetch(`${origin}/api/ref/cronSyncAll`, {
        headers: {authorization: 'Bearer fixture'},
      });
      const body = await response.json();
      if (mode === 'missing') assert.equal(tombstoned, true, 'manifest hook did not fire');
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(new Set(body.results.map(row => row.id)).size, body.total);
      const rows = body.results.filter(row => row.id.startsWith(prefix));
      assert.equal(rows.length, count);
      if (['volume', 'read-failure'].includes(mode)) {
        assert.equal(body.complete, true);
        assert.ok(rows.every(row => !row.pending && (mode === 'read-failure' || row.updated === expectUpdates)));
        assert.equal(errors.length, errorStart);
      } else {
        const failed = rows.find(row => row.id === failedId);
        const code = mode === 'oversized' ? 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED' : 'SHADOW_DOCUMENT_MISSING';
        assert.equal(failed.pending, true);
        assert.equal(failed.errorCode, code);
        if (mode === 'oversized') assert.ok(failed.bytes > 256000);
        assert.equal(body.complete, false);
        assert.ok(rows.filter(row => row.id !== failedId).every(row => !row.pending && row.updated));
        assert.deepEqual(errors.slice(errorStart), [{label: 'Referral cron batch failed', code, referralId: failedId}]);
      }
      return {total: body.total, synced: body.synced, ...(mode === 'read-failure' ? {rows} : {})};
    };
    let first;
    if (mode === 'read-failure') {
      const errorStart = errors.length;
      const response = await fetch(`${origin}/api/ref/cronSyncAll`, {headers: {authorization: 'Bearer fixture'}});
      const body = await response.json();
      assert.deepEqual([failedRead, response.status, body.ok, body.complete], [true, 500, false, false]);
      assert.equal(body.results.length, body.total);
      assert.equal(new Set(body.results.map(row => row.id)).size, body.total);
      const rows = body.results.filter(row => row.id.startsWith(prefix));
      assert.equal(rows.length, count);
      assert.equal(rows.find(row => row.id === `${prefix}0001`).updated, true);
      const last = rows.find(row => row.id === `${prefix}0040`);
      assert.deepEqual([last.pending, last.errorCode], [true, 'FIXTURE_PROXY_ERROR']);
      assert.ok(rows.every(row => row.updated === true || (row.pending === true && row.errorCode === 'FIXTURE_PROXY_ERROR')));
      assert.deepEqual(errors.slice(errorStart), [{label: 'Referral cron sync failed', code: 'FIXTURE_PROXY_ERROR', referralId: undefined}]);
      fixture.setRequestHook(null);
      const second = await cron();
      for (const row of rows) {
        assert.equal(second.rows.find(result => result.id === row.id).updated, Boolean(row.pending));
        const creator = await documents.getDocument(row.id);
        assert.deepEqual([creator.earnedTotal, creator.paidTotal, creator.owedTotal], [0, 0, 0]);
      }
      const [payouts] = await sql`select count(*)::int as count from migration.source_documents where document_type = 'creatorPayout' and payload->>'referralId' like ${`${prefix}%`}`;
      assert.equal(payouts.count, 0);
      first = {total: body.total, synced: body.synced};
    } else first = await cron();
    if (mode === 'volume') {
      const body = {
        referralId: state.creator._id, packageType: 'vertex', amount: 2,
        payoutId: `transfer-${state.key}`, paidOn: '2026-11-08T10:00:00.000Z',
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await post('/api/ref/updatePayments', body, {'x-admin-key': 'fixture-admin'});
        assert.equal(response.status, 200, JSON.stringify(response));
      }
      const second = await cron(false);
      assert.equal(second.synced, 0);
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
    }
    return {count, first, errors};
  } finally {
    fixture.setRequestHook(null);
    if (previousReporter === undefined) delete globalThis[monitor];
    else globalThis[monitor] = previousReporter;
    await sql`update migration.source_documents set tombstoned = true where legacy_sanity_id like ${`${prefix}%`}`;
  }
};

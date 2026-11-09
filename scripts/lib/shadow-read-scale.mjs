import assert from 'node:assert/strict';

const cap = 250 * 1024;
const insert = async (sql, documents) => {
  for (const document of documents) await sql`
    insert into migration.source_documents
      (legacy_sanity_id, document_type, source_revision, source_hash, payload)
    values (${document._id}, ${document._type}, 'scale', repeat('d', 64), ${sql.json(document)})
  `;
};
const retire = async (sql, ids) => sql`
  update migration.source_documents set tombstoned = true where legacy_sanity_id = any(${ids})
`;

export const checkGroupReadScale = async ({sql, seed, commerce, fixture, reader}) => {
  const state = await seed('dodo');
  const type = ['booking-settings', 'cms'].includes(reader) ? 'package' : reader === 'payment' ? 'paymentRecord' : 'booking';
  const email = `${state.key}@example.invalid`;
  const documents = Array.from({length: 5}, (_, index) => ({
    _id: `${type}.${reader === 'booking-email' ? '000-' : ''}${state.key}.group.${index}`, _type: type, _rev: 'scale',
    notes: 'x'.repeat(index === 2 ? 260000 : 90000), email, payerEmail: email,
    status: reader === 'payment' ? 'started' : 'captured',
    provider: 'dodo', backendOwner: 'supabase', cutoverGeneration: 0,
    updatedAt: '2026-11-08T10:00:00.000Z', nextRecoveryAt: '',
    emailDispatchStatus: 'failed', emailDispatchNextAttemptAt: '',
    title: `Group package ${index}`, packageTitle: state.packageDoc.title,
    startTimeUTC: new Date(Date.UTC(2035, 0, 1, 0, Number(state.key.split('-').at(-1)) * 5 + index)).toISOString(),
    localTimeZone: "UTC", currency: "USD",
    discord: "fixture", specs: "fixture computer", mainGame: "fixture", netAmount: 54.95,
  }));
  const monitor = Symbol.for('roo.reportServerError');
  const previous = globalThis[monitor];
  const errors = [];
  globalThis[monitor] = (label, error) => errors.push({label, code: error.code});
  const extraIds = [];
  try {
    await insert(sql, documents);
    if (["payment", "booking-email"].includes(reader)) await sql`select public.roo_project_operational_shadow()`;
    if (reader === 'booking-email') await sql`
      update commerce.email_dispatches dispatch set updated_at = '1900-01-01'
      from commerce.bookings booking
      where dispatch.booking_id = booking.id and booking.legacy_sanity_id = any(${documents.map(document => document._id)})
    `;
    let found;
    if (reader === 'cms') {
      const {listContentDocuments} = await import('../../src/server/cms/documents.js');
      await assert.rejects(listContentDocuments(fixture.client, 'package'),
        {code: 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'});
    } else if (reader === 'download') {
      const {findPaidBookingsByEmail} = await import('../../src/server/downloads/downloadAccess.js');
      await assert.rejects(findPaidBookingsByEmail({client: commerce, email}),
        {code: 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'});
    } else if (reader === 'booking-settings') {
      const settings = {_id: `bookingSettings.${state.key}`, _type: 'bookingSettings',
        packageDateSlots: documents.map(document => ({package: {_ref: document._id}}))};
      extraIds.push(settings._id);
      await insert(sql, [settings]);
      await assert.rejects(commerce.fetch(`*[_id == $id && _type == "bookingSettings"][0]{
        packageDateSlots[]{package->{_id,title}}
      }`, {id: settings._id}), {code: 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'});
    } else if (reader === 'booking-email') {
      const {reconcileBookingEmailDispatches} = await import('../../src/server/api/ref/bookingEmails.js');
      const result = await reconcileBookingEmailDispatches({client: commerce, limit: 20});
      assert.ok(result.scanned >= 4);
      assert.ok(result.unavailable.some(item => item.id === documents[2]._id &&
        item.code === 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'));
      for (const document of documents.filter((_, index) => index !== 2)) {
        const booking = await commerce.getDocument(document._id);
        assert.equal(booking.emailDispatchStatus, 'sent');
      }
    } else {
      found = await commerce.fetch(`*[_type == $type && coalesce(refundRequiresBookingSync, false) == false
        && nextRecoveryAt <= $now && status in $statuses]`, {type, now: '2026-11-08T12:00:00Z',
        statuses: ['started'], dodoEnabled: true, backend: 'supabase'});
    }
    const ids = (found || []).map(document => document._id).filter(id => id.startsWith(`${type}.${state.key}.group.`));
    if (reader === 'payment') {
      assert.deepEqual(ids.sort(), documents.filter((_, index) => index !== 2).map(document => document._id).sort());
    }
    assert.ok(errors.some(error => error.code === 'COMMERCE_PAYLOAD_BUDGET_EXCEEDED'));
    return {reader, returned: ids.length, errors};
  } finally {
    if (previous === undefined) delete globalThis[monitor]; else globalThis[monitor] = previous;
    await retire(sql, [...documents.map(document => document._id), ...extraIds]);
  }
};

export const checkMissingRead = async ({sql, seed, commerce, fixture, origin}) => {
  const state = await seed('dodo');
  const missing = state.creator._id;
  let vanished = false;
  fixture.setRequestHook(async (phase, request) => {
    if (vanished || phase !== 'after' || !request.path.endsWith('/roo_fetch_shadow_document_sizes')) return;
    if (!request.response.some(row => row._id === missing)) return;
    vanished = true;
    await retire(sql, [missing]);
  });
  try {
    const response = await fetch(`${origin}/api/ref/cronSyncAll`, {headers: {authorization: 'Bearer fixture'}});
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(vanished, true);
    assert.equal(body.complete, false);
    assert.ok(body.results.some(row => row.id === missing && row.pending && row.errorCode === 'SHADOW_DOCUMENTS_MISSING'));
    assert.ok(body.results.some(row => row.id !== missing && !row.pending));
    await sql`update migration.source_documents set tombstoned = false where legacy_sanity_id = ${missing}`;
    fixture.setRequestHook(null);
    const retry = await fetch(`${origin}/api/ref/cronSyncAll`, {headers: {authorization: 'Bearer fixture'}});
    const retried = await retry.json();
    assert.ok(retried.results.some(row => row.id === missing && !row.pending));
    await commerce.getDocument(missing);
    return {pending: missing, retryComplete: retried.complete};
  } finally {
    fixture.setRequestHook(null);
    await sql`update migration.source_documents set tombstoned = false where legacy_sanity_id = ${missing}`;
  }
};

export const checkRecoveryPastOversized = async ({sql, seed, commerce}) => {
  const state = await seed('dodo');
  const prefix = `paymentRecord.${state.key}.starvation.`;
  const documents = Array.from({length: 52}, (_, index) => ({
    _id: `${prefix}${String(index).padStart(3, '0')}`, _type: 'paymentRecord', _rev: 'scale',
    status: 'started', provider: 'dodo', backendOwner: 'supabase', cutoverGeneration: 0,
    updatedAt: '2026-11-08T10:00:00.000Z', nextRecoveryAt: '',
    notes: 'x'.repeat(index < 51 ? 260000 : 10),
  }));
  await insert(sql, documents);
  await sql`select public.roo_project_operational_shadow()`;
  const monitor = Symbol.for('roo.reportServerError');
  const previous = globalThis[monitor];
  const errors = [];
  globalThis[monitor] = (label, error) => errors.push({label, code: error.code});
  try {
    const found = await commerce.fetch(`*[_type == $type && coalesce(refundRequiresBookingSync, false) == false
      && nextRecoveryAt <= $now && status in $statuses]`, {
      type: 'paymentRecord', now: '2026-11-08T12:00:00Z', statuses: ['started'],
      dodoEnabled: true, backend: 'supabase',
    });
    assert.ok(found.some(document => document._id === documents.at(-1)._id));
    assert.ok(errors.filter(error => error.label === 'Recovery payment document unavailable').length >= 51);
    return {oversized: 51, reached: documents.at(-1)._id};
  } finally {
    if (previous === undefined) delete globalThis[monitor]; else globalThis[monitor] = previous;
    await retire(sql, documents.map(document => document._id));
  }
};

export const checkNearCapRead = async ({sql, seed, commerce}) => {
  const state = await seed('dodo');
  const document = {_id: `package.${state.key}.near-cap`, _type: 'package', _rev: 'scale',
    nested: {spaces: 'keep these spaces', escaped: '" \\ \n\t', unicode: '☕'}, padding: ''};
  document.padding = 'x'.repeat(cap - 1 - Buffer.byteLength(JSON.stringify([document])));
  await insert(sql, [document]);
  try {
    const [row] = await sql`
      select octet_length(payload::text) as spaced from migration.source_documents where legacy_sanity_id = ${document._id}
    `;
    assert.ok(row.spaced > cap);
    const [sizes] = await sql`
      select public.roo_fetch_shadow_document_sizes(array['package'], null, 500, array[${document._id}]) as rows
    `;
    assert.ok(sizes.rows[0].bytes > 0);
    const rows = await commerce.dataset({documentTypes: ['package'], ids: [document._id, 'package.absent']});
    assert.deepEqual(rows, [document]);
    const outcomes = [];
    for await (const outcome of commerce.documentBatches({documentTypes: ['package'], ids: [document._id, 'package.absent']})) {
      outcomes.push(outcome);
    }
    assert.deepEqual(outcomes.map(({id, status}) => ({id, status})), [
      {id: document._id, status: 'document'}, {id: 'package.absent', status: 'missing'},
    ]);
    return {compact: Buffer.byteLength(JSON.stringify(rows)), spaced: row.spaced};
  } finally { await retire(sql, [document._id]); }
};

export const checkCronResume = async ({sql, seed}) => {
  const state = await seed('dodo');
  const documents = Array.from({length: 5}, (_, index) => ({_id: `referral.${state.key}.resume.${index}`,
    _type: 'referral', _rev: 'scale', name: 'Resume creator', slug: {current: `${state.key}-${index}`}}));
  await insert(sql, documents);
  await sql`select public.roo_referral_sync_cursor('')`;
  try {
    const {createCronSyncAll} = await import('../../src/server/api/ref/cronSyncAll.js');
    let time = 0;
    const handler = createCronSyncAll({now: () => ++time, budgetMs: 1});
    const visited = new Set();
    let runs = 0;
    const [{count}] = await sql`select count(*)::integer as count from migration.source_documents
      where document_type = 'referral' and not tombstoned`;
    while (visited.size < documents.length && runs < count + 1) {
      let status, body;
      await handler({method: 'GET', headers: {authorization: 'Bearer fixture'}}, {
        status(value) {status = value; return this;}, json(value) {body = value; return this;},
      });
      assert.equal(status, 200, JSON.stringify(body));
      for (const row of body.results) if (documents.some(document => document._id === row.id)) visited.add(row.id);
      runs++;
    }
    assert.equal(visited.size, documents.length);
    assert.ok(runs <= count + 1);
    return {creators: documents.length, runs, bound: count + 1};
  } finally {
    await retire(sql, documents.map(document => document._id));
    await sql`select public.roo_referral_sync_cursor('')`;
  }
};

export const checkCronErrorBudget = async ({sql, seed}) => {
  const state = await seed('dodo');
  const prefix = `referral.${state.key}.error-budget.`;
  const documents = Array.from({length: 3}, (_, index) => ({
    _id: `${prefix}${index}`, _type: 'referral', _rev: 'scale', notes: 'x'.repeat(260000),
  }));
  await insert(sql, documents);
  await sql`select public.roo_referral_sync_cursor(${prefix})`;
  try {
    const {createCronSyncAll} = await import('../../src/server/api/ref/cronSyncAll.js');
    let time = 0;
    const handler = createCronSyncAll({now: () => ++time, budgetMs: 1});
    let status, body;
    await handler({method: 'GET', headers: {authorization: 'Bearer fixture'}}, {
      status(value) {status = value; return this;}, json(value) {body = value; return this;},
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.complete, false);
    assert.deepEqual(body.results.map(row => row.id), [documents[0]._id]);
    const [cursor] = await sql`select public.roo_referral_sync_cursor() as id`;
    assert.equal(cursor.id, documents[0]._id);
    return {processed: body.results.length, cursor: cursor.id};
  } finally {
    await retire(sql, documents.map(document => document._id));
    await sql`select public.roo_referral_sync_cursor('')`;
  }
};

export const checkBatchBisection = async ({sql, seed, commerce, fixture}) => {
  const state = await seed('dodo');
  const documents = Array.from({length: 3}, (_, index) => ({
    _id: `package.${state.key}.bisect.${index}`, _type: 'package', _rev: 'scale',
    padding: 'x'.repeat(1000),
  }));
  await insert(sql, documents);
  let grew = false;
  fixture.setRequestHook(async (phase, request) => {
    if (grew || phase !== 'after' || !request.path.endsWith('/roo_fetch_shadow_document_sizes')) return;
    if (!request.response.some(row => row._id === documents[0]._id)) return;
    assert.ok(request.response.reduce((total, row) => total + row.bytes + 1, 1) < cap * 0.8);
    grew = true;
    for (const document of documents) await sql`
      update migration.source_documents set payload = jsonb_set(payload, '{padding}', to_jsonb(repeat('x', 90000)))
      where legacy_sanity_id = ${document._id}
    `;
  });
  try {
    const outcomes = [];
    for await (const outcome of commerce.documentBatches({documentTypes: ['package'], ids: documents.map(d => d._id)})) {
      outcomes.push(outcome);
    }
    assert.equal(grew, true);
    assert.deepEqual(outcomes.map(outcome => outcome.status), ['document', 'document', 'document']);
    assert.deepEqual(outcomes.map(outcome => outcome.id), documents.map(document => document._id));
    assert.ok(outcomes.every(outcome => outcome.document.padding.length === 90000));
    return {returned: outcomes.length};
  } finally {
    fixture.setRequestHook(null);
    await retire(sql, documents.map(document => document._id));
  }
};

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
    _id: `${type}.${state.key}.group.${index}`, _type: type, _rev: 'scale',
    notes: 'x'.repeat(index === 2 ? 260000 : 90000), email, payerEmail: email,
    status: reader === 'payment' ? 'started' : 'captured',
    provider: 'dodo', backendOwner: 'supabase', cutoverGeneration: 0,
    updatedAt: '2026-11-08T10:00:00.000Z', nextRecoveryAt: '',
    emailDispatchStatus: 'failed', emailDispatchNextAttemptAt: '',
    title: `Group package ${index}`, packageTitle: state.packageDoc.title,
    startTimeUTC: "2026-12-01T10:00:00.000Z", localTimeZone: "UTC", currency: "USD",
    discord: "fixture", specs: "fixture computer", mainGame: "fixture", netAmount: 54.95,
  }));
  await insert(sql, documents);
  if (["payment", "booking-email"].includes(reader)) await sql`select public.roo_project_operational_shadow()`;
  const monitor = Symbol.for('roo.reportServerError');
  const previous = globalThis[monitor];
  const errors = [];
  globalThis[monitor] = (label, error) => errors.push({label, code: error.code});
  const extraIds = [];
  try {
    let found;
    if (reader === 'cms') {
      const {listContentDocuments} = await import('../../src/server/cms/documents.js');
      found = (await listContentDocuments(fixture.client, 'package')).documents;
    } else if (reader === 'download') {
      const {findPaidBookingsByEmail} = await import('../../src/server/downloads/downloadAccess.js');
      found = await findPaidBookingsByEmail({client: commerce, email});
    } else if (reader === 'booking-settings') {
      const settings = {_id: `bookingSettings.${state.key}`, _type: 'bookingSettings',
        packageDateSlots: documents.map(document => ({package: {_ref: document._id}}))};
      extraIds.push(settings._id);
      await insert(sql, [settings]);
      found = (await commerce.fetch(`*[_id == $id && _type == "bookingSettings"][0]{
        packageDateSlots[]{package->{_id,title}}
      }`, {id: settings._id})).packageDateSlots.map(row => row.package).filter(Boolean);
    } else if (reader === 'booking-email') {
      const {reconcileBookingEmailDispatches} = await import('../../src/server/api/ref/bookingEmails.js');
      const result = await reconcileBookingEmailDispatches({client: commerce, limit: 20});
      assert.equal(result.scanned, 4);
      assert.equal(result.sent, 4);
      assert.equal(result.pending, 0);
      found = await commerce.fetch('*[_type == "booking" && _id in $ids]',
        {ids: documents.map(document => document._id)});
    } else {
      found = await commerce.fetch(`*[_type == $type && coalesce(refundRequiresBookingSync, false) == false
        && nextRecoveryAt <= $now && status in $statuses]`, {type, now: '2026-11-08T12:00:00Z',
        statuses: ['started'], dodoEnabled: true, backend: 'supabase'});
    }
    const ids = found.map(document => document._id).filter(id => id.startsWith(`${type}.${state.key}.group.`));
    assert.deepEqual(ids.sort(), documents.filter((_, index) => index !== 2).map(document => document._id).sort());
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
    assert.equal(sizes.rows[0].bytes, Buffer.byteLength(JSON.stringify(document)));
    const rows = await commerce.dataset({documentTypes: ['package'], ids: [document._id, 'package.absent']});
    assert.deepEqual(rows, [document]);
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

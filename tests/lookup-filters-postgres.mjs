import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluate, parse } from 'groq-js';
import { createSweepPostgresFixture, root } from '../scripts/lib/sweep-postgres-fixture.mjs';
import { createSupabaseDocumentClient, inferShadowScope } from '../src/server/supabase/documentClient.js';

assert.ok(process.env.POSTGREST_14_BIN, 'POSTGREST_14_BIN must point to PostgREST 14.5');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(process.env.POSTGREST_14_BIN)).digest('hex'), '39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a');

const MIGRATION_SUFFIX = '_match_lookup_filters_exactly.sql';
const LIMIT_500_DECOYS = 500;
const TABLE_CHUNK = 400;
const NOW = '2026-11-16T00:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const READ = 'roo_fetch_shadow_documents_targeted';
const GROQ_OPERATORS = { eq: '==', lt: '<', lte: '<=', gt: '>', gte: '>=' };

const byId = (result, realId) => result?._id === realId;
const inList = (result, realId) => Array.isArray(result) && result.some(row => row === realId || row?._id === realId);

const callerLookups = [
  { caller: 'validateReferral.js and pricing.js referral by code', type: 'referral',
    decoy: { registrationStatus: 'active' }, real: { registrationStatus: 'active', slug: { _type: 'slug', current: 'realcode' }, currentDiscountPercent: 10 },
    query: '*[_type == "referral" && registrationStatus != "pending_email" && slug.current == $code][0]{ "code": slug.current, currentDiscountPercent }',
    params: { code: 'realcode' }, found: result => result?.code === 'realcode' },
  { caller: 'forgot.js referral by creator email', type: 'referral',
    decoy: { registrationStatus: 'active' }, real: { registrationStatus: 'active', creatorEmail: 'creator@example.invalid' },
    query: '*[_type == "referral" && registrationStatus != "pending_email" && creatorEmail == $email][0]', params: { email: 'creator@example.invalid' } },
  { caller: 'reset.js referral by reset token', type: 'referral',
    decoy: { registrationStatus: 'active' }, real: { registrationStatus: 'active', resetTokenHash: 'h1', resetTokenExpiresAt: LATER },
    query: '*[_type == "referral" && registrationStatus != "pending_email" && resetTokenHash == $tokenHash && resetTokenExpiresAt > $now][0]{ _id }',
    params: { tokenHash: 'h1', now: NOW } },
  { caller: 'verifyRegistration.js referral by verification token', type: 'referral',
    decoy: { registrationStatus: 'pending_email' },
    real: { registrationStatus: 'pending_email', registrationVerificationTokenHash: 'v1', registrationVerificationExpiresAt: LATER },
    query: '*[ _type == "referral" && registrationStatus == "pending_email" && registrationVerificationTokenHash == $tokenHash && registrationVerificationExpiresAt > $now ][0]',
    params: { tokenHash: 'v1', now: NOW } },
  { caller: 'bookingEmails.js recovery case by booking', type: 'bookingRecoveryCase',
    decoy: {}, real: { bookingId: 'booking.real' },
    query: '*[_type == "bookingRecoveryCase" && bookingId == $bookingId][0]{_id,_rev}', params: { bookingId: 'booking.real' } },
  { caller: 'paymentRecord.js record by provider payment id', type: 'paymentRecord',
    decoy: { provider: 'dodo' }, real: { provider: 'dodo', providerPaymentId: 'pay_real' },
    query: '*[_type == $type && provider == $provider && providerPaymentId == $providerPaymentId][0]',
    params: { type: 'paymentRecord', provider: 'dodo', providerPaymentId: 'pay_real' } },
  { caller: 'paymentRecord.js record by provider order id', type: 'paymentRecord',
    decoy: { provider: 'dodo' }, real: { provider: 'dodo', providerOrderId: 'cks_real' },
    query: '*[_type == $type && provider == $provider && providerOrderId == $providerOrderId][0]',
    params: { type: 'paymentRecord', provider: 'dodo', providerOrderId: 'cks_real' } },
  { caller: 'flow.js webhook receipt by event id', type: 'paymentWebhookReceipt',
    decoy: { provider: 'dodo' }, real: { provider: 'dodo', eventId: 'evt_real' },
    query: '*[_type == $type && provider == $provider && eventId == $eventId][0]',
    params: { type: 'paymentWebhookReceipt', provider: 'dodo', eventId: 'evt_real' } },
  { caller: 'flow.js booking by Razorpay payment id', type: 'booking',
    decoy: {}, real: { razorpayPaymentId: 'rzp_real' },
    query: '*[_type == "booking" && razorpayPaymentId == $razorpayPaymentId][0]', params: { razorpayPaymentId: 'rzp_real' } },
  { caller: 'control: flow.js booking by PayPal order id on the indexed path', type: 'booking',
    decoy: {}, real: { paypalOrderId: 'pp_real' },
    query: '*[_type == "booking" && paypalOrderId == $paypalOrderId][0]', params: { paypalOrderId: 'pp_real' } },
  { caller: 'createBooking.js booking by Dodo payment and session', type: 'booking',
    decoy: { paymentProvider: 'dodo' }, real: { paymentProvider: 'dodo', dodoPaymentId: 'pay_b', dodoCheckoutSessionId: 'cks_b' },
    query: '*[_type == "booking" && paymentProvider == "dodo" && dodoPaymentId == $dodoPaymentId && dodoCheckoutSessionId == $dodoCheckoutSessionId][0]{_id}',
    params: { dodoPaymentId: 'pay_b', dodoCheckoutSessionId: 'cks_b' } },
  { caller: 'getUpgradeInfo.js and orderResolver.js booking by Dodo payment id', type: 'booking',
    decoy: {}, real: { dodoPaymentId: 'pay_order' },
    query: '*[_type == "booking" && dodoPaymentId == $id][0]', params: { id: 'pay_order' } },
  { caller: 'orderResolver.js payment record by booking', type: 'paymentRecord',
    decoy: {}, real: { bookingId: 'booking.order' },
    query: '*[_type == "paymentRecord" && bookingId == $id][0]', params: { id: 'booking.order' } },
  { caller: 'createBooking.js PayPal record by order id', type: 'paymentRecord',
    decoy: { provider: 'paypal' }, real: { provider: 'paypal', providerOrderId: 'pp_ord' },
    query: '*[_type == $type && provider == "paypal" && providerOrderId == $providerOrderId][0]',
    params: { type: 'paymentRecord', providerOrderId: 'pp_ord' } },
  { caller: 'pricing.js payment records by booking', type: 'paymentRecord', decoys: LIMIT_500_DECOYS,
    decoy: {}, real: { bookingId: 'booking.credit' },
    query: '*[_type == "paymentRecord" && bookingId == $bookingId]{...}', params: { bookingId: 'booking.credit' }, found: inList },
  { caller: 'holdSlot.js bookings at a start time', type: 'booking', decoys: LIMIT_500_DECOYS,
    decoy: {}, real: { startTimeUTC: '2099-01-05T04:30:00.000Z', status: 'captured' },
    query: '*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status,originalOrderId}',
    params: { startTimeUTC: '2099-01-05T04:30:00.000Z' }, found: inList },
  { caller: 'rateLimit.js expired buckets', type: 'rateLimitBucket', decoys: LIMIT_500_DECOYS,
    decoy: {}, real: { resetAt: '2026-01-01T00:00:00.000Z' },
    query: '*[_type == "rateLimitBucket" && resetAt < $now][0...500]._id', params: { now: NOW }, found: inList },
  { caller: 'control: couponReservations.js coupon by code', type: 'coupon',
    decoy: {}, real: { code: 'SAVE10' },
    query: '*[_type == "coupon" && lower(code) == $code][0]{ _id,_rev,code,isActive,timesUsed,activeReservations,maxUses }', params: { code: 'save10' } },
  { caller: 'control: flow.js upgrade payment by original order', type: 'paymentRecord',
    decoy: { status: 'started' }, real: { status: 'started', bookingPayload: { originalOrderId: 'booking.root' } },
    query: '*[_type == "paymentRecord" && bookingPayload.originalOrderId in $ids && status in $statuses][0]{_id}',
    params: { ids: ['booking.root'], statuses: ['started'] } },
];

const referralByCode = '*[_type == "referral" && registrationStatus != "pending_email" && slug.current == $code][0]{ _id, slug, currentCommissionPercent, currentDiscountPercent }';
const referralById = '*[_type == "referral" && registrationStatus != "pending_email" && _id == $id][0]{ _id, slug, currentCommissionPercent, currentDiscountPercent }';
const realSlug = { _type: 'slug', current: 'realcode' };
const slugDecoys = [['a1-slug-missing', {}], ['a2-slug-null', { slug: null }], ['a3-slug-empty-object', { slug: {} }],
  ['a4-current-null', { slug: { current: null } }], ['a5-current-empty', { slug: { current: '' } }], ['a6-slug-string', { slug: 'realcode' }]];
const referralPair = [
  { name: 'by code, the real referral has no registrationStatus', real: { slug: realSlug }, query: referralByCode, expected: true },
  { name: 'by code, the real referral is active', real: { registrationStatus: 'active', slug: realSlug }, query: referralByCode, expected: true },
  { name: 'by code, the only referral with the code is pending_email', real: { registrationStatus: 'pending_email', slug: realSlug }, query: referralByCode, expected: false },
  { name: 'by id, the real referral has no registrationStatus', real: { slug: realSlug }, query: referralById, expected: true },
  { name: 'by id, a referral without slug.current or registrationStatus', real: {}, query: referralById, expected: true },
];

const callerLookup = caller => callerLookups.find(lookup => lookup.caller === caller);
const resetLink = { resetTokenHash: 'h1', resetTokenExpiresAt: LATER };
const confirmationLink = { registrationVerificationTokenHash: 'v1', registrationVerificationExpiresAt: LATER };
const dodoIds = { dodoPaymentId: 'pay_b', dodoCheckoutSessionId: 'cks_b' };
const unseenConditionLookups = [
  { caller: 'validateReferral.js and pricing.js referral by code', type: 'referral', query: referralByCode, params: { code: 'realcode' },
    decoy: { registrationStatus: 'pending_email', slug: realSlug }, real: { registrationStatus: 'active', slug: realSlug } },
  { ...callerLookup('forgot.js referral by creator email'),
    decoy: { registrationStatus: 'pending_email', creatorEmail: 'creator@example.invalid' },
    real: { registrationStatus: 'active', creatorEmail: 'creator@example.invalid' } },
  { ...callerLookup('reset.js referral by reset token'),
    decoy: { registrationStatus: 'pending_email', ...resetLink }, real: { registrationStatus: 'active', ...resetLink } },
  { ...callerLookup('verifyRegistration.js referral by verification token'),
    decoy: { registrationStatus: 'active', ...confirmationLink }, real: { registrationStatus: 'pending_email', ...confirmationLink } },
  { ...callerLookup('createBooking.js PayPal record by order id'),
    decoy: { provider: 'razorpay', providerOrderId: 'pp_ord' }, real: { provider: 'paypal', providerOrderId: 'pp_ord' } },
  { caller: 'createBooking.js Razorpay record by payment id', type: 'paymentRecord',
    decoy: { provider: 'paypal', providerPaymentId: 'rzp_pay' }, real: { provider: 'razorpay', providerPaymentId: 'rzp_pay' },
    query: '*[_type == $type && provider == "razorpay" && providerPaymentId == $providerPaymentId][0]',
    params: { type: 'paymentRecord', providerPaymentId: 'rzp_pay' } },
  { caller: 'createBooking.js Razorpay record by order id', type: 'paymentRecord',
    decoy: { provider: 'paypal', providerOrderId: 'rzp_ord' }, real: { provider: 'razorpay', providerOrderId: 'rzp_ord' },
    query: '*[_type == $type && provider == "razorpay" && providerOrderId == $providerOrderId][0]',
    params: { type: 'paymentRecord', providerOrderId: 'rzp_ord' } },
  { ...callerLookup('createBooking.js booking by Dodo payment and session'),
    decoy: { paymentProvider: 'paypal', ...dodoIds }, real: { paymentProvider: 'dodo', ...dodoIds } },
];

const fieldValues = [undefined, null, 'abc', 'Abc', 'ABC', '', '5', 5, 5.0, 6, -1.5, true, false, { a: 1 }, ['abc'], [], {},
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.5Z', '2026-01-02', 'ÉCOLE', 'école',
  'ΣΑΣ', 'σας', 'İstanbul', 'STRASSE', 'straße', 'ǅ', 'b'];
const filterValues = [null, 'abc', 'Abc', '', '5', 5, 6, true, false, { a: 1 }, ['abc'], '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.5Z',
  'école', 'σας', 'i̇stanbul', 'straße', 'ǆ', 'b'];
const inValues = [['abc'], ['ABC'], [null], [''], [5], ['5'], 'abc', [{ a: 1 }], [['abc']], [true], ['école', 'x'], []];
const tableGroq = { eq: 'f.g == $v', ieq: 'lower(f.g) == $v', in: 'f.g in $v', lt: 'f.g < $v', lte: 'f.g <= $v', gt: 'f.g > $v', gte: 'f.g >= $v' };
const pathShapes = ['nested', 'parentMissing', 'parentString'];

const groqMatches = async (filter, document, value) =>
  (await (await evaluate(parse(`*[${filter}]`), { dataset: [document], params: { v: value } })).get()).length > 0;

const filterGroq = ({ path: field, op }) => op === 'ieq' ? `lower(${field}) == $v` : op === 'in' ? `${field} in $v` : `${field} ${GROQ_OPERATORS[op]} $v`;

const functionState = sql => sql`select p.oid::regprocedure::text as signature, md5(p.prosrc) as source, pg_get_userbyid(p.proowner) as owner,
  p.proacl::text as acl, p.proconfig::text as settings, p.prosecdef as security_definer, p.provolatile as volatility
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname, p.proname) in (('migration', 'shadow_filter_matches'), ('public', 'roo_fetch_shadow_documents_targeted'), ('public', 'roo_fetch_public_content_documents'))
  order by 1`;

test('targeted lookups return only real matches', async t => {
  process.env.POSTGREST_BIN = process.env.POSTGREST_14_BIN;
  const migration = fs.readdirSync(path.join(root, 'supabase/migrations')).find(name => name.endsWith(MIGRATION_SUFFIX));
  const fixture = await createSweepPostgresFixture({ fullMigrationChain: true, excludedMigrations: migration ? [migration] : [] });
  const { sql } = fixture;
  const counts = { wrongLookups: 0, nonMatchingRows: 0, tableDisagreements: 0, tableNulls: 0, pathDisagreements: 0, referralPairWrong: 0, cutBeforeUnseenCondition: 0 };
  const applyFile = async file => {
    const connection = await sql.reserve();
    try { await connection.unsafe(fs.readFileSync(path.join(root, file), 'utf8')); } finally { connection.release(); }
    return functionState(sql);
  };
  const seed = (type, rows) => sql`insert into migration.source_documents ${sql(rows.map(([id, fields]) => ({
    legacy_sanity_id: id, document_type: type, source_hash: 'a'.repeat(64), payload: { _id: id, _type: type, ...fields },
    tombstoned: false, backend_owner: 'supabase' })))}`;
  const unseed = prefix => sql`delete from migration.source_documents where legacy_sanity_id like ${`${prefix}%`}`;
  const read = async (types, ids, filters, limit) => {
    const { data, error } = await fixture.client.rpc(READ, { p_document_types: types, p_ids: ids, p_filters: filters, p_limit: limit });
    assert.ifError(error);
    return data;
  };
  try {
    const before = await functionState(sql);
    const head = migration ? await applyFile(`supabase/migrations/${migration}`) : before;
    const client = createSupabaseDocumentClient({ shadowClient: fixture.client, allowLegacyFallback: false });

    await t.test('every caller finds its document behind one that lacks the filtered field', async () => {
      for (const [index, lookup] of callerLookups.entries()) {
        const prefix = `${lookup.type}.lookup${index}.`;
        const realId = `${prefix}zzz-real`;
        const decoys = Array.from({ length: lookup.decoys || 1 }, (_, decoy) => [`${prefix}aaa-${String(decoy).padStart(4, '0')}`, lookup.decoy]);
        await seed(lookup.type, [...decoys, [realId, lookup.real]]);
        try {
          const result = await client.fetch(lookup.query, lookup.params);
          if (!(lookup.found || byId)(result, realId)) {
            counts.wrongLookups += 1;
            t.diagnostic(`wrong: ${lookup.caller}`);
          }
          const scope = inferShadowScope({ query: lookup.query, params: lookup.params });
          for (const row of await read(scope.documentTypes, scope.ids.length ? scope.ids : null, scope.filters, scope.limit)) {
            for (const filter of scope.filters) {
              if (await groqMatches(filterGroq(filter), row, filter.value)) continue;
              counts.nonMatchingRows += 1;
              break;
            }
          }
        } finally { await unseed(prefix); }
      }
    });

    await t.test('a referral is found by its code and id whatever its registrationStatus field holds', async () => {
      for (const [index, pair] of referralPair.entries()) {
        const prefix = `referral.pair${index}.`;
        const realId = `${prefix}zzz-real`;
        await seed('referral', [...slugDecoys.map(([name, fields]) => [`${prefix}${name}`, { registrationStatus: 'active', ...fields }]), [realId, pair.real]]);
        try {
          const result = await client.fetch(pair.query, pair.query === referralById ? { id: realId } : { code: 'realcode' });
          if (pair.expected ? result?._id !== realId : result != null) {
            counts.referralPairWrong += 1;
            t.diagnostic(`wrong: ${pair.name}`);
          }
        } finally { await unseed(prefix); }
      }
    });

    await t.test('every caller finds its document behind one that only an unseen condition rejects', async () => {
      for (const [index, lookup] of unseenConditionLookups.entries()) {
        const prefix = `${lookup.type}.unseen${index}.`;
        const realId = `${prefix}zzz-real`;
        await seed(lookup.type, [[`${prefix}aaa-rejected`, lookup.decoy], [realId, lookup.real]]);
        try {
          if (!byId(await client.fetch(lookup.query, lookup.params), realId)) {
            counts.cutBeforeUnseenCondition += 1;
            t.diagnostic(`wrong: ${lookup.caller}`);
          }
        } finally { await unseed(prefix); }
      }
    });

    await t.test('the matcher answers what GROQ answers for every operator, value and path shape', async () => {
      const cases = [];
      for (const op of Object.keys(tableGroq)) for (const value of op === 'in' ? inValues : filterValues) for (const actual of fieldValues) for (const shape of pathShapes) {
        const document = { _id: 'x', _type: 't' };
        if (shape === 'nested') document.f = actual === undefined ? {} : { g: actual };
        if (shape === 'parentString') document.f = 'text';
        cases.push({ op, value, document });
      }
      for (let start = 0; start < cases.length; start += TABLE_CHUNK) {
        const chunk = cases.slice(start, start + TABLE_CHUNK);
        const rows = await sql`select ord, migration.shadow_filter_matches(d, f) as matched
          from jsonb_to_recordset(${chunk.map((item, ord) => ({ ord, d: item.document, f: { path: 'f.g', op: item.op, value: item.value } }))}::jsonb) as t(ord int, d jsonb, f jsonb)`;
        for (const row of rows) {
          const item = chunk[row.ord];
          if (row.matched === null) counts.tableNulls += 1;
          if ((row.matched === true) !== await groqMatches(tableGroq[item.op], item.document, item.value)) counts.tableDisagreements += 1;
        }
      }
    });

    await t.test('the indexed, general and id read paths return the same rows', async () => {
      const prefix = 'booking.agree.';
      const rows = [['a-missing', {}], ['b-null', { paypalOrderId: null }], ['c-number', { paypalOrderId: 123 }],
        ['d-string', { paypalOrderId: '123' }], ['e-match', { paypalOrderId: 'ord-agree' }], ['f-upper', { paypalOrderId: 'ORD-AGREE' }]]
        .map(([name, fields]) => [`${prefix}${name}`, fields]);
      await seed('booking', rows);
      try {
        for (const value of ['ord-agree', '123', 'ORD-AGREE']) for (const limit of [1, 10]) {
          const filters = [{ path: 'paypalOrderId', op: 'eq', value }];
          const [indexed, general, pinned] = await Promise.all([
            read(['booking'], null, filters, limit),
            read(['booking', 'bookingAgreeOther'], null, filters, limit),
            read(['booking'], rows.map(([id]) => id), filters, limit),
          ]);
          const ids = result => result.map(row => row._id).join(',');
          if (ids(indexed) !== ids(general) || ids(indexed) !== ids(pinned)) counts.pathDisagreements += 1;
        }
      } finally { await unseed(prefix); }
    });

    await t.test('the migration and its rollback each change nothing when run again', async () => {
      assert.ok(migration, `No migration named *${MIGRATION_SUFFIX}`);
      assert.notDeepEqual(head, before);
      assert.deepEqual(await applyFile(`supabase/migrations/${migration}`), head);
      assert.deepEqual(await applyFile(`supabase/rollbacks/${migration}`), before);
      assert.deepEqual(await applyFile(`supabase/rollbacks/${migration}`), before);
      assert.deepEqual(await applyFile(`supabase/migrations/${migration}`), head);
      const kept = state => state.map(row => [row.owner, row.acl, row.settings, row.security_definer, row.volatility]);
      assert.deepEqual(kept(head), kept(before));
    });

    console.log(JSON.stringify(counts));
    assert.deepEqual(counts, { wrongLookups: 0, nonMatchingRows: 0, tableDisagreements: 0, tableNulls: 0, pathDisagreements: 0, referralPairWrong: 0, cutBeforeUnseenCondition: 0 });
  } finally {
    await fixture.stop();
    fs.rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

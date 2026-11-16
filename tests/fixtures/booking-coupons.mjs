import { endOwnChannel } from '../../scripts/lib/own-channel.mjs';
import { createBookingContactFixture } from './booking-contact.mjs';

const fixture = await createBookingContactFixture({ artifactName: 'booking-coupons' });
const { runLegacyApiHandler } = await import('../../src/lib/nextApiAdapter.js');
const validations = new Map();
for (const name of ['validateCoupon', 'validateReferral']) {
  validations.set(name, (await import(`../../src/server/api/ref/${name}.js`)).default);
}
let nextDate = 0;
let unlock, lockTransaction;
const methods = {
  nextDate: () => new Date(Date.UTC(2099, 0, ++nextDate)).toISOString().slice(0, 10),
  lockCommerce: async () => {
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const release = new Promise(resolve => { unlock = resolve; });
    lockTransaction = fixture.database.sql.begin(async sql => {
      await sql`select pg_advisory_xact_lock(hashtextextended('cms-reference-integrity', 0))`;
      acquired();
      await release;
    });
    await Promise.race([ready, lockTransaction]);
  },
  waiting: async () => Number((await fixture.database.sql`select count(*) as count from pg_locks
    where locktype = 'advisory' and not granted`)[0].count),
  unlockCommerce: async () => {
    if (unlock) unlock();
    unlock = null;
    if (lockTransaction) await lockTransaction;
    lockTransaction = null;
  },
  availability: () => fixture.availability(),
  hold: () => fixture.hold(),
  post: (...args) => fixture.post(...args),
  validate: async route => {
    const url = new URL(route, 'http://127.0.0.1');
    const handler = validations.get(url.pathname.split('/').at(-1));
    const response = await runLegacyApiHandler({ request: new Request(url), handler });
    return { status: response.status, body: await response.json() };
  },
  create: doc => (doc._type === 'referral' ? fixture.content : fixture.commerce).create(doc),
  get: id => fixture.commerce.getDocument(id),
  referral: id => fixture.content.getDocument(id),
  setPrice: price => fixture.content.patch('package.fixture.1').set({ price }).commit(),
  rows: async type => (await fixture.database.sql`select payload from migration.source_documents
    where document_type = ${type} and not tombstoned order by legacy_sanity_id`).map(row => row.payload),
  webhook: (paymentId, type, id) => fixture.dodoWebhook(paymentId, type, id),
  refund: bookingId => fixture.post('/api/ref/updateBookingStatus', { bookingId, status: 'refunded' }, '', { 'x-admin-key': 'fixture-only-admin' }),
  disableLater: async id => {
    await fixture.commerce.patch(id).set({ isActive: false }).commit();
    await fixture.database.sql.begin(async sql => {
      await sql`set local session_replication_role = replica`;
      await sql`update migration.source_documents
        set payload = jsonb_set(payload, '{_updatedAt}', to_jsonb(((payload->>'autoDeactivatedAt')::timestamptz + interval '60 seconds')::text)),
          source_updated_at = (payload->>'autoDeactivatedAt')::timestamptz + interval '60 seconds'
        where legacy_sanity_id = ${id}`;
    });
  },
};
process.on('message', async ({ id, method, args = [] }) => {
  try {
    if (method === 'stop') {
      await methods.unlockCommerce();
      await fixture.stop();
      process.send({ id, value: true });
      return;
    }
    process.send({ id, value: (await methods[method](...args)) ?? null });
  } catch (error) {
    process.send({ id, error: error.stack || error.message });
  } finally {
    if (method === 'stop') endOwnChannel();
  }
});
process.once('disconnect', () => fixture.stop());
process.send({ ready: true });

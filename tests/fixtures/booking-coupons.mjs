import { endOwnChannel } from '../../scripts/lib/own-channel.mjs';
import { createBookingContactFixture } from './booking-contact.mjs';

const fixture = await createBookingContactFixture({ artifactName: 'booking-coupons' });
const { runLegacyApiHandler } = await import('../../src/lib/nextApiAdapter.js');
const validations = new Map();
for (const name of ['validateCoupon', 'validateReferral']) {
  validations.set(name, (await import(`../../src/server/api/ref/${name}.js`)).default);
}
let nextDate = 0;
const methods = {
  nextDate: () => new Date(Date.UTC(2099, 0, ++nextDate)).toISOString().slice(0, 10),
  armCouponRace: () => {
    let count = 0;
    let releaseReads, releaseFinalized;
    const bothRead = new Promise(resolve => { releaseReads = resolve; });
    const firstFinalized = new Promise(resolve => { releaseFinalized = resolve; });
    fixture.setRequestHook(async (stage, request) => {
      if (stage !== 'after') return;
      if (request.path === '/rest/v1/rpc/roo_apply_commerce_document_mutations' &&
          request.body?.p_command_id?.startsWith('booking-finalize:') && request.status === 200) {
        fixture.setRequestHook(null);
        releaseFinalized();
        return;
      }
      if (count >= 2 || request.path !== '/rest/v1/rpc/roo_fetch_shadow_documents_targeted' ||
          request.body?.p_document_types?.length !== 1 || request.body.p_document_types[0] !== 'coupon' ||
          !request.body.p_filters?.some(filter => filter.path === 'code')) return;
      const position = ++count;
      if (count === 2) releaseReads();
      await bothRead;
      if (position === 2) await firstFinalized;
    });
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
  bookingsFor: async code => (await fixture.database.sql`select payload from migration.source_documents
    where document_type = 'booking' and not tombstoned and payload->>'couponCode' = ${code}`).map(row => row.payload),
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
      await fixture.stop();
      process.send({ id, value: true });
      endOwnChannel();
      return;
    }
    process.send({ id, value: (await methods[method](...args)) ?? null });
  } catch (error) { process.send({ id, error: error.stack || error.message }); }
});
process.once('disconnect', () => fixture.stop());
process.send({ ready: true });

import bcrypt from 'bcryptjs';
import { createHmac } from 'node:crypto';
import { endOwnChannel } from '../../scripts/lib/own-channel.mjs';
import { createBookingContactFixture } from './booking-contact.mjs';

const fixture = await createBookingContactFixture({ artifactName: 'lookup-filters-browser' });
const { sql } = fixture.database;
const { runLegacyApiHandler } = await import('../../src/lib/nextApiAdapter.js');
const { createSupabaseCreatorAccount } = await import('../../src/server/supabase/accounts.js');
const handlers = new Map();
for (const name of ['reset', 'verifyRegistration', 'login', 'getUpgradeInfo']) {
  handlers.set(`/api/ref/${name}`, (await import(`../../src/server/api/ref/${name}.js`)).default);
}

await fixture.content.create({ _id: 'upgradeLink.fixture.max', _type: 'upgradeLink', title: 'Upgrade to Performance Vertex Max',
  slug: { _type: 'slug', current: 'max' }, targetPackage: { _type: 'reference', _ref: 'package.fixture.2' } });

const SESSION_SECONDS = 3600;
const passwords = new Map();
let signedIn;
let nextDate = 0;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken = (id, expiresAt) => {
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, role: 'authenticated', aud: 'authenticated', exp: expiresAt })}`;
  return `${unsigned}.${createHmac('sha256', 'fixture-only-auth').update(unsigned).digest('base64url')}`;
};
const authUser = row => ({ id: row.id, email: row.email, aud: 'authenticated', role: 'authenticated',
  email_confirmed_at: row.email_confirmed_at, created_at: row.created_at,
  app_metadata: row.raw_app_meta_data, user_metadata: row.raw_user_meta_data, identities: [] });
const storedUser = async id => (await sql`select * from auth.users where id = ${id}`)[0];
const keepPassword = (id, { password, password_hash: hash }) => {
  if (password) passwords.set(id, bcrypt.hashSync(password, 4));
  else if (hash) passwords.set(id, hash);
};
fixture.database.setAuthHandler(async request => {
  const url = new URL(request.path, fixture.database.origin);
  const id = url.pathname.split('/').at(-1);
  if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
    const { id: userId, email, app_metadata: app = {}, user_metadata: user = {} } = request.body;
    const [row] = await sql`insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
      values (${userId}, ${email}, now(), ${sql.json(app)}, ${sql.json(user)}) returning *`;
    keepPassword(userId, request.body);
    return { body: authUser(row) };
  }
  if (url.pathname.startsWith('/auth/v1/admin/users/')) {
    const row = await storedUser(id);
    if (!row) return { status: 404, body: { code: 404, error_code: 'user_not_found', msg: 'User not found' } };
    if (request.method === 'PUT') keepPassword(id, request.body);
    return { body: authUser(row) };
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const [row] = await sql`select * from auth.users where email = ${request.body.email}`;
    if (!row || !bcrypt.compareSync(String(request.body.password), passwords.get(row.id) || '')) {
      return { status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
    }
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    signedIn = row.id;
    return { body: { access_token: accessToken(row.id, expiresAt), refresh_token: `fixture-refresh-${row.id}`,
      token_type: 'bearer', expires_in: SESSION_SECONDS, expires_at: expiresAt, user: authUser(row) } };
  }
  if (url.pathname === '/auth/v1/user') return { body: authUser(await storedUser(signedIn)) };
  return { status: 404, body: { code: 404, msg: 'Unhandled fixture Auth route' } };
});

const create = doc => (doc._type === 'referral' ? fixture.content : fixture.commerce).create(doc);
const methods = {
  nextDate: () => new Date(Date.UTC(2099, 0, ++nextDate)).toISOString().slice(0, 10),
  post: async (route, body) => {
    globalThis.__rooRateLimitBuckets?.clear();
    const request = new Request(new URL(route, fixture.database.origin), { method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.database.origin }, body: JSON.stringify(body) });
    const response = await runLegacyApiHandler({ request, handler: handlers.get(route) });
    return { status: response.status, body: await response.json() };
  },
  seed: async docs => { for (const doc of docs) await create(doc); },
  remove: async (ids, emails) => {
    await sql`delete from migration.source_documents where legacy_sanity_id = any(${ids})`;
    await sql`delete from auth.users where email = any(${emails})`;
  },
  account: async id => {
    const referral = await fixture.content.getDocument(id);
    await createSupabaseCreatorAccount({ referral, passwordHash: referral.creatorPassword, sourceRevision: referral._rev });
  },
  document: id => fixture.content.getDocument(id),
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

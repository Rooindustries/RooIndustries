const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parse, evaluate } from 'groq-js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const baseline = process.argv.includes('--baseline');
const baselineModules = new Set(['bookingCommit','bookingRefunds','couponReservations','createBooking','cronSyncAll','syncPayouts','updateSplit','webhookSync','bookingEmails'].map((file)=>`src/server/api/ref/${file}.js`));
const pgMode = process.argv.includes('--postgres');
const selected = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice(11);
const artifact = path.resolve(process.env.ROO_BOOKING_SWEEP_ARTIFACT || `test-results/booking-sweep${pgMode ? '-postgres' : ''}.json`);
for (const key of Object.keys(process.env)) if (/^(SANITY|SUPABASE|NEXT_PUBLIC_|REACT_APP_|RESEND|PAYPAL|RAZORPAY|DODO|REF_|CRON|FROM_EMAIL|OWNER_EMAIL|BOOKING_OWNER)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', DATA_PRIMARY_BACKEND: 'sanity', COMMERCE_PRIMARY_BACKEND: 'sanity', COMMERCE_FAILOVER_GENERATION: '0', SANITY_PROJECT_ID: 'isolated', SANITY_DATASET: 'isolated', SANITY_WRITE_TOKEN: 'fixture', RESEND_API_KEY: 'fixture-key', FROM_EMAIL:'fixture@example.invalid', OWNER_EMAIL:'owner@example.invalid', CRON_SECRET: 'fixture-cron', SANITY_WEBHOOK_SECRET: 'fixture-webhook' });
const documents = new Map();
let revision = 0;
let beforeCommit = null;
let loseEmailCompletion = false;
let failLedgerCompletion = false;
let simulatedTime = null;
const NativeDate = Date;
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [simulatedTime ?? NativeDate.now()])); } static now() { return simulatedTime ?? NativeDate.now(); } };
const providerMessages = new Map();
let actualClient;
let pgSeed;
let sql;
let pgStarted = false;
let scratch;
let pgBin;
const evidence = { baseline, mode: pgMode ? 'actual-postgresql17-production-adapter' : 'in-memory-document-adapter', standIns: ['data-client factory injection', 'session/admin credential gate stubs', 'commerce control gate stub (generation0)' , 'local HTTP server invoking real handlers'], scenarios: [], migrations: [], volume: { boundary: 'Two concurrent writers and one conflicting reservation are sufficient to trigger each binding/revision bug.', backgroundDocuments: pgMode ? 1001 : 0 } };
const clone = (value) => structuredClone(value);
const conflict = () => Object.assign(new Error('Revision conflict'), { status: 409, statusCode: 409 });
const patch = (id) => {
  const operation = { id, set: {}, unset: [], delta: {}, expected: '' };
  return {
    operation,
    set(value) { Object.assign(operation.set, value); return this; },
    unset(value) { operation.unset.push(...value); return this; },
    setIfMissing(value) { for (const [key, item] of Object.entries(value)) if (documents.get(id)?.[key] === undefined) operation.set[key] = item; return this; },
    ifRevisionId(value) { operation.expected = value; return this; },
    inc(value) { for (const [key, item] of Object.entries(value)) operation.delta[key] = (operation.delta[key] || 0) + item; return this; },
    dec(value) { for (const [key, item] of Object.entries(value)) operation.delta[key] = (operation.delta[key] || 0) - item; return this; },
    async commit() { await runHook(); if(loseEmailCompletion && (operation.set.emailDispatchStatus || operation.set.recoveryNotificationStatus)) {loseEmailCompletion=false;put({...documents.get(id),fixtureRevisionMarker:'race'});} return apply(operation); },
  };
};
const runHook = async () => { if (beforeCommit) { const current = beforeCommit; beforeCommit = null; await current(); } };
const apply = (op) => {
  if (op.create) { if (documents.has(op.create._id)) throw conflict(); return put(op.create); }
  const current = documents.get(op.id);
  if (!current || (op.expected && op.expected !== current._rev)) throw conflict();
  const next = { ...current, ...clone(op.set) };
  for (const key of op.unset) delete next[key];
  for (const [key, delta] of Object.entries(op.delta)) next[key] = Number(next[key] || 0) + delta;
  return put(next);
};
const put = (doc) => { const next = { ...clone(doc), _rev: `r${++revision}`, _updatedAt: new Date().toISOString() }; documents.set(next._id, next); return clone(next); };
const fixture = {
  backend: 'sanity',
  async fetch(query, params = {}) { return (await evaluate(parse(query), { dataset: [...documents.values()], params })).get(); },
  async create(doc) { return apply({ create: doc }); },
  patch,
  async delete(id) { if (typeof id !== 'string') throw new Error('Unsupported fixture delete'); documents.delete(id); },
  transaction() {
    const ops = [];
    return { create(doc) { ops.push({ create: clone(doc) }); return this; }, patch(id, configure) { ops.push(configure(patch(id)).operation); return this; }, async commit() { await runHook(); const snapshot = clone(documents); try { for (const op of ops) apply(op); } catch (error) { documents.clear(); for (const [id, doc] of snapshot) documents.set(id, doc); throw error; } } };
  },
};
globalThis.__bookingSweepClient = fixture;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch {}
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL?.startsWith(`file://${root}/`) && !context.parentURL.includes('/node_modules/')) {
      const candidate = new URL(`${specifier}.js`, context.parentURL); if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const relative = path.relative(root,new URL(url).pathname);
    if (baseline && baselineModules.has(relative)) { const original = spawnSync('git',['show',`7f9070aa8015dc5fe2bd32c2e848bfcd98dab4c4:${relative}`],{encoding:'utf8'});assert.equal(original.status,0);return {format:'module',shortCircuit:true,source:original.stdout}; }
    if (url.endsWith('/src/server/data/documentClient.js')) return { format: 'module', shortCircuit: true, source: 'export const createDataClient = () => globalThis.__bookingSweepClient; export const createDocumentReadClient = createDataClient; export const createDocumentWriteClient = createDataClient; export const createOptionalDocumentWriteClient = createDataClient;' };
    if (url.endsWith('/src/server/supabase/commerceControl.js')) return { format: 'module', shortCircuit: true, source: 'export const assertCommerceWriteAllowed = async () => ({generation:0}); export const assertCommerceStartAllowed = assertCommerceWriteAllowed;' };
    if (url.endsWith('/src/server/api/ref/auth.js')) return { format: 'module', shortCircuit: true, source: 'export const requireReferralSession = async () => ({referralId:"referral.fixture"}); export const requireAdminKey = () => true; export const requireSecret = () => true;' };
    return nextLoad(url, context);
  },
});
const nativeFetch = globalThis.fetch;
let providerSends = 0;
globalThis.fetch = (input,init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); if(url.origin !== 'https://api.resend.com') throw new Error('External network is forbidden'); return nativeFetch(`${origin}/provider/email`,init); };
evidence.standIns.push('Resend HTTP sink with documented24h idempotency; actual Resend SDK, no live-provider proof', 'Clock advance24h+1s for accepted-receipts-lost;25h legacy rows; process only, no OS clock change', 'Receipt-save fault: competing source revision and real SQL lease-mismatch rejection');
const pgRun = (command, args) => {
  const result = spawnSync(path.join(pgBin, command), args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
};
async function setupPostgres() {
  pgBin = process.env.PG_BIN;
  assert.ok(pgBin && fs.existsSync(path.join(pgBin, 'postgres')), 'Explicit PG_BIN is required');
  assert.match(pgRun('postgres', ['--version']), /17\./);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-booking-sweep-pg-'));
  const data = path.join(scratch, 'data');
  const port = 58500 + Math.floor(Math.random() * 450);
  pgRun('initdb', ['-D', data, '--auth=trust', '--no-locale', '-U', 'postgres']);
  fs.appendFileSync(path.join(data, 'pg_hba.conf'), '\nhost all all samehost trust\n');
  pgRun('pg_ctl', ['-D', data, '-l', path.join(scratch, 'server.log'), '-o', `-p ${port} -h ${testHost} -k ${scratch}`, '-w', 'start']);
  pgStarted = true;
  const postgres = (await import('postgres')).default;
  sql = postgres({ host: testHost, port, username: 'postgres', database: 'postgres', max: 8, prepare: false, onnotice() {} });
  await sql.unsafe(`create role anon; create role authenticated; create role service_role; create schema extensions; create extension pgcrypto with schema extensions; create extension "uuid-ossp" with schema extensions; create schema auth; create schema storage; create role supabase_auth_admin; create schema vault;
    create function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create table auth.users(id uuid primary key, email text, encrypted_password text, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), banned_until timestamptz, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean default false);
    create table auth.identities(id uuid primary key, user_id uuid references auth.users(id), provider text, provider_id text, email text, identity_data jsonb default '{}', last_sign_in_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
    create table auth.sessions(id uuid primary key, user_id uuid references auth.users(id)); create table auth.refresh_tokens(id bigint primary key, user_id text, token text);
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key, bucket_id text, name text, metadata jsonb, updated_at timestamptz);
    create table vault.decrypted_secrets(id uuid primary key, name text, decrypted_secret text);
  `);
  const names = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
  const migrationSql = await sql.reserve();
  for (const name of names) {
    try { await migrationSql.unsafe(fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')); evidence.migrations.push(name); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}`); }
  }
  migrationSql.release();
  await sql.unsafe(`update migration.commerce_control set primary_backend='supabase', generation=0, starts_paused=false where singleton`);
  const rpc = { async rpc(name, parameters = {}) {
    try {
      if(failLedgerCompletion && name === 'roo_complete_booking_email_dispatch') parameters = {...parameters,p_lease_id:'fixture-lost-lease'};
      const entries = Object.entries(parameters); const values = entries.map(([, value]) => value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value);
      const [row] = await sql.unsafe(`select public.${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(',')}) as data`, values);
      return { data: row.data, error: null };
    } catch (error) { evidence.rpcErrors ||= []; evidence.rpcErrors.push({name,code:error.code,message:error.message}); return { data: null, error: { code: error.code, message: error.message, status: ['40001','23505','PT409'].includes(error.code) ? 409 : 500 } }; }
  } };
  const { SupabaseDocumentClient } = await import('../src/server/supabase/documentClient.js');
  actualClient = new SupabaseDocumentClient({ shadowClient: rpc, commerceOnly: true, cutoverGeneration: 0 });
  const originalPatch = actualClient.patch.bind(actualClient);
  actualClient.patch = (id) => { const current = originalPatch(id); const commit = current.commit.bind(current); current.commit = async (...args) => { await runHook();if(loseEmailCompletion && current.operations.some((operation)=>operation.values?.emailDispatchStatus || operation.values?.recoveryNotificationStatus)) {loseEmailCompletion=false;await actualClient.patch(id).set({fixtureRevisionMarker:'race'}).commit();} return commit(...args); }; return current; };
  const originalTx = actualClient.transaction.bind(actualClient);
  actualClient.transaction = (...args) => { const current = originalTx(...args); const commit = current.commit.bind(current); current.commit = async (...input) => { await runHook(); return commit(...input); }; return current; };
  globalThis.__bookingSweepClient = actualClient;
  const { importCommerceShadowDocuments, importShadowDocuments, projectOperationalShadow } = await import('../src/server/supabase/shadowStore.js');
  pgSeed = async (doc) => {
    const saved = {...doc,_rev:`seed-${++revision}`};
    if (doc._type === 'referral') { await importShadowDocuments({documents:[saved],client:rpc}); await projectOperationalShadow({client:rpc}); }
    else if (doc._type === 'slotHold' && doc.phase === 'payment_pending') { await importCommerceShadowDocuments({documents:[{...saved,phase:'active',paymentRecordId:''}],client:rpc}); return actualClient.patch(doc._id).set(doc).commit(); }
    else await importCommerceShadowDocuments({documents:[saved],client:rpc});
    return actualClient.fetch('*[_id == $id][0]',{id:doc._id});
  };
  await sql.unsafe(`insert into migration.source_documents(legacy_sanity_id,document_type,source_revision,source_hash,payload,backend_owner) select 'background.'||i, 'booking', 'background', repeat('0',64), jsonb_build_object('_id','background.'||i,'_type','booking','status','cancelled'), 'supabase' from generate_series(1,1001) i`);
  evidence.standIns.push('Supabase Auth/storage/vault platform prerequisite tables, unused in changed booking decisions', 'RPC transport calls actual public SQL via postgres driver; no PostgREST HTTP', 'precommit barrier to schedule the second real writer');
}
const getClient = () => globalThis.__bookingSweepClient;
const seed = async (doc) => pgMode ? pgSeed({...doc,backendOwner:'supabase',cutoverGeneration:0}) : getClient().create(doc);
const read = (id) => getClient().fetch('*[_id == $id][0]', { id });
const omitRevision = async (id) => { if(pgMode) await sql.unsafe("update migration.source_documents set payload=payload-'_rev', source_revision=null where legacy_sanity_id=$1",[id]); else delete documents.get(id)._rev; return read(id); };
const booking = (changes = {}) => ({ _id: 'booking.fixture', _type: 'booking', email: 'customer@example.invalid', packageTitle: 'Fixture package', startTimeUTC: '2099-01-01T10:00:00.000Z', netAmount: 9.99, grossAmount: 9.99, status: 'captured', paymentProvider: 'free', ...(pgMode ? {backendOwner:'supabase',cutoverGeneration:0} : {}), ...changes });
let commitModule;
let couponModule;
let refundModule;
const handlers = {};
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  const body = text ? JSON.parse(text) : {};
  const send = (status, result) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(result)); };
  try {
    if (req.url === '/provider/email') { const key=req.headers['idempotency-key'];const previous=providerMessages.get(key);if(previous && Date.now()-previous.time<24*60*60*1000){if(previous.text!==text){send(409,{code:'invalid_idempotent_request'});return;}send(200,{id:previous.id});return;}providerSends++;const message={id:`provider-fixture-${providerSends}`,time:Date.now(),text};providerMessages.set(key,message);send(200,{id:message.id});return; }
    if (req.url === '/email-recovery') {send(200,await (await import('../src/server/api/ref/bookingEmails.js')).reconcileBookingEmailDispatches({client:getClient(),limit:20}));return;}
    if (req.url === '/email-confirmation') { const result=await (await import('../src/server/api/ref/bookingEmails.js')).sendBookingEmailsForBooking({bookingId:body.bookingId,client:getClient()});send(result.httpStatus,result.body);return; }
    if (req.url === '/email-reschedule') { send(200,await (await import('../src/server/api/ref/bookingEmails.js')).dispatchRescheduleNotifications({bookingId:body.bookingId,client:getClient()}));return; }
    if (req.url === '/reschedule-commit') {send(200,await commitModule.createRequiresRescheduleBooking({...body,client:getClient(),notify:false}));return;}
    if (req.url === '/commit') { send(200, await commitModule.commitBookingTransaction({ ...body, client: getClient() })); return; }
    if (req.url === '/refund') { send(200, await refundModule.applyBookingRefund({ ...body, client: getClient() })); return; }
    if (req.url === '/reserve') { send(200, await couponModule.reserveCouponUse({ ...body, client: getClient() })); return; }
    const handler = handlers[req.url]; if (!handler) throw new Error('Unexpected route');
    const response = { statusCode: 200, status(status) { this.statusCode = status; return this; }, json(result) { send(this.statusCode,result); }, setHeader() {} };
    await handler({ method: req.url === '/cron' ? 'GET' : 'POST', body, headers: { authorization: 'Bearer fixture-cron', 'sanity-webhook-signature': (await import('node:crypto')).createHmac('sha256','fixture-webhook').update(JSON.stringify(body)).digest('hex') } }, response);
  } catch (error) { send(Number(error.statusCode || error.status || 500), { error: error.message, code: error.code }); }
});
let origin;
const request = async (route, body) => { const response = await nativeFetch(`${origin}${route}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(15000) }); return {status:response.status, body:await response.json()}; };
const check = async (name, exercise) => {
  if (selected && !selected.split(',').includes(name)) return;
  documents.clear(); beforeCommit = null; providerSends=0;providerMessages.clear();loseEmailCompletion=false;failLedgerCompletion=false;simulatedTime=null;
  if (pgMode) {
    await sql.unsafe(`truncate commerce.bookings, commerce.slot_holds, commerce.booking_slots, commerce.slot_claims, commerce.coupons, commerce.coupon_redemptions, commerce.payment_records cascade; delete from migration.source_documents where legacy_sanity_id not like 'background.%'; delete from migration.commerce_mirror_outbox; delete from migration.commerce_commands`);
  }
  try { await exercise(); evidence.scenarios.push({name,passed:true}); } catch (error) { evidence.scenarios.push({name,passed:false,error:error.message}); }
};
try {
  if (pgMode) await setupPostgres();
  commitModule = await import('../src/server/api/ref/bookingCommit.js'); couponModule = await import('../src/server/api/ref/couponReservations.js'); refundModule = await import('../src/server/api/ref/bookingRefunds.js');
  for (const [route,file] of [['/split','updateSplit'],['/sync','syncPayouts'],['/cron','cronSyncAll'],['/webhook','webhookSync'],['/create','createBooking']]) handlers[route] = (await import(`../src/server/api/ref/${file}.js`)).default;
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,testHost,resolve)); origin = `http://${testHost}:${server.address().port}`;
  for (const [field,value] of [['email','other@example.invalid'],['packageTitle','Other package'],['startTimeUTC','2099-01-01T11:00:00.000Z']]) await check(`public-paypal-replay-changed-${field}`,async()=>{await seed(booking({paymentProvider:'paypal',paypalOrderId:'order.fixture',emailDispatchClientSentAt:'2026-01-01',emailDispatchOwnerSentAt:'2026-01-01'}));const result=await request('/create',booking({paymentProvider:'paypal',paypalOrderId:'order.fixture',[field]:value}));assert.equal(result.status,409);assert.equal((await read('booking.fixture')).paymentRecordId,undefined);});
  for (const [field,value] of [['email','other@example.invalid'],['packageTitle','Other package'],['startTimeUTC','2099-01-01T11:00:00.000Z'],['netAmount',5],['couponCode','other'],['originalOrderId','booking.other']]) {
    await check(`booking-key-changed-${field}`,async()=>{ await seed(booking()); const result = await request('/commit',{booking:booking({[field]:value})}); assert.equal(result.status,409); assert.equal((await read('booking.fixture'))[field],booking()[field]); });
  }
  await check('booking-key-missing-startTimeUTC',async()=>{await seed(booking());const result=await request('/commit',{booking:booking({startTimeUTC:undefined})});assert.equal(result.status,409);assert.equal((await read('booking.fixture')).startTimeUTC,booking().startTimeUTC);});
  await check('booking-identical-replay-after-refund',async()=>{ await seed(booking({status:'refunded',refundAccountingAppliedAt:'2026-01-01'})); const result=await request('/commit',{booking:booking()}); assert.equal(result.status,200); assert.equal(result.body.idempotent,true); assert.equal((await read('booking.fixture')).status,'refunded'); });
  await check('booking-racing-key-changed-email',async()=>{ beforeCommit=()=>seed(booking({email:'other@example.invalid'})); const result=await request('/commit',{booking:booking()}); assert.equal(result.status,409); assert.equal((await read('booking.fixture')).email,'other@example.invalid'); });
  for (const [name,changes] of [['consumed',{phase:'consumed'}],['released',{phase:'released'}],['expired',{expiresAt:'2020-01-01T00:00:00.000Z'}],['pending-without-payment',{phase:'payment_pending',paymentRecordId:''}],['other-payment',{phase:'payment_pending',paymentRecordId:'paymentRecord.other'}],['other-package',{packageTitle:'Other package'}],['other-slot',{startTimeUTC:'2099-01-01T11:00:00.000Z'}]]) {
    await check(`hold-${name}-refused`,async()=>{ const hold=await seed({_id:'slothold-fixture',_type:'slotHold',phase:'active',expiresAt:'2099-01-01T12:00:00.000Z',startTimeUTC:booking().startTimeUTC,packageTitle:booking().packageTitle,...changes}); const result=await request('/commit',{booking:booking(),slot:{startTimeUTC:booking().startTimeUTC},hold}); assert.equal(result.status,409); assert.equal(await read('booking.fixture'),null); });
  }
  await check('coupon-consumed-other-booking',async()=>{ const coupon=await seed({_id:'coupon.fixture',_type:'coupon',code:'fixture',isActive:true,timesUsed:1,activeReservations:0}); const redemption=await seed({_id:'couponRedemption.fixture',_type:'couponRedemption',coupon:{_ref:coupon._id},ownerId:'booking.other',bookingId:'booking.other',status:'consumed'}); const result=await request('/commit',{booking:booking({couponCode:'fixture'}),couponReservation:{coupon,redemption}}); assert.equal(result.status,409); assert.equal(await read('booking.fixture'),null); assert.equal((await read(coupon._id)).timesUsed,1); });
  for (const [name,changes] of [['owner',{ownerId:'booking.other'}],['coupon',{coupon:{_ref:'coupon.other'}}]]) await check(`coupon-reserved-other-${name}`,async()=>{const coupon=await seed({_id:'coupon.fixture',_type:'coupon',code:'fixture',isActive:true,timesUsed:0,activeReservations:1});const redemption=await seed({_id:'couponRedemption.fixture',_type:'couponRedemption',coupon:{_ref:coupon._id},ownerId:'booking.fixture',status:'reserved',...changes});const result=await request('/commit',{booking:booking({couponCode:'fixture'}),couponReservation:{coupon,redemption}});assert.equal(result.status,409);assert.equal((await read(coupon._id)).activeReservations,1);});
  await check('refund-other-booking-coupon',async()=>{await seed(booking({couponRedemptionId:'couponRedemption.fixture'}));await seed({_id:'coupon.fixture',_type:'coupon',code:'fixture',timesUsed:1});await seed({_id:'couponRedemption.fixture',_type:'couponRedemption',coupon:{_ref:'coupon.fixture'},bookingId:'booking.other',status:'consumed'});const result=await request('/refund',{paymentRecord:{bookingId:'booking.fixture'},refund:{full:true}});assert.equal(result.status,409);assert.equal((await read('coupon.fixture')).timesUsed,1);assert.equal((await read('booking.fixture')).status,'captured');});
  for (const [name,values] of [['limit',{maxCommissionPercent:5}],['eligibility',{successfulReferrals:4}]]) await check(`split-concurrent-${name}`,async()=>{await seed({_id:'referral.fixture',_type:'referral',slug:{current:'fixture'},registrationStatus:'active',maxCommissionPercent:15,successfulReferrals:5});beforeCommit=()=>getClient().patch('referral.fixture').set(values).commit();const result=await request('/split',{commissionPercent:15,discountPercent:0});assert.equal(result.status,409);assert.equal((await read('referral.fixture')).currentCommissionPercent,undefined);});
  for (const route of ['/sync','/cron','/webhook']) await check(`payout${route}-concurrent-payment-log`,async()=>{await seed({_id:'referral.fixture',_type:'referral',slug:{current:'fixture'},xocPayments:[],vertexPayments:[]});await seed(booking({referral:{_ref:'referral.fixture'},commissionAmount:10,commissionPercent:10}));beforeCommit=()=>getClient().patch('referral.fixture').set({vertexPayments:[{_key:'paid',amount:5}]}).commit();const result=await request(route,{referralId:'referral.fixture',_id:'referral.fixture'});assert.ok([200,409,500].includes(result.status));const saved=await read('referral.fixture');assert.equal(saved.vertexPayments.length,1);assert.notEqual(saved.paidTotal,0);if(result.status===200)assert.equal(saved.paidTotal,5);});
  await check('missing-revision-split-refused',async()=>{await seed({_id:'referral.fixture',_type:'referral',slug:{current:'fixture'},maxCommissionPercent:15,successfulReferrals:5});await omitRevision('referral.fixture');beforeCommit=()=>getClient().patch('referral.fixture').set({maxCommissionPercent:5}).commit();const result=await request('/split',{commissionPercent:15,discountPercent:0});assert.notEqual(result.status,200);assert.equal((await read('referral.fixture')).currentCommissionPercent,undefined);});
  for(const route of ['/sync','/cron','/webhook'])await check(`missing-revision-payout${route}-refused`,async()=>{await seed({_id:'referral.fixture',_type:'referral',slug:{current:'fixture'},xocPayments:[],vertexPayments:[]});await omitRevision('referral.fixture');beforeCommit=()=>getClient().patch('referral.fixture').set({vertexPayments:[{_key:'paid',amount:5}]}).commit();const result=await request(route,{referralId:'referral.fixture',_id:'referral.fixture'});assert.notEqual(result.status,200);assert.equal((await read('referral.fixture')).paidTotal,undefined);});
  await check('missing-revision-hold-refused',async()=>{const doc=booking();await seed({_id:'slothold-fixture',_type:'slotHold',phase:'active',expiresAt:'2099-01-01T12:00:00.000Z',startTimeUTC:doc.startTimeUTC,packageTitle:doc.packageTitle});const hold=await omitRevision('slothold-fixture');beforeCommit=()=>getClient().patch(hold._id).set({phase:'released'}).commit();const result=await request('/commit',{booking:doc,slot:{startTimeUTC:doc.startTimeUTC},hold});assert.equal(result.status,409);assert.equal(await read(doc._id),null);});
  await check('missing-revision-coupon-refused',async()=>{const doc=booking({couponCode:'fixture'});await seed({_id:'coupon.fixture',_type:'coupon',code:'fixture',isActive:true,timesUsed:0,activeReservations:1});const coupon=await omitRevision('coupon.fixture');const redemption=await seed({_id:'couponRedemption.fixture',_type:'couponRedemption',coupon:{_ref:coupon._id},couponCode:'fixture',ownerId:doc._id,bookingId:doc._id,status:'reserved'});beforeCommit=()=>getClient().patch(coupon._id).set({isActive:false}).commit();const result=await request('/commit',{booking:doc,couponReservation:{coupon,redemption}});assert.equal(result.status,409);assert.equal(await read(doc._id),null);assert.equal((await read(coupon._id)).timesUsed,0);});
  await check('missing-revision-refund-refused',async()=>{await seed(booking());await omitRevision('booking.fixture');beforeCommit=()=>getClient().patch('booking.fixture').set({fixtureRevisionMarker:'race'}).commit();const result=await request('/refund',{paymentRecord:{bookingId:'booking.fixture'},refund:{full:true,amount:9.99}});assert.equal(result.status,409);assert.equal((await read('booking.fixture')).status,'captured');});
  for(const recovery of [false,true])await check(`missing-revision-payment-mutation-${recovery?'recovery':'normal'}-refused`,async()=>{await seed({_id:'paymentRecord.fixture',_type:'paymentRecord',provider:'paypal',providerOrderId:'order.fixture',status:'finalizing',bookingPayload:{email:'customer@example.invalid',packageTitle:'Fixture package'},pricingSnapshot:{grossAmount:9.99,netAmount:9.99}});const record=await omitRevision('paymentRecord.fixture');await getClient().patch(record._id).set({status:'refunded'}).commit();const mutation={id:record._id,set:{status:'booked'}};const result=await request(recovery?'/reschedule-commit':'/commit',recovery?{paymentRecord:record,paymentRecordMutation:mutation}:{booking:booking({paymentRecordId:record._id}),paymentRecordMutation:mutation});assert.equal(result.status,409);assert.notEqual((await read(record._id)).status,'booked');assert.equal((await getClient().fetch('*[_type == "booking" && !(_id match "background.*")]')).length,0);});
  for(const recovery of [false,true])await check(`payment-mutation-${recovery?'recovery':'normal'}-valid-revision`,async()=>{const record=await seed({_id:'paymentRecord.fixture',_type:'paymentRecord',provider:'paypal',providerOrderId:'order.fixture',status:'finalizing',bookingPayload:{email:'customer@example.invalid',packageTitle:'Fixture package'},pricingSnapshot:{grossAmount:9.99,netAmount:9.99}});const mutation={id:record._id,revision:record._rev,set:{status:'booked'}};const result=await request(recovery?'/reschedule-commit':'/commit',recovery?{paymentRecord:record,paymentRecordMutation:mutation}:{booking:booking({paymentProvider:'paypal',paypalOrderId:'order.fixture',paymentRecordId:record._id}),paymentRecordMutation:mutation});assert.equal(result.status,200);const saved=await read(record._id);assert.equal(saved.status,'booked');assert.ok(saved.bookingId);assert.ok(await read(saved.bookingId));});
  await check('missing-revision-partial-refund-refused',async()=>{await seed(booking());await omitRevision('booking.fixture');beforeCommit=()=>getClient().patch('booking.fixture').set({refundedAmount:4.99}).commit();const result=await request('/refund',{paymentRecord:{bookingId:'booking.fixture'},refund:{full:false,id:'refund.fixture',amount:5}});assert.equal(result.status,409);assert.equal((await read('booking.fixture')).refundStatus,undefined);});
  for(const kind of ['confirmation','reschedule'])await check(`missing-revision-email-${kind}-refused`,async()=>{await seed(booking({requiresReschedule:kind==='reschedule'}));await omitRevision('booking.fixture');await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,0);});
  await check('booking-transaction-own-hold-coupon-and-replay',async()=>{const doc=booking({couponCode:'fixture'});const hold=await seed({_id:'slothold-fixture',_type:'slotHold',phase:'active',expiresAt:'2099-01-01T12:00:00.000Z',startTimeUTC:doc.startTimeUTC,packageTitle:doc.packageTitle});const coupon=await seed({_id:'coupon.fixture',_type:'coupon',code:'fixture',isActive:true,timesUsed:0,activeReservations:1});const redemption=await seed({_id:'couponRedemption.fixture',_type:'couponRedemption',coupon:{_ref:coupon._id},couponCode:'fixture',ownerId:doc._id,bookingId:doc._id,status:'reserved'});const input={booking:doc,slot:{startTimeUTC:doc.startTimeUTC},hold,couponReservation:{coupon,redemption}};assert.equal((await request('/commit',input)).status,200);assert.equal((await read(hold._id)).phase,'consumed');assert.equal((await read(coupon._id)).timesUsed,1);assert.equal((await read(coupon._id)).activeReservations,0);assert.equal((await read(redemption._id)).bookingId,doc._id);assert.equal((await request('/commit',input)).body.idempotent,true);assert.equal((await read(coupon._id)).timesUsed,1);});
  for(const kind of ['derived-own','derived-other-owner','upgrade-parent','missing-utc','invalid-utc','explicit-other-owner'])await check(`refund-slot-${kind}`,async()=>{const utc=booking().startTimeUTC;const {buildBookingSlotId}=await import('../src/server/booking/slotIdentity.js');const lockId=buildBookingSlotId(utc);const other=kind.includes('other-owner');const upgrade=kind==='upgrade-parent';const noUtc=kind==='missing-utc'||kind==='invalid-utc';const owner=other?'booking.other':upgrade?'booking.original':'booking.fixture';const fixtureDocs=[];if(other||upgrade)fixtureDocs.push(booking({_id:owner}));const doc=booking({status:other?'cancelled':'captured',...(upgrade?{originalOrderId:'booking.original'}:{}),...(noUtc?{startTimeUTC:kind==='missing-utc'?undefined:'invalid'}:{}),...(kind==='explicit-other-owner'?{slotLockId:lockId,startTimeUTC:undefined}:{})});fixtureDocs.push(doc);if(!noUtc)fixtureDocs.push({_id:lockId,_type:'bookingSlot',bookingId:owner,startTimeUTC:utc,status:'active'});const setup=getClient().transaction();for(const item of fixtureDocs)setup.create({...item,...(pgMode?{backendOwner:'supabase',cutoverGeneration:0}:{})});await setup.commit();const input={paymentRecord:{bookingId:doc._id},refund:{full:true,amount:9.99}};const result=await request('/refund',input);assert.equal(result.status,200);const saved=await read(doc._id);assert.equal(saved.slotReleasedAfterRefund,kind==='derived-own');if(!noUtc){const lock=await read(lockId);assert.equal(lock.status,kind==='derived-own'?'released':'active');assert.equal(lock.bookingId,owner);}if(other||upgrade)assert.equal((await read(owner)).status,'captured');assert.equal((await request('/refund',input)).body.idempotent,true);evidence.refundSlots ||= [];evidence.refundSlots.push({kind,bookingId:doc._id,originalOrderId:doc.originalOrderId||'',requestedUTC:doc.startTimeUTC||'',explicitSlotId:doc.slotLockId||'',lockOwner:owner,result:result.body,slotAfter:noUtc?null:await read(lockId)});});
  await check('refund-own-coupon-accounting-replay',async()=>{await seed(booking({couponRedemptionId:'couponRedemption.fixture'}));await seed({_id:'coupon.fixture',_type:'coupon',code:'fixture',timesUsed:1});await seed({_id:'couponRedemption.fixture',_type:'couponRedemption',coupon:{_ref:'coupon.fixture'},bookingId:'booking.fixture',status:'consumed'});const input={paymentRecord:{bookingId:'booking.fixture'},refund:{full:true,amount:9.99}};assert.equal((await request('/refund',input)).status,200);assert.equal((await read('coupon.fixture')).timesUsed,0);assert.equal((await read('booking.fixture')).refundedAmount,9.99);assert.equal((await request('/refund',input)).body.idempotent,true);assert.equal((await read('coupon.fixture')).timesUsed,0);});
  await check('booking-concurrent-single-slot-commit',async()=>{const doc=booking();const hold=await seed({_id:'slothold-fixture',_type:'slotHold',phase:'active',expiresAt:'2099-01-01T12:00:00.000Z',startTimeUTC:doc.startTimeUTC,packageTitle:doc.packageTitle});const input={booking:doc,slot:{startTimeUTC:doc.startTimeUTC},hold};const results=await Promise.all([request('/commit',input),request('/commit',{...input,booking:booking({_id:'booking.other'})})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);const existing=await Promise.all(['booking.fixture','booking.other'].map(read));assert.equal(existing.filter(Boolean).length,1);assert.equal((await read(hold._id)).bookingId,existing.find(Boolean)._id);});
  await check('captured-expired-hold-recovery',async()=>{const doc=booking({paymentProvider:'paypal',paypalOrderId:'order.fixture'});const hold=await seed({_id:'slothold-fixture',_type:'slotHold',phase:'active',expiresAt:'2020-01-01T12:00:00.000Z',startTimeUTC:doc.startTimeUTC,packageTitle:doc.packageTitle});assert.equal((await request('/commit',{booking:doc,slot:{startTimeUTC:doc.startTimeUTC},hold,allowMissingHold:true})).status,200);assert.equal((await read(hold._id)).phase,'consumed');});
  if(pgMode)await check('email-unknown-terminal-projection-and-completion',async()=>{
    assert.equal(pgMode,true,'Actual PostgreSQL required');
    const sentAt=new NativeDate().toISOString();
    await seed(booking({requiresReschedule:true,emailDispatchStatus:'delivery_unknown',recoveryNotificationStatus:'delivery_unknown',emailDispatchClientSentAt:sentAt,emailDispatchClientProviderId:'receipt-customer',recoveryOwnerNotifiedAt:sentAt,recoveryOwnerProviderId:'receipt-owner'}));
    const rows=()=>sql.unsafe("select dispatch.dispatch_kind,dispatch.recipient_type,dispatch.status,dispatch.provider_message_id,dispatch.lease_id,dispatch.next_attempt_at from commerce.email_dispatches dispatch join commerce.bookings booking on booking.id=dispatch.booking_id where booking.legacy_sanity_id='booking.fixture' order by dispatch.dispatch_kind,dispatch.recipient_type");
    for(let i=0;i<3;i++){await sql.unsafe("select migration.project_commerce_extensions(array['booking.fixture']::text[])");await sql.unsafe('select public.roo_refresh_operational_shadow()');}
    let projected=await rows();assert.deepEqual(projected.map(row=>row.status),['sent','historical_unknown','historical_unknown','sent']);assert.equal(projected[0].provider_message_id,'receipt-customer');assert.equal(projected[3].provider_message_id,'receipt-owner');for(const row of projected.filter(row=>row.status==='historical_unknown')){assert.equal(row.lease_id,null);assert.equal(row.next_attempt_at,null);}
    await seed(booking({_id:'booking.completion',startTimeUTC:'2099-01-02T10:00:00.000Z',requiresReschedule:true,emailDispatchStatus:'pending',recoveryNotificationStatus:'pending'}));
    const {claimEmailDispatchPair,completeEmailDispatch}=await import('../src/server/supabase/emailDispatchLedger.js');
    const completions=[];
    for(const dispatchKind of ['booking_confirmation','reschedule']){const leaseId=`fixture-unknown-${dispatchKind}`;const pair=await claimEmailDispatchPair({client:actualClient,bookingId:'booking.completion',dispatchKind,leaseId});for(const dispatch of [pair.customer,pair.owner]){if(dispatch.claimed)completions.push(await completeEmailDispatch({client:actualClient,dispatch,leaseId,success:false,errorCode:'email_delivery_unknown'}));}}
    assert.ok(completions.length>0);for(const item of completions){assert.equal(item.sent,false);assert.equal(item.historicalUnknown,true);}
    projected=await rows();evidence.unknownTerminal={projected,completions};assert.equal(providerSends,0);
  });
  if(selected?.split(',').includes('email-unknown-ledger-retry-bound'))await check('email-unknown-ledger-retry-bound',async()=>{assert.equal(pgMode,true,'Diagnostic requires actual PostgreSQL');await seed(booking({emailDispatchStatus:'delivery_unknown',emailDispatchAttemptCount:1,emailDispatchLastAttemptAt:new NativeDate(NativeDate.now()-25*60*60*1000).toISOString(),emailDispatchClientFirstAttemptAt:new NativeDate(NativeDate.now()-25*60*60*1000).toISOString(),emailDispatchOwnerFirstAttemptAt:new NativeDate(NativeDate.now()-25*60*60*1000).toISOString()}));await sql.unsafe("update commerce.email_dispatches set status='historical_unknown' where legacy_sanity_id like 'background.%'");evidence.standIns.push('Retry diagnostic isolates its active booking by marking cancelled synthetic volume rows historical_unknown');const scans=[];for(let i=0;i<13;i++)scans.push((await request('/email-recovery',{})).body);evidence.retryBound={documentedAttemptLimit:12,recoveryScans:scans,source:await read('booking.fixture'),rows:await sql.unsafe("select dispatch.dispatch_kind,dispatch.recipient_type,dispatch.status,dispatch.attempt_count,dispatch.last_error_code from commerce.email_dispatches dispatch join commerce.bookings booking on booking.id=dispatch.booking_id where booking.legacy_sanity_id='booking.fixture'")};assert.equal(providerSends,0);assert.equal(scans.at(-1).scanned,0);});
  for (const [kind,prefix] of [['confirmation','emailDispatch'],['reschedule','recoveryNotification']]) {
    await check(`email-${kind}-accepted-receipts-lost-then-late-retry`,async()=>{await seed(booking({requiresReschedule:kind==='reschedule'}));if(pgMode)await sql.unsafe(`update commerce.email_dispatches set status='pending', lease_id=null, lease_expires_at=null`);loseEmailCompletion=true;failLedgerCompletion=true;await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,2);const afterFirst=await read('booking.fixture');assert.equal(afterFirst.emailDispatchClientSentAt || afterFirst.recoveryClientNotifiedAt,undefined);failLedgerCompletion=false;simulatedTime=Math.min(...[...providerMessages.values()].map(value=>value.time))+24*60*60*1000+1000;if(pgMode)await sql.unsafe(`update commerce.email_dispatches set lease_expires_at=now()-interval '1 second',next_attempt_at=null`);await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,2);assert.equal((await read('booking.fixture'))[`${prefix}Status`],'delivery_unknown');});
    await check(`email-${kind}-accepted-receipts-lost-same-day-retry`,async()=>{await seed(booking({requiresReschedule:kind==='reschedule'}));if(pgMode)await sql.unsafe(`update commerce.email_dispatches set status='pending', lease_id=null, lease_expires_at=null`);loseEmailCompletion=true;failLedgerCompletion=true;await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,2);failLedgerCompletion=false;simulatedTime=NativeDate.now()+60*60*1000;if(pgMode)await sql.unsafe(`update commerce.email_dispatches set lease_expires_at=now()-interval '1 second',next_attempt_at=null`);await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,2);assert.equal((await read('booking.fixture'))[`${prefix}Status`],'sent');});
    await check(`email-${kind}-late-uncertain-delivery`,async()=>{const t0=new Date(Date.now()-25*60*60*1000).toISOString();await seed(booking({requiresReschedule:kind==='reschedule',[`${prefix}LastAttemptAt`]:t0,[`${prefix}AttemptCount`]:1}));await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,0);const saved=await read('booking.fixture');assert.equal(saved[`${prefix}Status`],'delivery_unknown');assert.equal(saved[`${prefix}NextAttemptAt`],'');});
    await check(`email-${kind}-fresh-send`,async()=>{await seed(booking({requiresReschedule:kind==='reschedule'}));if(pgMode)await sql.unsafe(`update commerce.email_dispatches set status='pending', lease_id=null, lease_expires_at=null where dispatch_kind='${kind==='confirmation'?'booking_confirmation':'reschedule'}'`);await request(`/email-${kind}`,{bookingId:'booking.fixture'});assert.equal(providerSends,2);const saved=await read('booking.fixture');assert.equal(saved[`${prefix}Status`],'sent');});
  }
  if (selected && evidence.scenarios.length===0) throw new Error('Unknown scenario');
  evidence.passed=evidence.scenarios.every((result)=>result.passed);if(!evidence.passed)process.exitCode=1;
} catch(error) { evidence.passed=false;evidence.failure=error.message;process.exitCode=1; }
finally {
  if(server.listening)await new Promise((resolve)=>server.close(resolve));
  if(sql)await sql.end({timeout:5});if(pgStarted)pgRun('pg_ctl',['-D',path.join(scratch,'data'),'-m','fast','-w','stop']);
  evidence.scratch=scratch;fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
}

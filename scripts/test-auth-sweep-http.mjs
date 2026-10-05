const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const artifact = path.resolve(process.env.AUTH_SWEEP_ARTIFACT || '/tmp/roo-auth-sweep-http.json');
const selected = process.argv.find((argument) => argument.startsWith('--scenario='))?.split('=')[1];
const results = [];
const baseline = process.argv.includes('--baseline');
const changedModules = new Set(['src/server/supabase/accounts.js','src/server/supabase/credentialRecovery.js','src/server/api/ref/auth.js','src/server/api/ref/register.js','src/server/api/ref/reset.js','src/server/api/ref/recoverPassword.js','app/api/auth/identities/route.js']);
const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const baseAccount = { user_id: userId, principal_id: userId, primary_email: 'auth-fixture@example.invalid', verified_real_email: 'auth-fixture@example.invalid', status: 'active', roles: ['creator'], creator_active: true, creator_legacy_sanity_id: 'referral.fixture', legacy_sanity_id: 'referral.fixture', referral_code: 'fixture', session_version: 1 };
const state = { account: { ...baseAccount }, operation: null, authUpdates: 0, failAuth: false, loginMutation: null, documents: new Map(), reads: 0, race: '', social: false };
const clone = (value) => structuredClone(value);
const error = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });
const documentClient = {
  async fetch(query, parameters = {}) {
    if (Array.isArray(parameters.ids)) return parameters.ids.map((id) => state.documents.get(id)).filter(Boolean).map(clone);
    if (query.includes('referralAuthAuthority')) return null;
    if (query.includes('_type == "coupon"')) return null;
    if (query.includes('lower(creatorEmail)')) {
      const snapshot = clone(state.documents.get('referral.fixture') || null);
      return snapshot;
    }
    if (query.includes('lower(slug.current)')) {
      const snapshot = clone(state.documents.get('referral.fixture') || null);
      if (state.race === 'cleanup' && snapshot) state.documents.set(snapshot._id, { ...snapshot, _rev: 'r2', registrationStatus: 'active' });
      return snapshot;
    }
    if (parameters.id) return clone(state.documents.get(parameters.id) || null);
    throw new Error('Unrecognized fixture query');
  },
  transaction() {
    const operations = [];
    const transaction = {
      delete(id) { operations.push({ kind: 'delete', id }); return transaction; },
      create(document) { operations.push({ kind: 'create', document: clone(document) }); return transaction; },
      createOrReplace(document) { operations.push({ kind: 'replace', document: clone(document) }); return transaction; },
      patch(id, configure) {
        const operation = { kind: 'patch', id, set: {}, unset: [], revision: '' };
        const patch = { ifRevisionId(revision) { operation.revision = revision; return patch; }, set(values) { Object.assign(operation.set, values); return patch; }, unset(fields) { operation.unset.push(...fields); return patch; } };
        configure(patch); operations.push(operation); return transaction;
      },
      async commit() {
        if (state.race === 'cleanup-commit') {
          const previous=state.documents.get('referral.fixture'); state.documents.set(previous._id,{...previous,_rev:'r2',registrationStatus:'active'});
        }
        if (state.race === 'claim-reassigned') {
          for (const [id, document] of state.documents) if (document._type === 'referralIdentityClaim') state.documents.set(id,{...document,_rev:'claim-r2',referral:{_type:'reference',_ref:'referral.other'}});
        }
        if (state.race === 'replacement') {
          const previous = state.documents.get('referral.fixture');
          state.documents.set(previous._id, { ...previous, _rev: 'r2', registrationStatus: 'active', marker: 'concurrent-activation' });
        }
        const next = clone(state.documents);
        for (const operation of operations) {
          if (operation.kind === 'patch') {
            const current = next.get(operation.id);
            if (!current || (operation.revision && current._rev !== operation.revision)) throw error('40001', 'Fixture revision conflict');
            Object.assign(current, operation.set); for (const field of operation.unset) delete current[field];
          } else if (operation.kind === 'delete') next.delete(operation.id);
          else if (operation.kind === 'create' && next.has(operation.document._id)) throw error('23505', 'Fixture document exists');
          else next.set(operation.document._id, { ...operation.document, _rev: 'r-next' });
        }
        state.documents = next;
        return { ok: true };
      },
    };
    return transaction;
  },
};
globalThis.__authSweepDocumentClient = documentClient;
globalThis.__authSweepSocialUser = () => state.social ? { id: userId, identities: [{id: 'fixture-email', provider: 'email'}] } : null;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL?.startsWith(`file://${root}/`) && !context.parentURL.includes('/node_modules/')) {
      const resolved = new URL(`${specifier}.js`, context.parentURL);
      if (fs.existsSync(resolved)) return nextResolve(resolved.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/src/server/data/documentClient.js')) return { format: 'module', shortCircuit: true, source: 'export const createDataClient = () => globalThis.__authSweepDocumentClient; export const createDocumentReadClient = createDataClient; export const createDocumentWriteClient = createDataClient; export const createOptionalDocumentWriteClient = createDataClient;' };
    if (url.endsWith('/src/server/api/ref/referralEmailDispatches.js')) return { format: 'module', shortCircuit: true, source: 'export const deliverReferralEmailDispatch = async () => ({sent: 1}); export const enqueueReferralEmailMutation = async () => ({}); export const isReferralEmailSourceStateConflict = () => false; export const requeueReferralEmailDispatch = async () => ({sent:true}); export const sendReferralEmailDirect = async () => ({});' };
    if (url.endsWith('/src/server/supabase/serverSession.js')) return { format: 'module', shortCircuit: true, source: 'export const getLegacySupabaseUser = async () => globalThis.__authSweepSocialUser(); export const getNextSupabaseUser = getLegacySupabaseUser; export const createNextSupabaseSessionClient = () => ({auth:{getUser: async () => ({data:{user:globalThis.__authSweepSocialUser()}}), getSession:async () => ({data:{session:{access_token: "fixture-access"}}}), unlinkIdentity:async () => ({error:null})}});' };
    const relative = url.startsWith(`file://${root}/`) ? url.slice(`file://${root}/`.length) : '';
    if (baseline && changedModules.has(relative)) {
      const original = spawnSync('git',['show',`7f9070aa8015dc5fe2bd32c2e848bfcd98dab4c4:${relative}`],{cwd:root,encoding:'utf8'});
      assert.equal(original.status,0);
      return {format:'module',shortCircuit:true,source:original.stdout};
    }
    return nextLoad(url, context);
  },
});

let registration;
let identities;
const server = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const send = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    if (request.url === '/fixture/identities') {
      const source = await identities.POST(new Request(`${origin}/api/auth/identities`, {method: 'POST', headers: {...request.headers, origin}, body: raw}));
      response.writeHead(source.status, Object.fromEntries(source.headers)); response.end(await source.text()); return;
    }
    if (request.url === '/fixture/register') {
      request.body = body;
      response.status = (status) => { response.statusCode = status; return response; };
      response.json = (value) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); return response; };
      await registration(request, response); return;
    }
    if (request.url.startsWith('/auth/v1/token')) {
      if (state.loginMutation) state.loginMutation();
      send({ access_token: "fixture-access", refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user: { id: userId, email: baseAccount.primary_email } }); return;
    }
    if (request.url === `/auth/v1/admin/users/${userId}`) {
      state.authUpdates++;
      if (state.failAuth) { send({ msg: 'Fixture transient failure' }, 500); return; }
      send({ user: { id: userId, email: baseAccount.primary_email } }); return;
    }
    const rpc = request.url.split('/rest/v1/rpc/')[1];
    if (rpc === 'roo_resolve_account_alias' || rpc === 'roo_account_by_user_id' || rpc === 'roo_validate_referral_session') { send(state.account); return; }
    if (rpc === 'roo_consume_reauth_grant' || rpc === 'roo_reconcile_auth_identity_links') { send({}); return; }
    if (rpc === 'roo_creator_registration_conflicts') { send({ email_reserved: false, referral_code_reserved: false }); return; }
    if (rpc === 'roo_prepare_credential_operation_v2') {
      const desired = { operation_key: body.p_operation_key, user_id: body.p_user_id, principal_id: userId, password_hash: body.p_password_hash, source_backend: body.p_source_backend, source_document_id: body.p_source_document_id, source_expected_revision: body.p_source_expected_revision, source_preconditions: body.p_source_preconditions, source_mutation: body.p_source_mutation };
      if (state.operation) {
        const saved = Object.fromEntries(Object.keys(desired).map((key) => [key, state.operation[key]]));
        if (JSON.stringify(saved) !== JSON.stringify(desired)) { send({ code: '23505', message: 'Credential operation conflicts' }, 409); return; }
        send({...state.operation,idempotent:true}); return;
      } else state.operation = { ...desired, status: 'prepared' };
      send(state.operation); return;
    }
    if (rpc === 'roo_get_credential_operation_v2') { send(state.operation); return; }
    if (rpc === 'roo_mark_credential_operation_v2') { state.operation.status = body.p_status; state.operation.sessions_revoked_at = new Date().toISOString(); send(state.operation); return; }
    throw new Error(`Unexpected fixture request ${request.url}`);
  } catch (failure) { send({ code: failure.code || 'FIXTURE_FAILURE', message: failure.message }, failure.statusCode || 500); }
});
await new Promise((resolve, reject) => server.once('error', reject).listen(0, testHost, resolve));
const origin = `http://${testHost}:${server.address().port}`;
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const destination = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(destination.origin, origin, 'External network request blocked');
  return actualFetch(input, init);
};
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|SANITY_|RESEND_|PAYPAL_|RAZORPAY_|DODO_|VERCEL_ENV)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', SUPABASE_URL: origin, SUPABASE_SECRET_KEY: 'fixture-secret-key', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key', REF_SESSION_SECRET: 'auth-sweep-local-fixture-secret', RATE_LIMIT_HASH_SECRET: 'auth-sweep-local-rate-limit', REFERRAL_EMAIL_TOKEN_SECRET: 'a'.repeat(64), DATA_PRIMARY_BACKEND: 'sanity', SUPABASE_SHADOW_WRITES: '0' });
const accounts = await import('../src/server/supabase/accounts.js');
const recovery = await import('../src/server/supabase/credentialRecovery.js');
const auth = await import('../src/server/api/ref/auth.js');
registration = (await import('../src/server/api/ref/register.js')).default;
identities = await import('../app/api/auth/identities/route.js');
const adminClient = (await import('../src/server/supabase/adminClient.js')).createSupabaseAdminClient();
const authClient = (await import('../src/server/supabase/authClient.js')).createSupabaseAuthClient();
const password = 'fixture-password-one';
const different = 'fixture-password-two';
const savedHash = await bcrypt.hash(password, 4);
const credentialArguments = async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  return { identifier: baseAccount.primary_email, password, passwordHash, operationKey: 'credential:fixture:same-key', sourceBackend: 'supabase', sourceDocumentId: 'referral.fixture', sourceRevision: 'r1', sourcePreconditions: { creatorPassword: 'original', credentialVersion: 2 }, sourceMutation: accounts.buildCredentialSourceMutation({ passwordHash, passwordChangedAt: new Date().toISOString(), consumeResetToken: true }), adminClient };
};
async function scenario(name, check) {
  if (selected && name !== selected) return;
  state.account = clone(baseAccount); state.operation = null; state.authUpdates = 0; state.failAuth = false; state.loginMutation = null; state.race = ''; state.social = false; state.documents = new Map();
  try { await check(); results.push({ scenario: name, passed: true }); }
  catch (failure) { results.push({ scenario: name, passed: false, error: failure.message }); }
}
try {
  await scenario('credential-source-owner-mismatch', async () => {
    await assert.rejects(accounts.updateSupabaseAccountPassword({...await credentialArguments(), sourceDocumentId:'referral.other'}), (failure) => failure.code === 'P0002');
    assert.equal(state.authUpdates,0); assert.equal(state.operation,null);
    delete state.account.creator_legacy_sanity_id; delete state.account.legacy_sanity_id;
    await assert.rejects(accounts.updateSupabaseAccountPassword(await credentialArguments()), (failure) => failure.code === 'P0002');
    assert.equal(state.authUpdates,0); assert.equal(state.operation,null);
  });
  await scenario('prepared-retry', async () => {
    state.failAuth = true;
    await assert.rejects(accounts.updateSupabaseAccountPassword(await credentialArguments()));
    assert.equal(state.operation.status, 'prepared');
    const first = clone(state.operation);
    state.failAuth = false;
    const updated = await accounts.updateSupabaseAccountPassword(await credentialArguments());
    assert.equal(updated.updated, true);
    assert.equal(updated.passwordHash, first.password_hash);
    assert.deepEqual(updated.sourceMutation, first.source_mutation);
    assert.equal(state.operation.status, 'auth_applied');
    assert.equal(state.authUpdates, 2);
  });
  await scenario('prepared-different-password', async () => {
    state.failAuth = true;
    await assert.rejects(accounts.updateSupabaseAccountPassword(await credentialArguments()));
    state.failAuth = false;
    await assert.rejects(accounts.updateSupabaseAccountPassword({ ...await credentialArguments(), password: different }), (failure) => failure.code === '23505');
    assert.equal(state.authUpdates, 1);
    assert.equal(state.operation.status, 'prepared');
  });
  await scenario('prepared-backoff', async () => {
    state.failAuth=true;
    await assert.rejects(accounts.updateSupabaseAccountPassword(await credentialArguments()));
    state.failAuth=false;
    state.operation.next_retry_at=new Date(Date.now()+60000).toISOString();
    let resumeFailure;
    let updateFailure;
    try {await recovery.resumeSupabaseCredentialOperation({operationKey:state.operation.operation_key,password,adminClient,sanityClient:documentClient});} catch (failure) {resumeFailure=failure;}
    try {await accounts.updateSupabaseAccountPassword(await credentialArguments());} catch (failure) {updateFailure=failure;}
    assert.equal(state.authUpdates,1);
    assert.equal(resumeFailure?.code,'CREDENTIAL_RECOVERY_BACKOFF');
    assert.equal(updateFailure?.code,'CREDENTIAL_RECOVERY_BACKOFF');
    assert.equal(resumeFailure.nextRetryAt,state.operation.next_retry_at);
    assert.equal(state.operation.status,'prepared');
  });
  for (const parked of [false,true]) {
    await scenario(parked?'prepared-exact-retry-blocked':'prepared-exact-retry-backoff', async () => {
      const arguments_=await credentialArguments();
      state.failAuth=true;
      await assert.rejects(accounts.updateSupabaseAccountPassword(arguments_));
      state.failAuth=false;
      if (parked) state.operation.source_recovery_blocked=true;
      else state.operation.next_retry_at=new Date(Date.now()+60000).toISOString();
      let failure;
      try {await accounts.updateSupabaseAccountPassword(arguments_);} catch (error) {failure=error;}
      assert.equal(state.authUpdates,1);
      assert.equal(failure?.code,parked?'CREDENTIAL_SOURCE_REPAIR_REQUIRED':'CREDENTIAL_RECOVERY_BACKOFF');
      assert.equal(state.operation.status,'prepared');
    });
  }
  await scenario('replay-different-password', async () => {
    state.operation = { operation_key: 'credential:fixture:replay', user_id: userId, principal_id: userId, password_hash: savedHash, source_backend: 'supabase', source_document_id: 'referral.fixture', status: 'mirrored' };
    await assert.rejects(recovery.resumeSupabaseCredentialOperation({ operationKey: state.operation.operation_key, password: different, adminClient, sanityClient: documentClient }), (failure) => failure.code === '23505');
    const replay = await recovery.resumeSupabaseCredentialOperation({ operationKey: state.operation.operation_key, password, adminClient, sanityClient: documentClient });
    assert.equal(replay.resumed, true);
    assert.equal(state.authUpdates, 0);
  });
  await scenario('failed-operation-no-source-write', async () => {
    const arguments_ = await credentialArguments();
    state.operation = {operation_key: arguments_.operationKey, user_id: userId, principal_id: userId, password_hash: arguments_.passwordHash, source_backend: 'sanity', source_document_id: 'referral.fixture', source_expected_revision: 'r1', source_preconditions: arguments_.sourcePreconditions, source_mutation: arguments_.sourceMutation, status: 'failed'};
    const source = {_id:'referral.fixture', _rev:'r1', creatorPassword:'original', credentialVersion:2};
    let writes = 0;
    const sourceClient = {
      async fetch() { return clone(source); },
      patch() {
        const patch = {ifRevisionId() {return patch;}, set(values) {Object.assign(source,values);return patch;}, unset(fields) {for (const field of fields) delete source[field];return patch;}, async commit() {writes++;return {...source,_rev:'r2'};}};
        return patch;
      },
    };
    let failure;
    try { await recovery.resumeSupabaseCredentialOperation({operationKey:state.operation.operation_key,password,adminClient,sanityClient:sourceClient}); } catch (error) {failure=error;}
    assert.equal(writes,0);
    assert.equal(source.creatorPassword,'original');
    assert.equal(failure?.code,'55000');
    assert.equal(state.authUpdates,0);
  });
  for (const [name, mutate] of [ ['login-disable', () => state.account.status = 'disabled'], ['login-role-removed', () => state.account.roles = []], ['login-version-changed', () => state.account.session_version = 2], ['login-principal-changed', () => state.account.principal_id = otherId] ]) {
    await scenario(name, async () => {
      state.loginMutation = mutate;
      const result = await accounts.authenticateSupabaseAccount({ identifier: baseAccount.primary_email, password, requiredRoles: ['creator'], adminClient, authClient });
      assert.equal(result.ok, false);
    });
  }
  await scenario('session-principal-reassigned', async () => {
    process.env.DATA_PRIMARY_BACKEND = 'supabase';
    const cookie = auth.createReferralSessionCookie({ referralId: 'referral.fixture', code: 'fixture', authBackend: 'supabase', principalId: userId, sessionVersion: 1 });
    state.account.principal_id = otherId;
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json() {} };
    const session = await auth.requireReferralSession({ headers: { cookie: `${cookie.name}=${cookie.value}` } }, response);
    assert.equal(session, null); assert.equal(response.statusCode, 401);
    process.env.DATA_PRIMARY_BACKEND = 'sanity';
  });
  await scenario('session-creator-role-removed', async () => {
    process.env.DATA_PRIMARY_BACKEND = 'supabase';
    const cookie = auth.createReferralSessionCookie({referralId:'referral.fixture', code:'fixture', authBackend:'supabase', principalId:userId, sessionVersion:1});
    state.account.roles = [];
    const response = {statusCode:200, status(value) {this.statusCode=value;return this;}, json() {}};
    assert.equal(await auth.requireReferralSession({headers:{cookie:`${cookie.name}=${cookie.value}`}}, response), null);
    assert.equal(response.statusCode,401);
    process.env.DATA_PRIMARY_BACKEND = 'sanity';
  });
  await scenario('session-subsecond-rotation', async () => {
    process.env.DATA_PRIMARY_BACKEND = 'sanity';
    const realNow = Date.now;
    const start = Math.floor(realNow() / 1000) * 1000;
    Date.now = () => start + 100;
    let cookie;
    try { cookie = auth.createReferralSessionCookie({ referralId: 'referral.fixture', code: 'fixture', authBackend: 'sanity' }); } finally { Date.now = realNow; }
    state.documents.set('referral.fixture', { _id: 'referral.fixture', code: 'fixture', registrationStatus: 'active', passwordChangedAt: new Date(start + 500).toISOString() });
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json() {} };
    const session = await auth.requireReferralSession({headers: {cookie: `${cookie.name}=${cookie.value}`}}, response);
    assert.equal(session, null); assert.equal(response.statusCode, 401);
    Date.now = () => start + 600;
    try { cookie = auth.createReferralSessionCookie({ referralId: 'referral.fixture', code: 'fixture', authBackend: 'sanity' }); } finally { Date.now = realNow; }
    assert.ok(await auth.requireReferralSession({headers: {cookie: `${cookie.name}=${cookie.value}`}}, response));
  });
  await scenario('prepared-changed-source-content', async () => {
    state.failAuth = true;
    await assert.rejects(accounts.updateSupabaseAccountPassword(await credentialArguments()));
    state.failAuth = false;
    await assert.rejects(accounts.updateSupabaseAccountPassword({...await credentialArguments(), sourcePreconditions: {credentialVersion: 1}}), (failure) => failure.code === '23505');
    assert.equal(state.authUpdates, 1);
    const arguments_ = await credentialArguments();
    arguments_.sourceMutation.unset = [];
    await assert.rejects(accounts.updateSupabaseAccountPassword(arguments_), (failure) => failure.code === '23505');
    assert.equal(state.authUpdates, 1);
  });
  await scenario('unlink-projected-provider', async () => {
    state.social = true; state.account.connected_providers = ['email','google'];
    const cookie = auth.createReferralSessionCookie({referralId:'referral.fixture', code:'fixture', authBackend:'supabase', principalId:userId, sessionVersion:1});
    const response = await fetch(`${origin}/fixture/identities`, {method:'POST', headers:{'content-type':'application/json', cookie:`${cookie.name}=${cookie.value}; roo_reauth_grant=fixture-proof`}, body:JSON.stringify({flow:'referral', provider:'google'})});
    assert.equal(response.status, 409);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(state.account.connected_providers, ['email','google']);
  });
  await scenario('registration-retained-accounting', async () => {
    process.env.DATA_PRIMARY_BACKEND='sanity';
    state.documents.set('referral.fixture',{_id:'referral.fixture',_type:'referral',_rev:'r1',creatorEmail:baseAccount.primary_email,slug:{current:'fixture'},registrationStatus:'pending_email',registrationVerificationExpiresAt:new Date(Date.now()-60000).toISOString(),successfulReferrals:1,xocPayments:[{amount:10}]});
    const response=await fetch(`${origin}/fixture/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Fixture User',email:baseAccount.primary_email,paypalEmail:'fixture-paypal@example.invalid',slug:'fixture',password})});
    await response.json();
    assert.equal(state.documents.get('referral.fixture')?.successfulReferrals,1);
    assert.deepEqual(state.documents.get('referral.fixture')?.xocPayments,[{amount:10}]);
    assert.equal(response.status,409);
  });
  await scenario('registration-retained-policy', async () => {
    process.env.DATA_PRIMARY_BACKEND='sanity';
    state.documents.set('referral.fixture',{_id:'referral.fixture',_type:'referral',_rev:'r1',creatorEmail:baseAccount.primary_email,slug:{current:'fixture'},registrationStatus:'pending_email',registrationVerificationExpiresAt:new Date(Date.now()-60000).toISOString(),currentCommissionPercent:20,bypassUnlock:true});
    const response=await fetch(`${origin}/fixture/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Fixture User',email:baseAccount.primary_email,paypalEmail:'fixture-paypal@example.invalid',slug:'fixture',password})});
    await response.json();
    assert.equal(state.documents.get('referral.fixture')?.currentCommissionPercent,20);
    assert.equal(state.documents.get('referral.fixture')?.bypassUnlock,true);
    assert.equal(response.status,409);
  });
  for (const race of ['claim-wrong-owner', 'claim-reassigned']) {
    await scenario(`registration-${race}`, async () => {
      process.env.DATA_PRIMARY_BACKEND = 'sanity'; state.race = race;
      const identity = await import('../src/server/api/ref/referralIdentity.js');
      state.documents.set('referral.fixture',{_id:'referral.fixture',_type:'referral',_rev:'r1',creatorEmail:baseAccount.primary_email,slug:{current:'fixture'},registrationStatus:'pending_email',registrationVerificationExpiresAt:new Date(Date.now()-60000).toISOString()});
      const claim = identity.buildReferralIdentityClaim({kind:'email',value:baseAccount.primary_email,referralId:race==='claim-wrong-owner'?'referral.other':'referral.fixture'}); claim._rev='claim-r1'; state.documents.set(claim._id,claim);
      const response = await fetch(`${origin}/fixture/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Fixture User',email:baseAccount.primary_email,paypalEmail:'fixture-paypal@example.invalid',slug:'fixture',password})});
      await response.json();
      assert.equal(state.documents.get(claim._id)?.referral._ref,'referral.other');
      assert.equal(response.status,409);
      assert.equal(state.documents.get('referral.fixture')._rev,'r1');
    });
  }
  for (const race of ['cleanup', 'cleanup-commit', 'replacement']) {
    await scenario(`registration-${race}`, async () => {
      process.env.DATA_PRIMARY_BACKEND = race === 'replacement' ? 'supabase' : 'sanity';
      state.social = race === 'replacement'; state.race = race;
      state.documents.set('referral.fixture', { _id: 'referral.fixture', _type: 'referral', _rev: 'r1', creatorEmail: baseAccount.primary_email, slug: { current: 'fixture' }, registrationStatus: 'pending_email', registrationVerificationExpiresAt: new Date(Date.now() - 60_000).toISOString() });
      const response = await fetch(`${origin}/fixture/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fixture User', email: baseAccount.primary_email, paypalEmail: 'fixture-paypal@example.invalid', slug: 'fixture', password }) });
      const body = await response.json();
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(state.documents.get('referral.fixture').registrationStatus, 'active');
      assert.equal(state.documents.get('referral.fixture')._rev, 'r2');
      process.env.DATA_PRIMARY_BACKEND = 'sanity';
    });
  }
} finally {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  const evidence = { baseline, checkedAt: new Date().toISOString(), fixtureOrigin: origin, productionRequests: 0, scenarios: results, passed: results.every((result) => result.passed) };
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
if (!results.length || results.some((result) => !result.passed)) process.exitCode = 1;

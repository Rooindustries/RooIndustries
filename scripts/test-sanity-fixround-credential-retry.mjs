import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('@/')) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href; try { return next(specifier, context); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('.') || specifier.startsWith('file:')) && !path.extname(specifier)) return next(specifier + '.js', context); throw error; } } });
const R = p => pathToFileURL(path.join(root, p)).href;
const { start } = await import(R('scripts/lib/storage-fixture.mjs'));
const invoke = async (handler, body = {}, headers = {}, method = 'POST') => { const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } }; await handler({ method, body, headers: { 'x-forwarded-for': '127.0.0.1', ...headers }, query: {} }, response); return { status: response.statusCode, body: response.body, headers: response.headers }; };

const out = { steps: [], passed: false, sourceRepro: 'review-cred-stuck.mjs exact seed/failure/link/password order' };
let fixture;
try {
  for (const key of Object.keys(process.env)) if (/SANITY_|^(SUPABASE|NEXT_PUBLIC_|PAYPAL|RAZORPAY|DODO|COMMERCE_|DATA_|REF_|CRON_|RATE_LIMIT_|RESEND)/.test(key)) delete process.env[key];
  fixture = await start({ fullMigrationChain: true });
  Object.assign(process.env, { NODE_ENV: 'test', VERCEL_ENV: 'development', SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, SUPABASE_SECRET_KEY: fixture.token, SUPABASE_SERVICE_ROLE_KEY: fixture.token, DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '0', SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1', SUPABASE_PUBLISHABLE_KEY: fixture.anonKey, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fixture.anonKey, CMS_WRITES_PAUSED: '0', REF_SESSION_SECRET: 'synthetic-session', PAYMENT_SESSION_SECRET: 'synthetic-payment', HOLD_TOKEN_SECRET: 'synthetic-hold', UPGRADE_INTENT_SECRET: 'synthetic-upgrade', BOOKING_EMAIL_TOKEN_SECRET: 'synthetic-email', CRON_SECRET: 'synthetic-cron', RATE_LIMIT_HASH_SECRET: 'synthetic-rate-limit' });
  const { client, sql } = fixture;
  const { createDocumentWriteClient } = await import(R('src/server/data/documentClient.js'));
  const documents = createDocumentWriteClient();
  const { createRequire } = await import('node:module'); const req = createRequire(path.join(root, 'package.json')); const bcrypt = req('bcryptjs');
  const userId = crypto.randomUUID(), email = 'stuck-auth@example.invalid', code = 'stuckauth', id = 'referral.stuck-auth', initialPassword = 'InitialNativePassword123!', initialHash = await bcrypt.hash(initialPassword, 10);
  await sql`insert into auth.users(id,email,encrypted_password,email_confirmed_at) values(${userId},${email},${initialHash},now())`;
  assert.equal((await client.rpc('roo_bootstrap_native_account', { p_user_id: userId })).error, null);
  const [{ principal_id: principalId }] = await sql`select principal_id from accounts.principal_auth_users where user_id=${userId}`;
  await documents.create({ _id: id, _type: 'referral', creatorEmail: email, creatorPassword: initialHash, credentialVersion: 2, slug: { current: code }, registrationStatus: 'verified' });
  await sql`insert into accounts.account_roles(user_id,principal_id,role,source_backend,legacy_sanity_id) values(${userId},${principalId},'creator','supabase',${id})`;
  await sql`insert into accounts.creator_profiles(user_id,principal_id,referral_code,legacy_sanity_id,active) values(${userId},${principalId},${code},${id},true)`;
  await sql`insert into accounts.login_aliases(user_id,principal_id,alias_type,normalized_value,verified,legacy_sanity_id) values(${userId},${principalId},'referral_code',${code},true,${id})`;
  await sql`insert into accounts.login_aliases(user_id,principal_id,alias_type,normalized_value,verified,legacy_sanity_id) values(${userId},${principalId},'email',${email},true,${id})`;
  let updates = 0, failNext = true;
  const authUser = () => ({ id: userId, email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [] });
  fixture.setAuthHandler(async request => {
    if (request.method === 'PUT' && request.path === `/auth/v1/admin/users/${userId}`) {
      updates++;
      if (failNext) { failNext = false; return { status: 503, body: { msg: 'Synthetic transient Auth failure BEFORE applying (no DB change)' } }; }
      const hash = await bcrypt.hash(request.body.password, 10);
      await sql`update auth.users set encrypted_password=${hash},updated_at=now() where id=${userId}`;
      return { status: 200, body: authUser() };
    }
    if (request.path === '/auth/v1/user') return { status: 200, body: authUser() };
    if (request.path.startsWith('/auth/v1/logout')) return { status: 200, body: {} };
    throw new Error(`Unexpected synthetic Auth request ${request.method} ${request.path}`);
  });
  const resetToken = 'd'.repeat(64), resetHash = crypto.createHash('sha256').update(resetToken).digest('hex'), resetPassword = 'ResetNativePassword123!';
  let checkedSqlCalls=0;fixture.setRequestHook((phase,request)=>{if(phase==='before'&&request.path.startsWith('/rest/v1/rpc/')){checkedSqlCalls++;assert.equal(Object.hasOwn(request.body||{},'p_password'),false);for(const password of [initialPassword,resetPassword,'AnotherNativePassword123!'])assert.equal(JSON.stringify(request.body).includes(password),false);}});
  const current = await documents.getDocument(id);
  await documents.patch(id).ifRevisionId(current._rev).set({ resetTokenHash: resetHash, resetTokenExpiresAt: new Date(Date.now() + 3600000).toISOString() }).commit();
  const { default: reset } = await import(R('src/server/api/ref/reset.js'));
  const ops = async () => sql`select operation_key,status,attempt_count,last_error_code,source_recovery_blocked from accounts.credential_operations where user_id=${userId}`;
  const first = await invoke(reset, { token: resetToken, password: resetPassword });
  out.steps.push({ step: 'first reset (Auth PUT fails before applying)', status: first.status, body: first.body, authUpdates: updates, ops: await ops() });
  assert.equal(first.status,503); assert.equal(updates,1); assert.equal((await ops())[0].status,'prepared');
  if(process.argv.includes('--cron-before-retry')||process.argv.includes('--cron-backoff-before-retry')){const {reconcileCredentialOperations}=await import(R('src/server/supabase/credentialRecovery.js'));const backoff=await reconcileCredentialOperations({adminClient:client});assert.equal(backoff.backoff,1);assert.equal(updates,1);let skipped=await reconcileCredentialOperations({adminClient:client});assert.equal(skipped.checked,0);out.steps.push({step:'first no-plaintext cron5min backoff; repeat bounded',backoff,skipped,operations:await ops(),authUpdates:updates});if(process.argv.includes('--cron-before-retry')){await sql`update accounts.credential_operations set next_retry_at=now()-interval '1 second' where user_id=${userId} and status='prepared'`;const parked=await reconcileCredentialOperations({adminClient:client});assert.equal(parked.parked,1);const [state]=await ops();assert.equal(state.source_recovery_blocked,true);assert.equal(state.last_error_code,'CREDENTIAL_AUTH_PLAINTEXT_REQUIRED');skipped=await reconcileCredentialOperations({adminClient:client});assert.equal(skipped.checked,0);assert.equal(updates,1);out.steps.push({step:'second eligible cron parks missing plaintext; repeats bounded',schedulingTimeControl:'Only next_retry_at moved past in synthetic fixture;5min eligibility predicate exercised',parked,skipped,state,authUpdates:updates});}}

  const wrong = await invoke(reset,{token:resetToken,password:'AnotherNativePassword123!'}); assert.equal(wrong.status,409); assert.equal(updates,1); assert.equal((await ops())[0].status,'prepared'); out.steps.push({step:'different password while prepared refuses',status:wrong.status,authUpdates:updates});
  const retry = await invoke(reset, { token: resetToken, password: resetPassword });
  out.steps.push({ step: 'retry same link + same password', status: retry.status, body: retry.body, authUpdates: updates, ops: await ops() });
  assert.equal(retry.status,200); assert.equal(updates,2); assert.equal((await ops())[0].status,'mirrored');
  const retry2 = await invoke(reset, { token: resetToken, password: resetPassword });
  out.steps.push({ step: 'retry again', status: retry2.status, body: retry2.body, authUpdates: updates, ops: await ops() });
  assert.equal(updates,2);
  // New reset link afterwards (user requests forgot-password again)
  const token2 = 'e'.repeat(64), hash2 = crypto.createHash('sha256').update(token2).digest('hex');
  const cur2 = await documents.getDocument(id);
  await documents.patch(id).ifRevisionId(cur2._rev).set({ resetTokenHash: hash2, resetTokenExpiresAt: new Date(Date.now() + 3600000).toISOString() }).commit();
  const fresh = await invoke(reset, { token: token2, password: 'AnotherNativePassword123!' });
  out.steps.push({ step: 'NEW reset link + new password after stuck prepared op', status: fresh.status, body: fresh.body, authUpdates: updates, ops: await ops() });
  assert.equal(fresh.status,200); assert.equal(updates,3);
  // Cron
  const { reconcileCredentialOperations } = await import(R('src/server/supabase/credentialRecovery.js'));
  const cron = await reconcileCredentialOperations({ adminClient: client });
  out.steps.push({ step: 'cron reconcileCredentialOperations', cron, ops: await ops() });
  const [authRow] = await sql`select encrypted_password from auth.users where id=${userId}`;
  out.authStillInitialPassword = await bcrypt.compare(initialPassword, authRow.encrypted_password); assert.equal(out.authStillInitialPassword,false); assert.ok(checkedSqlCalls>0);out.plaintextSqlParameters={checkedCalls:checkedSqlCalls,plaintextFound:false};out.passed=true;
} catch (error) {
  out.error = { message: error.message, stack: error.stack };
} finally {
  const stopped = await fixture?.stop?.();
  out.stopped = stopped;
}
fs.mkdirSync('test-results/sanity-fixround',{recursive:true}); fs.writeFileSync(`test-results/sanity-fixround/R1-credential-retry${process.argv.includes('--cron-before-retry')?'-cron':process.argv.includes('--cron-backoff-before-retry')?'-cron-backoff':''}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2)); if(!out.passed)process.exitCode=1;

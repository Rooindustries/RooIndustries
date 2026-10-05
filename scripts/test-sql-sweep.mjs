const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL?.startsWith('file:')) throw error;
    for (const suffix of ['.js', '/index.js']) { const candidate = new URL(specifier + suffix, context.parentURL); if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context); }
    throw error;
  }
} });

const root = path.resolve(new URL('..', import.meta.url).pathname);
const baseline = process.argv.includes('--baseline');
const currencyBaseline=process.argv.includes('--currency-baseline');
const currencySources=currencyBaseline?JSON.parse(fs.readFileSync(path.join(root,'test-results/currency-authority-before-source.json'),'utf8')):{};
const fixBBefore=process.argv.includes('--fix-b-before');
const fixBSources=fixBBefore?JSON.parse(fs.readFileSync(path.join(root,'test-results/fix-b-before-source.json'),'utf8')):{};
const missingCreatorSource=process.argv.includes('--missing-creator-before')?JSON.parse(fs.readFileSync(path.join(root,'test-results/fix-b-document-missing-before-source.json'),'utf8')):null;
if (fixBBefore || missingCreatorSource) {
  for (const saved of Object.values(fixBSources)) assert.equal(crypto.createHash('sha256').update(saved.source).digest('hex'), saved.sha256);
  if (missingCreatorSource) assert.equal(crypto.createHash('sha256').update(missingCreatorSource.source).digest('hex'), missingCreatorSource.sha256);
  registerHooks({ load(url, context, nextLoad) {
    if (url === new URL('../src/server/supabase/documentClient.js', import.meta.url).href) {
      return { format: 'module', source: missingCreatorSource?.source || fixBSources['src/server/supabase/documentClient.js'].source, shortCircuit: true };
    }
    return nextLoad(url, context);
  } });
}
const expiryClockBefore=process.argv.includes('--expiry-clock-before');
const expiryClockSource=expiryClockBefore?JSON.parse(fs.readFileSync(path.join(root,'test-results/fix-b-expiry-clock-before-source.json'),'utf8')):null;
const migrationText=name=>{if(expiryClockBefore&&name.includes('activation_replay_entitlements')){assert.equal(crypto.createHash('sha256').update(expiryClockSource.source).digest('hex'),expiryClockSource.sha256);return expiryClockSource.source;}if(fixBBefore&&fixBSources[`supabase/migrations/${name}`])return fixBSources[`supabase/migrations/${name}`].source;const saved=currencyBaseline&&name.includes('currency_subunits')?currencySources[`supabase/migrations/${name}`]:null;if(saved){assert.equal(crypto.createHash('sha256').update(saved.source).digest('hex'),saved.sha256);return saved.source;}return fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8');};
const compatibilityOption = process.argv.find(value => value === '--compatibility' || value.startsWith('--compatibility='));
const prepareCompatibility = process.argv.includes('--prepare-compatibility');
const compatibilityMode = Boolean(compatibilityOption || prepareCompatibility);
assert.ok(!compatibilityMode || !baseline, 'Compatibility preparation requires the current complete schema.');
const inventory = process.argv.includes('--inventory') || compatibilityMode;
const selected = compatibilityMode ? [] : process.argv.find(value => value.startsWith('--scenario='))?.slice(11).split(',');
const artifact = path.resolve(process.env.ROO_SQL_SWEEP_ARTIFACT || 'test-results/sql-sweep.json');
const repairNames = ['20261005000100_recheck_activation_replay_entitlements.sql', '20261005000200_refuse_missing_document_mutation_operations.sql', '20261005000300_preserve_refund_projection_payment_binding.sql', '20261005000400_bound_expired_commerce_mirror_leases.sql', '20261005000500_project_booking_payment_currency_subunits.sql'];
const allowedOrigins = new Set();
const fetchBefore = globalThis.fetch;
const dispatcherBefore = getGlobalDispatcher();
let bootstrapping = true;
const checkOrigin = value => {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, testHost);
  assert.ok(url.port && !url.username && !url.password);
  assert.ok(allowedOrigins.has(url.origin), `Non-owned HTTP origin refused: ${url.origin}`);
};
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (bootstrapping && url.protocol === 'http:' && url.hostname === testHost && url.port && url.pathname === '/' && !url.username && !url.password) allowedOrigins.add(url.origin);
  checkOrigin(url);
  return fetchBefore(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), init?.signal].filter(Boolean)) });
};
setGlobalDispatcher({ dispatch(options, handler) { checkOrigin(options.origin); return dispatcherBefore.dispatch(options, handler); } });
for (const name of Object.keys(process.env)) if (/^(SUPABASE|SANITY|REACT_APP_|NEXT_PUBLIC_|RESEND|BLOB_|VERCEL_OIDC|ALLOW_LIVE_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|NODE_USE_ENV_PROXY)/.test(name)) delete process.env[name];
Object.assign(process.env, { NODE_ENV: 'test', VERCEL_ENV: 'development', DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase' });
const evidence = { baseline, checkedAt: new Date().toISOString(), scenarios: [], productionRequests: 0, standIns: [
  'Synthetic local Auth/storage tables and fixed fixture JWT; hosted GoTrue/token issuance/schema/migration ledger are unproved.',
  'Shared fixture broad service-role privileges; effective security inventory uses a separate full-history database and actual checked-in grants/RLS.',
  'Local SQL writes seed synthetic state changes; actual PostgreSQL17 constraints/locks/transactions, current functions and Supabase SDK/PostgREST16.4 HTTP execute without persistence replacements.'
] };
let fixture;
let historySql;
let compatibilityRelay;
const relaySockets = new Set();
const run = async (name, fn) => {
  if (selected && !selected.includes(name)) return;
  const proof = {};
  try { await fn(proof); evidence.scenarios.push({ name, passed: true, proof }); }
  catch (error) { evidence.scenarios.push({ name, passed: false, error: error.message, code: error.code, proof }); }
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
try {
  const { createSweepPostgresFixture, functionDefinition } = await import('./lib/sweep-postgres-fixture.mjs');
  fixture = await createSweepPostgresFixture();
  allowedOrigins.add(fixture.origin);
  bootstrapping = false;
  const { sql, client } = fixture;
  const base = '20260710211428_add_account_and_licensing_rpc.sql';
  for (const name of ['public.roo_claim_entitlement', 'public.roo_activate_device', 'public.roo_revoke_device', 'public.roo_entitlement_status']) await fixture.apply(base, functionDefinition(base, name), name);
  await fixture.apply('20260710224035_harden_licensing_idempotency.sql');
  await fixture.apply('20260718012000_require_active_licensing_principals.sql');
  const unified='20260712092342_close_supabase_port_and_unified_auth.sql';
  for(const name of ['public.roo_claim_commerce_mirror_events','public.roo_complete_commerce_mirror_event'])await fixture.apply(unified,functionDefinition(unified,name),name);
  const originals = await sql`select p.oid::regprocedure::text signature, pg_get_functiondef(p.oid) definition, p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='licensing' and p.proname='roo_activate_device_without_principal_check') or (n.nspname='migration' and p.proname in ('roo_apply_commerce_document_mutations_unbounded','project_commerce_document_ids_unserialized','project_commerce_extensions')) or (n.nspname='public' and p.proname in ('roo_apply_document_mutations','roo_apply_commerce_document_mutations','roo_claim_commerce_mirror_events','roo_complete_commerce_mirror_event','roo_project_operational_shadow','roo_fetch_recovery_payment_documents'))`;
  const rollbackPath = path.join(fixture.scratch, 'sql-sweep-rollback-definitions.sql');
  const refundRollback='drop trigger if exists preserve_refund_payment_binding on commerce.refunds;\ndrop function if exists commerce.preserve_refund_payment_binding();\ndrop function if exists migration.booking_currency(jsonb,text);\ndrop function if exists migration.payment_currency(jsonb,jsonb);\ndrop function if exists migration.resolve_currency(jsonb);\ndrop function if exists migration.money_subunits(text,text);\n';
  fs.writeFileSync(rollbackPath, originals.map(row => row.definition).join('\n')+'\n'+refundRollback);
  evidence.originalDefinitions = originals.map(({signature, definition, acl}) => ({signature, sha256:hash(definition), acl}));
  evidence.rollbackDefinitions = rollbackPath;
  if (!baseline) for (const name of repairNames) await sql.begin(tx => tx.unsafe(migrationText(name)));
  await sql`notify pgrst,'reload schema'`;
  for (let attempt=0;attempt<100;attempt++) {
    const result=await client.rpc('roo_entitlement_status',{p_user_id:'10000000-0000-4000-8000-000000000099'});
    if (result.error?.code !== 'PGRST202') { assert.equal(result.error?.code,'P0002'); break; }
    assert.ok(attempt<99); await new Promise(resolve=>setTimeout(resolve,50));
  }
  const seedLicense = async () => {
    const userId=crypto.randomUUID(), otherUserId=crypto.randomUUID(), entitlementId=crypto.randomUUID(), productId=crypto.randomUUID();
    for (const id of [userId,otherUserId]) {
      const principalId=crypto.randomUUID();
      await sql`insert into auth.users(id,email) values (${id},${`${id}@fixture.invalid`})`;
      await sql`insert into accounts.principals(id,status) values (${principalId},'active')`;
      await sql`insert into accounts.principal_auth_users(principal_id,user_id,is_primary,verified_at,source) values (${principalId},${id},true,now(),'migration')`;
    }
    await sql`insert into licensing.products(id,sku,name) values (${productId},${`fixture-${productId.slice(0,8)}`},'Fixture')`;
    await sql`insert into licensing.entitlements(id,product_id,user_id,buyer_email,purchase_backend,purchase_reference,status) values (${entitlementId},${productId},${userId},${`${userId}@fixture.invalid`},'manual',${entitlementId},'active')`;
    return {userId,otherUserId,entitlementId,params:{p_user_id:userId,p_entitlement_id:entitlementId,p_device_fingerprint_hmac:'a'.repeat(64),p_request_id:`fixture:${crypto.randomUUID()}`,p_device_label:'Fixture',p_app_version:'1'}};
  };
  const licenseState=async id=>{
    const [row]=await sql`select jsonb_build_object('entitlement',(select to_jsonb(e) from licensing.entitlements e where e.id=${id}),'activations',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from licensing.device_activations a where a.entitlement_id=${id}),'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') from licensing.activation_events e where e.entitlement_id=${id})) state`;
    return row.state;
  };
  for (const expiry of ['past', 'null', 'future']) for (const mode of ['replay', 'heartbeat', 'initial']) await run(`activation-expiry-${expiry}-${mode}`, async proof => {
    const seeded = await seedLicense();
    if (mode !== 'initial') assert.equal((await client.rpc('roo_activate_device', seeded.params)).error, null);
    if (expiry === 'past') await sql`update licensing.entitlements set expires_at=now()-interval '1 second' where id=${seeded.entitlementId}`;
    else if (expiry === 'future') await sql`update licensing.entitlements set expires_at=now()+interval '1 day' where id=${seeded.entitlementId}`;
    proof.before = await licenseState(seeded.entitlementId);
    proof.databaseTime = (await sql`select now() as now`)[0].now;
    const params = mode === 'heartbeat' ? {...seeded.params, p_request_id: `fixture:${crypto.randomUUID()}`} : seeded.params;
    proof.response = await client.rpc('roo_activate_device', params);
    proof.after = await licenseState(seeded.entitlementId);
    if (expiry === 'past') { assert.equal(proof.response.error?.code, 'P0002'); assert.deepEqual(proof.after, proof.before); }
    else { assert.equal(proof.response.error, null); assert.equal(proof.response.data.status, 'active'); assert.equal(proof.after.activations.length, 1); if (mode === 'replay') assert.deepEqual(proof.after, proof.before); }
  });
  await run('activation-expiry-during-locked-initial', async proof => {
    const seeded=await seedLicense();
    let release, acquired;
    const ready=new Promise(resolve=>{acquired=resolve;});
    const held=sql.begin(async tx=>{
      const [row]=await tx`update licensing.entitlements set expires_at=clock_timestamp()+interval '600 milliseconds' where id=${seeded.entitlementId} returning expires_at`;
      proof.expiry=row.expires_at;acquired();await new Promise(resolve=>{release=resolve;});
    });
    await ready;
    let settled=false;
    const pending=Promise.resolve(client.rpc('roo_activate_device',seeded.params)).then(result=>{settled=true;return result;});
    try {
      for(let attempt=0;attempt<100;attempt++){
        const [row]=await sql`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%roo_activate_device%') blocked,clock_timestamp() now`;
        if(row.blocked)proof.blocked=true;
        if(proof.blocked&&new Date(row.now)>=new Date(proof.expiry)){proof.releaseTime=row.now;break;}
        assert.ok(!settled);assert.ok(attempt<99);await new Promise(resolve=>setTimeout(resolve,20));
      }
      release();await held;
      proof.before=await licenseState(seeded.entitlementId);
      proof.response=await pending;proof.after=await licenseState(seeded.entitlementId);
      assert.equal(proof.blocked,true);assert.ok(new Date(proof.releaseTime)>=new Date(proof.expiry));assert.equal(proof.response.error?.code,'P0002');assert.deepEqual(proof.after,proof.before);assert.equal(proof.after.activations.length,0);
    }finally{release();await held;}
  });
  await run('activation-expiry-exact-database-now', async proof => {
    const seeded = await seedLicense();
    await sql.begin(async tx => {
      await tx`update licensing.entitlements set expires_at=now() where id=${seeded.entitlementId}`;
      const result = await tx.savepoint(async sp => { try { await sp`select public.roo_activate_device(${seeded.userId}::uuid,${seeded.entitlementId}::uuid,${seeded.params.p_device_fingerprint_hmac},${seeded.params.p_request_id},'Fixture','1')`; return {code:null}; } catch(error) { throw error; } }).catch(error=>({code:error.code}));
      proof.response = result; assert.equal(result.code, 'P0002');
      proof.activations = (await tx`select count(*)::int count from licensing.device_activations where entitlement_id=${seeded.entitlementId}`)[0].count; assert.equal(proof.activations, 0);
    });
  });
  for (const scenario of ['existing', 'existing-newer-writer', 'missing', 'missing-newer-writer']) await run(`document-create-if-missing-delete-${scenario}`, async proof => {
    const {createSupabaseDocumentClient} = await import('../src/server/supabase/documentClient.js');
    const documents = createSupabaseDocumentClient({shadowClient:client});
    const id = `sql.${crypto.randomUUID()}`;
    const document = {_id:id,_type:'hero',title:'original'};
    if (scenario.startsWith('existing')) await documents.create(document);
    const rows = async () => (await sql`select to_jsonb(s) row from migration.source_documents s where legacy_sanity_id=${id}`).map(value=>value.row);
    proof.before = await rows();
    let raced = false;
    fixture.setRequestHook(async (phase, request) => {
      if (scenario.endsWith('newer-writer') && !raced && phase === 'after' && request.path.includes('/rpc/roo_fetch_shadow_documents') && request.body?.p_ids?.includes(id)) {
        raced = true;
        fixture.setRequestHook(null);
        if (scenario.startsWith('missing')) await documents.create({...document,title:'newer'});
        else await documents.patch(id).set({title:'newer'}).commit();
        proof.newer = await rows();
      }
    });
    try { proof.response = await documents.transaction().createIfNotExists(document).delete(id).commit(); } catch (error) { proof.error={code:error.code,status:error.statusCode}; }
    finally { fixture.setRequestHook(null); }
    proof.after = await rows();
    if (scenario.endsWith('newer-writer')) { assert.equal(raced,true); assert.equal(proof.error?.code,scenario.startsWith('missing')?'23505':'40001'); assert.deepEqual(proof.after,proof.newer); }
    else { assert.equal(proof.error,undefined); assert.deepEqual(proof.after,[]); }
  });
  for (const state of ['revoked','refunded','suspended','unclaimed','reassigned']) await run(`activation-replay-${state}`,async proof=>{
    const seeded=await seedLicense();
    const first=await client.rpc('roo_activate_device',seeded.params); assert.equal(first.error,null); assert.equal(first.data.status,'active');
    if (state==='reassigned') await sql`update licensing.entitlements set user_id=${seeded.otherUserId} where id=${seeded.entitlementId}`;
    else await sql`update licensing.entitlements set status=${state} where id=${seeded.entitlementId}`;
    proof.before=await licenseState(seeded.entitlementId);
    const result=await client.rpc('roo_activate_device',seeded.params); proof.response=result;
    proof.after=await licenseState(seeded.entitlementId);
    assert.equal(result.error?.code,'P0002'); assert.deepEqual(proof.after,proof.before);
  });
  await run('activation-current-identical-replay',async proof=>{
    const seeded=await seedLicense(); const first=await client.rpc('roo_activate_device',seeded.params); assert.equal(first.error,null);
    proof.before=await licenseState(seeded.entitlementId); const replay=await client.rpc('roo_activate_device',seeded.params); proof.response=replay;
    assert.equal(replay.error,null); assert.equal(replay.data.status,'active'); assert.equal(replay.data.idempotent_replay,true); assert.equal(replay.data.activation_id,first.data.activation_id);
    proof.after=await licenseState(seeded.entitlementId); assert.deepEqual(proof.after,proof.before);
  });
  await run('activation-changed-fingerprint-refused',async proof=>{
    const seeded=await seedLicense(); assert.equal((await client.rpc('roo_activate_device',seeded.params)).error,null);
    proof.before=await licenseState(seeded.entitlementId); const result=await client.rpc('roo_activate_device',{...seeded.params,p_device_fingerprint_hmac:'b'.repeat(64)}); proof.response=result;
    assert.equal(result.error?.code,'23505'); proof.after=await licenseState(seeded.entitlementId); assert.deepEqual(proof.after,proof.before);
  });
  await run('activation-replay-foreign-entitlement-device-refused',async proof=>{
    const first=await seedLicense(),other=await seedLicense();
    assert.equal((await client.rpc('roo_activate_device',first.params)).error,null);
    const activated=await client.rpc('roo_activate_device',other.params);assert.equal(activated.error,null);
    await sql`update licensing.activation_events set activation_id=${activated.data.activation_id} where request_id=${first.params.p_request_id}`;
    proof.before={first:await licenseState(first.entitlementId),other:await licenseState(other.entitlementId)};
    proof.response=await client.rpc('roo_activate_device',first.params);
    proof.after={first:await licenseState(first.entitlementId),other:await licenseState(other.entitlementId)};
    assert.equal(proof.response.error?.code,'23505');assert.deepEqual(proof.after,proof.before);
  });
  await run('activation-revoked-fresh-request-refused',async proof=>{
    const seeded=await seedLicense(); await sql`update licensing.entitlements set status='revoked' where id=${seeded.entitlementId}`;
    proof.before=await licenseState(seeded.entitlementId); const result=await client.rpc('roo_activate_device',seeded.params); proof.response=result;
    assert.equal(result.error?.code,'P0002'); proof.after=await licenseState(seeded.entitlementId); assert.deepEqual(proof.after,proof.before);
  });
  for (const mode of ['replay','fresh']) await run(`activation-null-fingerprint-${mode}`,async proof=>{
    const seeded=await seedLicense();
    if (mode==='replay') assert.equal((await client.rpc('roo_activate_device',seeded.params)).error,null);
    proof.before=await licenseState(seeded.entitlementId);
    const result=await client.rpc('roo_activate_device',{...seeded.params,p_device_fingerprint_hmac:null});proof.response=result;
    proof.after=await licenseState(seeded.entitlementId);assert.equal(result.error?.code,'22023');assert.deepEqual(proof.after,proof.before);
  });
  await run('activation-replay-waits-for-current-revocation',async proof=>{
    const seeded=await seedLicense();assert.equal((await client.rpc('roo_activate_device',seeded.params)).error,null);
    let release, acquired;const acquiredPromise=new Promise(resolve=>{acquired=resolve;});
    const held=sql.begin(async tx=>{await tx`update licensing.entitlements set status='revoked' where id=${seeded.entitlementId}`;acquired();await new Promise(resolve=>{release=resolve;});});
    await acquiredPromise;
    let settled=false;const replay=Promise.resolve(client.rpc('roo_activate_device',seeded.params)).then(result=>{settled=true;return result;});
    try {
      let blocked=false;
      for(let attempt=0;attempt<100&&!settled;attempt++) {
        const [row]=await sql`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%roo_activate_device%') blocked`;
        if(row.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
      }
      proof.blockedOnCurrentEntitlement=blocked;release();await held;
      const result=await replay;proof.response=result;proof.after=await licenseState(seeded.entitlementId);
      assert.equal(result.error?.code,'P0002');assert.equal(blocked,true);assert.equal(proof.after.entitlement.status,'revoked');assert.equal(proof.after.events.length,1);
    } finally {release();await held;}
  });
  const mutationState=async ids=>{
    const [row]=await sql`select jsonb_build_object('source',(select coalesce(jsonb_agg(to_jsonb(s) order by s.legacy_sanity_id),'[]') from migration.source_documents s where s.legacy_sanity_id=any(${ids})),'cms',(select coalesce(jsonb_agg(to_jsonb(d) order by d.legacy_sanity_id),'[]') from cms.documents d where d.legacy_sanity_id=any(${ids})),'coupons',(select coalesce(jsonb_agg(to_jsonb(c) order by c.legacy_sanity_id),'[]') from commerce.coupons c where c.legacy_sanity_id=any(${ids})),'commands',(select count(*) from migration.commerce_commands),'commerceOutbox',(select count(*) from migration.commerce_mirror_outbox),'globalOutbox',(select count(*) from migration.document_mutation_mirror_outbox)) state`;
    return row.state;
  };
  const mutate=async(domain,commandId,mutations)=>client.rpc(domain==='commerce'?'roo_apply_commerce_document_mutations':'roo_apply_document_mutations',domain==='commerce'?{p_command_id:commandId,p_mutations:mutations,p_cutover_generation:0}:{p_mutations:mutations});
  for (const domain of ['commerce','global']) for (const value of ['absent','null']) for (const mode of ['new','existing','partial']) await run(`mutation-${domain}-${value}-${mode}`,async proof=>{
    const id=`sql.${crypto.randomUUID()}`, companion=`sql.${crypto.randomUUID()}`;
    const document={_id:id,_type:domain==='commerce'?'coupon':'siteSettings',code:id.replaceAll('.','-').slice(0,60),title:'after',isActive:true};
    if (mode==='existing') assert.equal((await mutate(domain,`fixture:${crypto.randomUUID()}`,[{operation:'create',document:{...document,title:'before'}}])).error,null);
    const invalid={id,document,...(value==='null'?{operation:null}:{})};
    const mutations=mode==='partial'?[{operation:'create',document:{...document,_id:companion,code:`companion-${companion.slice(-8)}`}},invalid]:[invalid];
    proof.input=mutations; proof.before=await mutationState([id,companion]);
    const result=await mutate(domain,`fixture:${crypto.randomUUID()}`,mutations); proof.response=result; proof.after=await mutationState([id,companion]);
    assert.equal(result.error?.code,'22023'); assert.deepEqual(proof.after,proof.before);
  });
  await run('commerce-same-key-different-content-refused',async proof=>{
    const id=`sql.${crypto.randomUUID()}`, command=`fixture:${crypto.randomUUID()}`;
    const initial=[{operation:'create',document:{_id:id,_type:'coupon',code:id.slice(-12),title:'before'}}];
    const first=await mutate('commerce',command,initial); assert.equal(first.error,null); proof.before=await mutationState([id]);
    const replay=await mutate('commerce',command,initial); assert.equal(replay.error,null); assert.deepEqual(replay.data,first.data);
    const different=await mutate('commerce',command,[{operation:'create',document:{...initial[0].document,title:'after'}}]); proof.response=different;
    assert.equal(different.error?.code,'23505'); proof.after=await mutationState([id]); assert.deepEqual(proof.after,proof.before);
  });
  await run('commerce-mirror-twelve-expired-leases-terminal',async proof=>{
    const id=`sql.${crypto.randomUUID()}`;
    const created=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:{_id:id,_type:'coupon',code:id.slice(-12)}}]);assert.equal(created.error,null);
    const eventKey=created.data.event_key;
    const [stored]=await sql`select to_jsonb(row_data) row from migration.commerce_mirror_outbox row_data where event_key=${eventKey}`;proof.before=stored.row;
    proof.scans=[];
    for(let attempt=1;attempt<=13;attempt++) {
      const claimed=await client.rpc('roo_claim_commerce_mirror_events',{p_lease_id:`fixture:lease:${attempt}`,p_limit:100,p_force:true});assert.equal(claimed.error,null);
      const event=claimed.data.find(row=>row.event_key===eventKey);proof.scans.push({attempt,event:event||null});
      if(attempt<=12){assert.ok(event);assert.equal(event.attempt_count,attempt);await sql`update migration.commerce_mirror_outbox set lease_expires_at=now()-interval '1 second' where event_key=${eventKey}`;}
      else assert.equal(event,undefined);
    }
    const [after]=await sql`select status,attempt_count,lease_id,lease_expires_at,next_attempt_at,last_error_code,documents,deleted_ids,delete_guards,canonical_hash,cutover_generation from migration.commerce_mirror_outbox where event_key=${eventKey}`;proof.after=after;
    assert.equal(after.status,'dead_letter');assert.equal(after.attempt_count,12);assert.equal(after.lease_id,null);assert.equal(after.lease_expires_at,null);assert.equal(after.next_attempt_at,null);assert.equal(after.last_error_code,'LEASE_EXPIRED_MAX_ATTEMPTS');
    const [terminal]=await sql`select to_jsonb(row_data) row from migration.commerce_mirror_outbox row_data where event_key=${eventKey}`;proof.terminal=terminal.row;
    for(const field of Object.keys(stored.row))if(!['status','attempt_count','lease_id','lease_expires_at','next_attempt_at','last_error_code'].includes(field))assert.deepEqual(terminal.row[field],stored.row[field]);
    proof.lateCompletion=await client.rpc('roo_complete_commerce_mirror_event',{p_event_key:eventKey,p_lease_id:'fixture:lease:12',p_success:true});assert.equal(proof.lateCompletion.error?.code,'40001');
    const [unchanged]=await sql`select to_jsonb(row_data) row from migration.commerce_mirror_outbox row_data where event_key=${eventKey}`;assert.equal(unchanged.row.status,'dead_letter');assert.equal(unchanged.row.attempt_count,12);
    proof.ownerRequeue=await client.rpc('roo_requeue_commerce_mirror_event',{p_event_key:eventKey,p_expected_attempt_count:12,p_reason:'Fixture owner requeue'});assert.equal(proof.ownerRequeue.error,null);assert.equal(proof.ownerRequeue.data.status,'retry');
    const retried=await client.rpc('roo_claim_commerce_mirror_events',{p_lease_id:'fixture:owner-requeue',p_limit:100,p_force:true});assert.equal(retried.error,null);assert.equal(retried.data.find(row=>row.event_key===eventKey)?.attempt_count,13);
  });
  await run('commerce-mirror-null-completion-owner-refused',async proof=>{
    const id=`sql.${crypto.randomUUID()}`;
    const created=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:{_id:id,_type:'coupon',code:id.slice(-12)}}]);assert.equal(created.error,null);
    const eventKey=created.data.event_key;
    await sql`update migration.commerce_mirror_outbox set status='dead_letter',attempt_count=12,lease_id=null,lease_expires_at=null where event_key=${eventKey}`;
    const state=async()=>{const [row]=await sql`select jsonb_build_object('event',(select to_jsonb(event) from migration.commerce_mirror_outbox event where event.event_key=${eventKey}),'checkpoints',(select coalesce(jsonb_agg(to_jsonb(checkpoint)),'[]') from migration.commerce_mirror_checkpoints checkpoint),'mirrorState',(select to_jsonb(mirror) from migration.commerce_mirror_state mirror where singleton)) state`;return row.state;};
    proof.before=await state();proof.response=await client.rpc('roo_complete_commerce_mirror_event',{p_event_key:eventKey,p_lease_id:null,p_success:true});proof.after=await state();
    assert.equal(proof.response.error?.code,'22023');assert.deepEqual(proof.after,proof.before);
  });
  await run('commerce-mirror-null-completion-success-refused',async proof=>{
    const id=`sql.${crypto.randomUUID()}`;
    const created=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:{_id:id,_type:'coupon',code:id.slice(-12)}}]);assert.equal(created.error,null);
    const eventKey=created.data.event_key;
    await sql`update migration.commerce_mirror_outbox set status='processing',attempt_count=1,lease_id='fixture:null-success',lease_expires_at=now()+interval '2 minutes' where event_key=${eventKey}`;
    const state=async()=>{const [row]=await sql`select to_jsonb(event) row from migration.commerce_mirror_outbox event where event.event_key=${eventKey}`;return row.row;};
    proof.before=await state();proof.response=await client.rpc('roo_complete_commerce_mirror_event',{p_event_key:eventKey,p_lease_id:'fixture:null-success',p_success:null});proof.after=await state();
    assert.equal(proof.response.error?.code,'22023');assert.deepEqual(proof.after,proof.before);
  });
  const paymentDocument=(id,provider,refundId,amount)=>({_id:id,_type:'paymentRecord',provider,status:'failed',sessionScope:id,providerIdempotencyKey:id,providerOrderId:`order-${id}`,providerPaymentId:`payment-${id}`,pricingSnapshot:{netAmount:9.99,currency:'USD'},refunds:refundId?[{_key:refundId,providerRefundId:refundId,amountInSubunits:amount,currency:'USD',status:'processed',eventType:'refund.processed'}]:[]});
  const refundRows=id=>sql`select to_jsonb(r) row from commerce.refunds r where provider_refund_id=${id} order by provider`;
  for(const provider of ['paypal','razorpay','dodo']) await run(`refund-${provider}-cross-payment-binding-refused`,async proof=>{
    const firstId=`sql.${crypto.randomUUID()}`,secondId=`sql.${crypto.randomUUID()}`,refundId=`refund-${crypto.randomUUID()}`;
    assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:paymentDocument(firstId,provider,refundId,100)}])).error,null);
    assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:paymentDocument(secondId,provider)}])).error,null);
    const [source]=await sql`select source_revision from migration.source_documents where legacy_sanity_id=${secondId}`;
    proof.before={state:await mutationState([firstId,secondId]),refunds:await refundRows(refundId)};
    const result=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'replace',id:secondId,expected_revision:source.source_revision,document:paymentDocument(secondId,provider,refundId,200)}]);proof.response=result;
    proof.after={state:await mutationState([firstId,secondId]),refunds:await refundRows(refundId)};
    assert.equal(result.error?.code,'23505');assert.deepEqual(proof.after,proof.before);
  });
  await run('refund-same-payment-status-refresh-and-rebuild',async proof=>{
    const id=`sql.${crypto.randomUUID()}`,refundId=`refund-${crypto.randomUUID()}`;
    const document=paymentDocument(id,'dodo',refundId,100);document.refunds[0].status='pending';
    assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document}])).error,null);
    const [source]=await sql`select source_revision from migration.source_documents where legacy_sanity_id=${id}`;
    document.refunds[0].status='processed';
    const result=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'replace',id,expected_revision:source.source_revision,document}]);assert.equal(result.error,null);
    const normalize=rows=>rows.map(({row})=>({id:row.id,payment_record_id:row.payment_record_id,provider:row.provider,provider_refund_id:row.provider_refund_id,status:row.status,amount_subunits:row.amount_subunits,currency:row.currency,payload:row.payload}));
    proof.incremental=normalize(await refundRows(refundId));assert.equal(proof.incremental[0].status,'completed');assert.equal(proof.incremental[0].amount_subunits,100);
    assert.equal((await client.rpc('roo_refresh_operational_shadow')).error,null);
    proof.rebuild=normalize(await refundRows(refundId));assert.deepEqual(proof.rebuild,proof.incremental);
  });
  await run('refund-concurrent-new-owners-refused',async proof=>{
    const firstId=`sql.${crypto.randomUUID()}`,secondId=`sql.${crypto.randomUUID()}`,refundId=`refund-${crypto.randomUUID()}`;
    for(const id of [firstId,secondId]) assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:paymentDocument(id,'paypal')}])).error,null);
    const [firstSource]=await sql`select source_revision from migration.source_documents where legacy_sanity_id=${firstId}`;
    const [secondSource]=await sql`select source_revision from migration.source_documents where legacy_sanity_id=${secondId}`;
    let release,acquired;const ready=new Promise(resolve=>{acquired=resolve;});
    const held=sql.begin(async tx=>{
      const result=await tx`select public.roo_apply_commerce_document_mutations(${`fixture:${crypto.randomUUID()}`},${tx.json([{operation:'replace',id:firstId,expected_revision:firstSource.source_revision,document:paymentDocument(firstId,'paypal',refundId,100)}])},0) result`;
      proof.firstResponse=result[0].result;acquired();await new Promise(resolve=>{release=resolve;});
    });await ready;
    let settled=false;const pending=Promise.resolve(mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'replace',id:secondId,expected_revision:secondSource.source_revision,document:paymentDocument(secondId,'paypal',refundId,200)}])).then(result=>{settled=true;return result;});
    try {
      let blocked=false;for(let attempt=0;attempt<100&&!settled;attempt++){const [row]=await sql`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%roo_apply_commerce_document_mutations%') blocked`;if(row.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
      proof.blockedUntilFirstCommit=blocked;release();await held;proof.response=await pending;proof.refunds=await refundRows(refundId);
      const [secondAfter]=await sql`select source_revision,payload from migration.source_documents where legacy_sanity_id=${secondId}`;proof.secondAfter=secondAfter;
      assert.equal(proof.response.error?.code,'23505');assert.equal(blocked,true);assert.equal(proof.refunds[0].row.amount_subunits,100);assert.equal(secondAfter.source_revision,secondSource.source_revision);assert.deepEqual(secondAfter.payload.refunds,[]);
    }finally{release();await held;}
  });
  await run('booking-email-unknown-sent-precedence-and-rebuild',async proof=>{
    const id=`sql.${crypto.randomUUID()}`,sentAt=new Date().toISOString();
    const document={_id:id,_type:'booking',status:'cancelled',requiresReschedule:true,emailDispatchStatus:'delivery_unknown',recoveryNotificationStatus:'delivery_unknown',emailDispatchClientSentAt:sentAt,emailDispatchClientProviderId:'fixture-customer-receipt',recoveryOwnerNotifiedAt:sentAt,recoveryOwnerProviderId:'fixture-owner-receipt',emailDispatchAttemptCount:12,recoveryNotificationAttemptCount:12};
    const result=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document}]);assert.equal(result.error,null);
    const rows=()=>sql`select d.dispatch_kind,d.recipient_type,d.status,d.provider_message_id,d.attempt_count,d.lease_id,d.next_attempt_at from commerce.email_dispatches d join commerce.bookings b on b.id=d.booking_id where b.legacy_sanity_id=${id} order by d.dispatch_kind,d.recipient_type`;
    proof.incremental=await rows();assert.deepEqual(proof.incremental.map(row=>row.status),['sent','historical_unknown','historical_unknown','sent']);assert.ok(proof.incremental.every(row=>row.attempt_count===12));
    assert.equal((await client.rpc('roo_refresh_operational_shadow')).error,null);proof.rebuild=await rows();assert.deepEqual(proof.rebuild,proof.incremental);
  });
  for(const [label,currency,amount,subunits] of [['usd','USD',9.99,999],['eur','EUR',9.99,999],['kwd','KWD',9.99,9990],['bhd','BHD',9.99,9990],['omr','OMR',9.99,9990],['jpy','JPY',299,299],['clp','CLP',299,299],['krw','KRW',299,299],['tnd','TND',9.99,9990],['jod','JOD',9.99,9990],['default',null,9.99,999]]) await run(`currency-projection-${label}-incremental-and-full`,async proof=>{
    const bookingId=`sql.${crypto.randomUUID()}`,paymentId=`sql.${crypto.randomUUID()}`;
    const booking={_id:bookingId,_type:'booking',status:'refunded',netAmount:amount,refundedAmount:amount,refundStatus:'full',currency,packageTitle:'Fixture',email:'currency@fixture.invalid'};
    const payment={...paymentDocument(paymentId,'razorpay',null,0),status:'refunded',bookingId,pricingSnapshot:{netAmount:amount,currency},bookingPayload:{netAmount:amount,currency},providerPublicData:{currency},refundCurrency:currency,refundProcessedAmountInSubunits:subunits,refundState:'full'};
    proof.input={booking,payment};
    const created=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:booking},{operation:'create',document:payment}]);assert.equal(created.error,null);
    const rows=async()=>({bookings:await sql`select legacy_sanity_id,status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`,payments:await sql`select legacy_sanity_id,status,currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${paymentId}`,source:await sql`select legacy_sanity_id,payload,source_revision,tombstoned from migration.source_documents where legacy_sanity_id in (${bookingId},${paymentId}) order by legacy_sanity_id`});
    proof.incremental=await rows();
    const full=await client.rpc('roo_project_operational_shadow');assert.equal(full.error,null);proof.full=await rows();
    const refresh=await client.rpc('roo_refresh_operational_shadow');assert.equal(refresh.error,null);proof.refresh=await rows();
    for(const state of [proof.incremental,proof.full,proof.refresh]){
      assert.equal(state.bookings.length,1);assert.equal(state.payments.length,1);
      for(const row of [...state.bookings,...state.payments]){assert.equal(row.currency,currency||'USD');assert.equal(Number(row.amount_subunits),subunits);assert.equal(row.status,'refunded');}
      assert.deepEqual(state.source,proof.incremental.source);
    }
    assert.deepEqual(proof.full,proof.incremental);assert.deepEqual(proof.refresh,proof.incremental);
  });
  for(const [label,currency,amount,expected,explicit] of [['usd','USD',9.99,999,null],['eur','EUR',9.99,999,null],['kwd','KWD',9.99,9990,null],['jpy','JPY',299,299,null],['clp','CLP',299,299,null],['krw','KRW',299,299,null],['tnd','TND',9.99,9990,null],['jod','JOD',9.99,9990,null],['kwd-integer-authority','KWD',9.99,4990,4990]]) await run(`refund-currency-${label}-major-fallback-and-full`,async proof=>{
    const id=`sql.${crypto.randomUUID()}`,refundId=`refund-${crypto.randomUUID()}`;
    const document=paymentDocument(id,'razorpay',refundId,explicit||0);document.pricingSnapshot.currency=currency;document.refunds[0]={...document.refunds[0],amount,currency};if(explicit===null)delete document.refunds[0].amountInSubunits;
    proof.input=document;
    assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document}])).error,null);
    const rows=async()=>(await refundRows(refundId)).map(({row})=>({provider:row.provider,provider_refund_id:row.provider_refund_id,payment_record_id:row.payment_record_id,amount_subunits:Number(row.amount_subunits),currency:row.currency,status:row.status,payload:row.payload}));
    proof.incremental=await rows();assert.equal((await client.rpc('roo_refresh_operational_shadow')).error,null);proof.full=await rows();
    assert.equal(proof.incremental[0].currency,currency);assert.equal(proof.incremental[0].amount_subunits,expected);assert.deepEqual(proof.full,proof.incremental);
  });
  for(const [label,quoteCurrency] of [['absent',undefined],['null',null],['empty',''],['whitespace','   ']])await run(`currency-authority-provider-fallback-${label}`,async proof=>{
    const id=`sql.${crypto.randomUUID()}`,bookingId=`sql.${crypto.randomUUID()}`;const document={...paymentDocument(id,'razorpay',null,0),status:'refunded',bookingId,pricingSnapshot:{netAmount:9.99,...(quoteCurrency===undefined?{}:{currency:quoteCurrency})},providerPublicData:{currency:'KWD',totalAmount:11990},refundCurrency:'KWD',refunds:[{_key:'fixture',providerRefundId:`refund-${id}`,amount:4.99,currency:'KWD',status:'pending'}]};
    const booking={_id:bookingId,_type:'booking',paymentRecordId:id,status:'refunded',netAmount:9.99};proof.input={document,booking};
    assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:booking},{operation:'create',document}])).error,null);
    const rows=async()=>({payment:await sql`select currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${id}`,booking:await sql`select currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`,refund:(await refundRows(`refund-${id}`)).map(({row})=>({currency:row.currency,amount_subunits:row.amount_subunits,status:row.status}))});proof.incremental=await rows();
    for(const [name,rpc] of [['full','roo_project_operational_shadow'],['refresh','roo_refresh_operational_shadow']]){assert.equal((await client.rpc(rpc)).error,null);proof[name]=await rows();}
    for(const state of [proof.incremental,proof.full,proof.refresh]){for(const row of [...state.payment,...state.booking]){assert.equal(row.currency,'KWD');assert.equal(Number(row.amount_subunits),9990);}assert.equal(state.refund[0].currency,'KWD');assert.equal(Number(state.refund[0].amount_subunits),4990);}assert.deepEqual(proof.full,proof.incremental);assert.deepEqual(proof.refresh,proof.incremental);
    const [source]=await sql`select source_revision from migration.source_documents where legacy_sanity_id=${id}`;document.pricingSnapshot.netAmount=8.99;document.refunds[0].amount=5.99;document.refunds[0].status='processed';
    const command=`fixture:${crypto.randomUUID()}`,mutations=[{operation:'replace',id,expected_revision:source.source_revision,document}];assert.equal((await mutate('commerce',command,mutations)).error,null);proof.newer=await rows();assert.equal(Number(proof.newer.payment[0].amount_subunits),8990);assert.equal(Number(proof.newer.refund[0].amount_subunits),5990);assert.equal(proof.newer.refund[0].status,'completed');
    const same=await mutationState([id,bookingId]);assert.equal((await mutate('commerce',command,mutations)).error,null);assert.deepEqual(await mutationState([id,bookingId]),same);assert.deepEqual(await rows(),proof.newer);proof.duplicateUnchanged=true;
  });
  for(const [field,value] of [['pricingSnapshot','USD'],['bookingPayload','USD'],['refundCurrency','USD'],['refunds','USD'],['pricingSnapshot',0],['providerPublicData','not-a-currency']])await run(`currency-authority-conflict-${field}-${typeof value==='number'?'zero':value.toLowerCase()}-refused`,async proof=>{
    const id=`sql.${crypto.randomUUID()}`,doc={...paymentDocument(id,'razorpay',null,0),pricingSnapshot:{netAmount:9.99},providerPublicData:{currency:'KWD'},refundCurrency:'KWD'};
    const created=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:doc}]);assert.equal(created.error,null);const [source]=await sql`select source_revision from migration.source_documents where legacy_sanity_id=${id}`;
    if(field==='refundCurrency')doc.refundCurrency=value;else if(field==='refunds')doc.refunds=[{_key:'fixture',providerRefundId:`refund-${id}`,amountInSubunits:4990,currency:value,status:'processed'}];else doc[field]={...doc[field],currency:value};
    proof.input=doc;proof.before={state:await mutationState([id]),payment:await sql`select to_jsonb(p) row from commerce.payment_records p where legacy_sanity_id=${id}`,refunds:await refundRows(`refund-${id}`)};
    proof.response=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'replace',id,expected_revision:source.source_revision,document:doc}]);proof.after={state:await mutationState([id]),payment:await sql`select to_jsonb(p) row from commerce.payment_records p where legacy_sanity_id=${id}`,refunds:await refundRows(`refund-${id}`)};assert.equal(proof.response.error?.code,'22023');assert.deepEqual(proof.after,proof.before);
  });
  await run('currency-authority-corrupt-import-refuses-every-projector',async proof=>{
    const id=`sql.${crypto.randomUUID()}`,doc={...paymentDocument(id,'razorpay',null,0),pricingSnapshot:{netAmount:9.99},providerPublicData:{currency:'KWD'}};assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:doc}])).error,null);
    const [source]=await sql`select payload,source_revision from migration.source_documents where legacy_sanity_id=${id}`;await sql`update migration.source_documents set payload=jsonb_set(payload,'{pricingSnapshot,currency}','"USD"'::jsonb) where legacy_sanity_id=${id}`;
    const rows=async()=>({state:await mutationState([id]),payments:await sql`select to_jsonb(p) row from commerce.payment_records p order by id`,bookings:await sql`select to_jsonb(b) row from commerce.bookings b order by id`,refunds:await sql`select to_jsonb(r) row from commerce.refunds r order by id`});proof.before=await rows();
    try {for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){proof[rpc]=await client.rpc(rpc);assert.equal(proof[rpc].error?.code,'22023');assert.deepEqual(await rows(),proof.before);}proof.incremental=await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'replace',id,expected_revision:source.source_revision,document:{...doc,pricingSnapshot:{...doc.pricingSnapshot,currency:'USD'},lastAttemptAt:new Date().toISOString()}}]);assert.equal(proof.incremental.error?.code,'22023');assert.equal(proof.incremental.error?.message,'payment_currency_mismatch');assert.deepEqual(await rows(),proof.before);proof.existingTypedStateUnchanged=true;}finally{await sql`update migration.source_documents set payload=${sql.json(source.payload)} where legacy_sanity_id=${id}`;}
  });
  await run('currency-terminal-recovery-50-older-records-do-not-starve-current',async proof=>{
    const prefix=`sql.${crypto.randomUUID()}`,ids=Array.from({length:50},(_,index)=>`${prefix}.terminal${index}`),validId=`${prefix}.valid`;
    const make=(id,terminal)=>({...paymentDocument(id,'dodo',null,0),status:'booked',refundRequiresBookingSync:true,nextRecoveryAt:'',providerRecoveryTerminal:terminal,providerRecoveryTerminalReason:terminal?'payment_currency_mismatch':'',updatedAt:new Date(Date.now()+(terminal?-600000:0)).toISOString()});
    const mutations=ids.map(id=>({operation:'create',document:make(id,true)}));assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,mutations)).error,null);assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:make(validId,false)}])).error,null);
    const params={p_backend:'supabase',p_statuses:['started','needs_recovery'],p_refunded_status:'refunded',p_booked_status:'booked',p_abandoned_status:'abandoned',p_now:new Date().toISOString(),p_limit:50,p_dodo_enabled:true};const response=await client.rpc('roo_fetch_recovery_payment_documents',params);assert.equal(response.error,null);proof.selectedIds=response.data.map(r=>r._id);proof.olderTerminals=ids;proof.validId=validId;
    assert.ok(proof.selectedIds.includes(validId));assert.ok(ids.every(id=>!proof.selectedIds.includes(id)));
    const [source]=await sql`select source_revision,payload from migration.source_documents where legacy_sanity_id=${ids[0]}`;assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'replace',id:ids[0],expected_revision:source.source_revision,document:{...source.payload,providerRecoveryTerminal:false}}])).error,null);const resumed=await client.rpc('roo_fetch_recovery_payment_documents',params);assert.equal(resumed.error,null);assert.ok(resumed.data.some(r=>r._id===ids[0]));proof.explicitOwnerClearCanResume=true;
  });
  for(const field of ['linked-booking','pricingSnapshot','bookingPayload','refunds'])await run(`currency-authority-single-${field}-kwd`,async proof=>{
    const id=`sql.${crypto.randomUUID()}`,bookingId=`sql.${crypto.randomUUID()}`,doc={...paymentDocument(id,'razorpay',null,0),bookingId,pricingSnapshot:{netAmount:9.99}},booking={_id:bookingId,_type:'booking',paymentRecordId:id,status:'captured',netAmount:9.99,...(field==='linked-booking'?{currency:'KWD'}:{})};
    if(field==='pricingSnapshot'||field==='bookingPayload')doc[field]={...doc[field],currency:'KWD'};if(field==='refunds')doc.refunds=[{_key:'fixture',providerRefundId:`refund-${id}`,currency:'KWD',amountInSubunits:4990,status:'processed'}];proof.input={doc,booking};
    assert.equal((await mutate('commerce',`fixture:${crypto.randomUUID()}`,[{operation:'create',document:booking},{operation:'create',document:doc}])).error,null);const rows=async()=>({payments:await sql`select currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${id}`,bookings:await sql`select currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`});proof.incremental=await rows();for(const row of [...proof.incremental.payments,...proof.incremental.bookings]){assert.equal(row.currency,'KWD');assert.equal(Number(row.amount_subunits),9990);}for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){assert.equal((await client.rpc(rpc)).error,null);assert.deepEqual(await rows(),proof.incremental);}proof.everyProjectorAgrees=true;
  });
  if (!baseline) await run('forward-prerequisite-refusal-and-definition-rollback',async proof=>{
    for (const name of repairNames) {
      const migration=migrationText(name);
      if(name.includes('currency_subunits')) {
        const signature='public.roo_project_operational_shadow()';
        const [before]=await sql`select pg_get_functiondef(${signature}::regprocedure) definition`;
        await assert.rejects(sql.begin(async tx=>{
          await tx`drop function migration.booking_currency(jsonb,text)`;
          await tx`drop function migration.payment_currency(jsonb,jsonb)`;
          await tx`drop function migration.resolve_currency(jsonb)`;
          await tx`drop function migration.money_subunits(text,text)`;
          await tx.unsafe(before.definition.replace(/AS \$function\$[\s\S]*?\$function\$/,'AS $function$ begin return null; end; $function$'));
          await tx.unsafe(migration);
        }),error=>error.message.includes('unexpected projector amount anchor'));
        const [after]=await sql`select pg_get_functiondef(${signature}::regprocedure) definition`;
        assert.equal(after.definition,before.definition);assert.ok((await sql`select to_regprocedure('migration.money_subunits(text,text)') helper`)[0].helper);
        await assert.rejects(sql.begin(async tx=>{for(const helper of ['migration.booking_currency(jsonb,text)','migration.payment_currency(jsonb,jsonb)','migration.resolve_currency(jsonb)','migration.money_subunits(text,text)'])await tx.unsafe(`drop function ${helper}`);await tx`alter table migration.source_documents alter column tombstoned drop not null`;await tx.unsafe(migration);}),error=>error.message.includes('current booking/payment amount contract'));
        proof[name]={unexpectedFullProjectorRefused:true,missingSourceContractRefused:true,definitionAndHelperRestoredOnFailure:true};continue;
      }
      if(name.includes('refund_projection')) {
        await assert.rejects(sql.begin(async tx=>{await tx`alter table commerce.refunds drop constraint refunds_provider_provider_refund_id_key`;await tx.unsafe(migration);}),error=>error.message.includes('authoritative provider refund ledger'));
        await assert.rejects(sql.begin(async tx=>{await tx`alter table commerce.refunds alter column provider_refund_id drop not null`;await tx.unsafe(migration);}),error=>error.message.includes('authoritative provider refund ledger'));
        const [foreignKey]=await sql`select conname from pg_constraint where conrelid='commerce.refunds'::regclass and confrelid='commerce.payment_records'::regclass and contype='f'`;
        assert.ok(foreignKey);
        await assert.rejects(sql.begin(async tx=>{await tx.unsafe(`alter table commerce.refunds drop constraint "${foreignKey.conname.replaceAll('"','""')}"`);await tx.unsafe(migration);}),error=>error.message.includes('payment ownership foreign key'));
        proof[name]={missingUniqueRefused:true,nullableIdentityRefused:true,missingOwnershipForeignKeyRefused:true};continue;
      }
      const signature=name.includes('currency_subunits')?'public.roo_project_operational_shadow()':name.includes('activation')?'licensing.roo_activate_device_without_principal_check(uuid,uuid,text,text,text,text)':name.includes('mirror_leases')?'public.roo_claim_commerce_mirror_events(text,integer,boolean)':'public.roo_apply_document_mutations(jsonb)';
      const [original]=await sql`select pg_get_functiondef(${signature}::regprocedure) definition`;
      await assert.rejects(sql.begin(async tx=>{await tx.unsafe(original.definition.replace('CREATE OR REPLACE FUNCTION','CREATE OR REPLACE FUNCTION').replace(/AS \$function\$[\s\S]*?\$function\$/,'AS $function$ begin return null; end; $function$'));await tx.unsafe(migration);}),error=>/requires|anchor|unexpected|contract/.test(error.message));
      const [after]=await sql`select pg_get_functiondef(${signature}::regprocedure) definition`; assert.equal(after.definition,original.definition);
      proof[name]={definitionUnchanged:true};
    }
    await sql.begin(async tx=>{for(const row of originals) await tx.unsafe(row.definition);await tx.unsafe(refundRollback);for(const name of repairNames) await tx.unsafe(migrationText(name));});
    proof.savedDefinitionsRestoreAndForwardReapply=true;
    for(const row of originals){const [current]=await sql`select proacl::text acl from pg_proc where oid=to_regprocedure(${row.signature})`;assert.equal(current.acl,row.acl);}
    proof.functionPrivilegesPreserved=true;
  });
  const currencyDefinitions=await sql`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl::text acl,p.proconfig,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='migration' and p.proname in ('project_commerce_document_ids_unserialized','project_commerce_extensions','resolve_currency','payment_currency','booking_currency','money_subunits')) or (n.nspname='public' and p.proname in ('roo_project_operational_shadow','roo_refresh_operational_shadow','roo_fetch_recovery_payment_documents')) order by p.oid::regprocedure::text`;
  const currencyCatalog=path.join(fixture.scratch,'currency-effective-sql-catalog.json');fs.writeFileSync(currencyCatalog,JSON.stringify(currencyDefinitions,null,2));evidence.currencyCatalog={path:currencyCatalog,sha256:hash(fs.readFileSync(currencyCatalog)),definitions:currencyDefinitions.map(({signature,definition,acl})=>({signature,sha256:hash(definition),acl}))};
  const referencePath=process.argv.find(value=>value.startsWith('--currency-reference='))?.slice(21);
  if(referencePath){
    assert.ok(!baseline);const reference=JSON.parse(fs.readFileSync(path.resolve(root,referencePath),'utf8'));assert.equal(Object.keys(reference.definitions).length,4);const checked=[];
    for(const [signature,row] of Object.entries(reference.definitions)){
      assert.equal(hash(row.definition),row.sha256);let expected=row.definition;
      if(!currencyBaseline){
        expected=expected.replaceAll("migration.currency_code(coalesce(\n      source.payload->>'currency',\n      source.payload->'bookingPayload'->>'currency'\n    ))",'migration.booking_currency(source.payload, source.legacy_sanity_id)').replaceAll("migration.currency_code(coalesce(\n      ranked.payload->'pricingSnapshot'->>'currency',\n      ranked.payload->'bookingPayload'->>'currency'\n    ))",'migration.payment_currency(ranked.payload, to_jsonb(booking.currency))').replaceAll("migration.currency_code(coalesce(\n          refund.payload->>'currency', payment.currency\n        ))","migration.resolve_currency(jsonb_build_array(\n          refund.payload->'currency', to_jsonb(payment.currency)\n        ))").replaceAll("migration.currency_code(coalesce(refund.payload->>'currency', payment.currency))","migration.resolve_currency(jsonb_build_array(refund.payload->'currency', to_jsonb(payment.currency)))");
        if(signature==='roo_project_operational_shadow()'||signature==='public.roo_project_operational_shadow()')expected=expected.replace('  return v_counts;', '  perform migration.restore_commerce_owners(null);\n  return v_counts;');
        if(signature.includes('roo_fetch_recovery_payment_documents'))expected=expected.replace('    where not source.tombstoned',"    where not source.tombstoned\n      and not (coalesce(source.payload->'providerRecoveryTerminal', 'false'::jsonb) = 'true'::jsonb\n        and coalesce(source.payload->>'providerRecoveryTerminalReason', '')\n          in ('payment_currency_mismatch', 'payment_currency_invalid'))");
      }
      const current=currencyDefinitions.find(row=>row.signature===signature);assert.ok(current);assert.equal(current.definition,expected,`Full-history body mismatch ${signature}`);checked.push({signature,referenceSha256:row.sha256,expectedSha256:hash(expected),actualSha256:hash(current.definition),matches:true});
    }
    evidence.completeHistoryReference={path:referencePath,sha256:hash(fs.readFileSync(path.resolve(root,referencePath))),source:reference.source,sourceSha256:reference.sourceSha256,checked};
  }
  if(selected&&!compatibilityMode)assert.equal(evidence.scenarios.length,new Set(selected).size,'Unknown selected SQL scenario.');
  if (inventory) {
    const postgres=(await import('postgres')).default;
    const [config]=await sql`select current_setting('port') port`;
    await sql`create database sql_sweep_history`;
    historySql=postgres({host:testHost,port:Number(config.port),database:'sql_sweep_history',username:os.userInfo().username,max:1,prepare:false,onnotice(){}});
    await historySql.unsafe(`set role postgres;create schema extensions;create extension pgcrypto with schema extensions;create extension "uuid-ossp" with schema extensions;create schema auth;create schema storage;create role supabase_auth_admin;create schema vault;
      create function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
      create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
      create table auth.users(id uuid primary key,email text,encrypted_password text,aud text,role text,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now(),banned_until timestamptz,email_confirmed_at timestamptz,deleted_at timestamptz,is_anonymous boolean default false);
      create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,provider_id text,email text,identity_data jsonb default '{}',last_sign_in_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
      create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),created_at timestamptz default now(),updated_at timestamptz default now());create table auth.refresh_tokens(id bigint primary key,user_id text,token text,revoked boolean default false,session_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key,bucket_id text,name text,metadata jsonb,updated_at timestamptz);
      create table vault.decrypted_secrets(id uuid primary key,name text,decrypted_secret text);`);
    evidence.historyMigrations=[];
    const migrationFiles=fs.readdirSync(path.join(root,'supabase/migrations')).filter(name=>name.endsWith('.sql')&&(!baseline||!repairNames.includes(name))).sort();
    for (const name of migrationFiles) {
      const source=migrationText(name);
      try {await historySql.unsafe(source);evidence.historyMigrations.push({name,sha256:hash(source)});}
      catch(error){throw new Error(`Full-history local catalog ${name}: ${error.message}`);}
    }
    const definitions=await historySql`select p.oid::regprocedure::text signature,n.nspname schema,p.proname name,p.prosecdef security_definer,p.proconfig,p.proacl::text acl,pg_get_userbyid(p.proowner) owner,pg_get_functiondef(p.oid) definition,has_function_privilege('anon',p.oid,'execute') anon_execute,has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,has_function_privilege('service_role',p.oid,'execute') service_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') and p.prokind='f' order by n.nspname,p.proname,p.oid::regprocedure::text`;
    const tables=await historySql`select n.nspname schema,c.relname name,c.relrowsecurity rls,c.relforcerowsecurity forced_rls,c.relacl::text acl,has_table_privilege('anon',c.oid,'select') anon_select,has_table_privilege('authenticated',c.oid,'select') authenticated_select,has_table_privilege('anon',c.oid,'insert,update,delete') anon_write,has_table_privilege('authenticated',c.oid,'insert,update,delete') authenticated_write from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') and c.relkind in ('r','p') order by n.nspname,c.relname`;
    const policies=await historySql`select * from pg_policies where schemaname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') order by schemaname,tablename,policyname`;
    const columns=await historySql`select table_schema,table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema in ('accounts','commerce','licensing','cms','migration','tourney','ops') order by table_schema,table_name,ordinal_position`;
    const triggers=await historySql`select n.nspname schema,c.relname table_name,t.tgname name,t.tgenabled enabled,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') order by n.nspname,c.relname,t.tgname`;
    const views=await historySql`select n.nspname schema,c.relname name,c.reloptions config,c.relacl::text acl,pg_get_viewdef(c.oid,true) definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v' and n.nspname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') order by n.nspname,c.relname`;
    const writerInventory=definitions.map(row=>({signature:row.signature,sha256:hash(row.definition),literalRelations:[...new Set([...row.definition.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi)].map(match=>match[1]))].sort(),calls:definitions.filter(other=>other.signature!==row.signature&&new RegExp(`\\b${other.schema}\\.${other.name}\\s*\\(`,'i').test(row.definition)).map(other=>other.signature),dynamicSql:/\bexecute\b/i.test(row.definition)}));
    const constraints=await historySql`select n.nspname schema,c.relname table_name,k.conname name,k.contype type,k.convalidated validated,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') order by n.nspname,c.relname,k.conname`;
    const indexes=await historySql`select * from pg_indexes where schemaname in ('public','accounts','commerce','licensing','cms','migration','tourney','ops') order by schemaname,tablename,indexname`;
    const catalogPath=path.join(fixture.scratch,'effective-sql-catalog.json');fs.writeFileSync(catalogPath,JSON.stringify({definitions,tables,policies,columns,triggers,views,writerInventory,constraints,indexes},null,2));
    evidence.catalog={path:catalogPath,functions:definitions.length,tables:tables.length,securityDefiners:definitions.filter(row=>row.security_definer).length,browserCallableDefiners:definitions.filter(row=>row.security_definer&&(row.anon_execute||row.authenticated_execute)).map(row=>row.signature),unsafeSearchPaths:definitions.filter(row=>row.security_definer&&!row.proconfig?.some(value=>value==='search_path=""')).map(row=>({signature:row.signature,config:row.proconfig})),browserReadableTables:tables.filter(row=>row.anon_select||row.authenticated_select),browserWritableTables:tables.filter(row=>row.anon_write||row.authenticated_write),triggers:triggers.length,views:views.length};
    if (compatibilityMode) {
      const suites = {
        'tourney-retirement':'scripts/test-tourney-retirement-postgres.mjs',
        'referral-orphan-prerequisites':'scripts/test-referral-orphan-prerequisites-postgres.mjs'
      };
      const names=compatibilityOption?.includes('=')?compatibilityOption.split('=')[1].split(','):Object.keys(suites);
      assert.ok(names.length&&names.every(name=>Object.hasOwn(suites,name))&&new Set(names).size===names.length,'Unknown or duplicate compatibility suite.');
      compatibilityRelay=net.createServer(socket=>{
        const upstream=net.connect({host:testHost,port:Number(config.port)});
        for(const connection of [socket,upstream]) {relaySockets.add(connection);connection.on('close',()=>relaySockets.delete(connection));connection.on('error',()=>{socket.destroy();upstream.destroy();});}
        socket.pipe(upstream);upstream.pipe(socket);
      });
      compatibilityRelay.listen(0,'127.0.0.1');await once(compatibilityRelay,'listening');
      const databaseUrl=`postgres://postgres@127.0.0.1:${compatibilityRelay.address().port}/sql_sweep_history`;
      const relaySql=postgres(databaseUrl,{max:1,prepare:false,connect_timeout:5,onnotice(){}});
      try {
        const [checked]=await relaySql`select current_database() database,current_setting('server_version') version,to_regclass('tourney.external_operations') external_operations,to_regclass('accounts.orphan_identity_reclaim_audit') reclaim_audit,to_regprocedure('public.roo_reclaim_referral_orphan_identity(text,uuid,text)') reclaim_rpc`;
        assert.equal(checked.database,'sql_sweep_history');assert.match(checked.version,/^17\./);assert.ok(checked.external_operations&&checked.reclaim_audit&&checked.reclaim_rpc);
        evidence.compatibility={prepared:true,executed:false,localRelay:true,upstreamHost:testHost,database:'sql_sweep_history',checked,suites:names.map(name=>({name,file:suites[name],sha256:hash(fs.readFileSync(path.join(root,suites[name])))})),results:[]};
      } finally {await relaySql.end({timeout:5});}
      if (!prepareCompatibility) {
        const guardImport=new URL('./lib/test-target-safety.mjs',import.meta.url).href;
        const preload=`data:text/javascript,${encodeURIComponent(`import {installNetworkGuard} from ${JSON.stringify(guardImport)};installNetworkGuard([]);`)}`;
        for (const name of names) {
          const logPath=path.join(fixture.scratch,`${name}.log`);const descriptor=fs.openSync(logPath,'w',0o600);
          const child=spawn(process.execPath,['--import',preload,suites[name]],{cwd:root,env:{PATH:process.env.PATH,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH,NODE_ENV:'test',SUPABASE_TEST_DATABASE_URL:databaseUrl},stdio:['ignore',descriptor,descriptor]});fs.closeSync(descriptor);
          const deadline=setTimeout(()=>child.kill('SIGTERM'),600000);
          let status;try {const [code,signal]=await once(child,'exit');status={code,signal};}finally{clearTimeout(deadline);}
          evidence.compatibility.executed=true;evidence.compatibility.results.push({name,logPath,...status,passed:status.code===0});
          if(status.code!==0)throw new Error(`Compatibility suite ${name} failed; inspect ${logPath}`);
        }
      }
    }
  }
  evidence.fixture={scratch:fixture.scratch,postgresVersion:fixture.postgresVersion,postgrestVersion:fixture.postgrestVersion,manifest:fixture.manifest,requests:fixture.requestLog,allowedOrigins:[...allowedOrigins]};
} catch(error) {evidence.fatal={message:error.message,stack:error.stack};}
finally {
  for(const socket of relaySockets)socket.destroy();
  if(compatibilityRelay)await new Promise(resolve=>compatibilityRelay.close(resolve));
  if (historySql) await historySql.end({timeout:5});
  if (fixture) {await fixture.stop();evidence.servicesStopped=true;}
  globalThis.fetch=fetchBefore;setGlobalDispatcher(dispatcherBefore);
  fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify({artifact,scenarios:evidence.scenarios.map(({name,passed})=>({name,passed})),catalog:evidence.catalog,fatal:evidence.fatal,servicesStopped:evidence.servicesStopped},null,2));
if (evidence.fatal||evidence.scenarios.some(row=>!row.passed)) process.exitCode=1;

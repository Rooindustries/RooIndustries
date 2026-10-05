#!/usr/bin/env node
const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { createSweepPostgresFixture, root } from './lib/sweep-postgres-fixture.mjs';

for(const key of Object.keys(process.env))if(/^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO_PAYMENTS|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND|BOOKING_EMAIL)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'supabase',COMMERCE_PRIMARY_BACKEND:'supabase',COMMERCE_FAILOVER_GENERATION:'0',PAYPAL_ENV:'sandbox',PAYPAL_CLIENT_ID:'fixture-client',PAYPAL_CLIENT_SECRET:'fixture-secret',PAYPAL_WEBHOOK_ID:'fixture-webhook',RAZORPAY_KEY_ID:'rzp_test_fixture',RAZORPAY_KEY_SECRET:'fixture-secret',RAZORPAY_WEBHOOK_SECRET:'fixture-webhook-secret',PAYMENT_SESSION_SECRET:'fixture-session-secret',REF_SESSION_SECRET:'fixture-ref-session-secret',CRON_SECRET:'fixture-cron',DODO_PAYMENTS_ENVIRONMENT:'test_mode',DODO_PAYMENTS_API_KEY:'fixture-dodo',DODO_PAYMENTS_WEBHOOK_KEY:`whsec_${Buffer.from('fixture-dodo-secret').toString('base64')}`,DODO_PAYMENTS_PRODUCT_ID:'pdt_fixture',DODO_PAYMENTS_RETURN_URL:'https://example.invalid/checkout'});
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;for(const suffix of ['.js','.ts','/index.js']){const candidate=new URL(`${specifier}${suffix}`,context.parentURL);if(fs.existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);}throw error;}}});

const only=process.argv.find(value=>value.startsWith('--scenario='))?.slice(11);
const artifact=path.resolve(process.env.ROO_PERSISTENCE_SWEEP_ARTIFACT||'test-results/persistence-sweep.json');
const evidence={baseline:'7f9070aa8015dc5fe2bd32c2e848bfcd98dab4c4',checkedAt:new Date().toISOString(),productionRequests:0,scenarios:[],standIns:[{boundary:'Auth HTTP',scope:'Documented synthetic user/password-update/session responses; current account and credential SQL are real. No GoTrue delivery/storage proof.'},{boundary:'Payment provider HTTP',scope:'Synthetic PayPal/Razorpay/Dodo response objects through actual provider clients. No live provider calls.'},{boundary:'Transparent REST path proxy',scope:'Removes /rest/v1 only, forwards actual RPCs to PostgREST unchanged; race hooks write through actual PostgreSQL or adapter.'},{boundary:'Supabase infrastructure',scope:'Local auth.users/identities/sessions/refresh_tokens and storage.buckets bootstrap; actual application account/commerce/migration tables and functions are repo definitions.'},{boundary:'Rate limiting in NODE_ENV=test',scope:'Existing production test-mode in-memory limiter; no claims about durable rate limiting.'}],limits:['Local PostgreSQL17/PostgREST16.4 versions; hosted PostgREST/version/migration ledger not inspected.','Sanity optimistic locking remains an external engine contract; local proof covers actual Supabase adapter/SQL semantics.','No production Next server/build or live Auth/provider/email integration.']};
evidence.standIns.push({boundary:'Local SQL grants',scope:'Synthetic service_role JWT, expanded local service-role grants and local function owner; hosted RLS/client permissions are not proved.'},{boundary:'Sanity refusal sentinel',scope:'Throwing Proxy supplied only to refused credential resume calls; never invoked. Successful real Supabase source RPC is direct; external mirror completion not proved.'},{boundary:'Synthetic record state',scope:'Commerce control fixed generation0, emailDispatch.allSent true, no coupon/referral/booking-slot entities in these refund cases. Assertions cover payment/refund/booking/receipt source and operational parity, not those absent side effects.'},{boundary:'Negative-case budget',scope:'Only failing Dodo proof intercepts fourth receipt create after3 real native23505 conflicts; this safely terminates the reproduced loop and is never a production refusal proof.'});
let fixture;
const realFetch=globalThis.fetch;
let blockedNetwork=0;
let providerRequests=0;
let authUpdates=0;
let authUpdatesTotal=0;
let failAuth=false;
let onSignIn=null;
let dodoPayment;
let dodoNotification;
let paypalCapture;
let negativeProof;
let paymentScenario=0;
let dodoEventId;
const userId='11111111-1111-4111-8111-111111111111';
const otherId='22222222-2222-4222-8222-222222222222';
const email='fixture@example.invalid';
const password='fixture-password-one';
const operationKey='credential:persistence:fixture';
const run=async(name,fn)=>{if(only&&!only.split(',').includes(name))return;const started=Date.now();negativeProof=null;try{fixture?.setRequestHook(null);const proof=await fn();evidence.scenarios.push({name,passed:true,durationMs:Date.now()-started,...(proof?{proof}:{} )});}catch(error){evidence.scenarios.push({name,passed:false,durationMs:Date.now()-started,error:error.message,code:error.code||error.cause?.code,stack:error.stack,...(negativeProof?{negativeProof}: {})});}};

try {
  fixture=await createSweepPostgresFixture();
  const {sql,client}=fixture;
  Object.assign(process.env,{SUPABASE_URL:fixture.origin,SUPABASE_SERVICE_ROLE_KEY:fixture.token,NEXT_PUBLIC_SUPABASE_URL:fixture.origin,NEXT_PUBLIC_SUPABASE_ANON_KEY:fixture.token});
  const providerOrigins=new Set(['https://api-m.sandbox.paypal.com','https://api.razorpay.com','https://test.dodopayments.com']);
  fixture.setProviderHandler(async request=>{
    let body;
    if(request.path==='/v1/oauth2/token')body={access_token:'fixture-access',expires_in:3600};
    else if(request.path==='/v1/notifications/verify-webhook-signature')body={verification_status:'SUCCESS'};
    else if(request.path==='/v2/payments/captures/capture-fixture')body=paypalCapture;
    else if(request.path==='/payments/payment-fixture')body=dodoPayment;
    else if(request.path==='/v1/payments/payment-fixture')body={id:'payment-fixture',order_id:'order-fixture',status:'captured',captured:true,amount:999,currency:'USD',amount_refunded:999,refund_status:'full'};
    else throw new Error(`Unexpected provider fixture path ${request.path}`);
    return{body};
  });
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
    if(url.origin===fixture.origin)return realFetch(input,{...init,redirect:'error'});
    if(providerOrigins.has(url.origin)){
      providerRequests++;
      return realFetch(`${fixture.origin}/provider${url.pathname}${url.search}`,{...init,redirect:'error',signal:init?.signal||AbortSignal.timeout(5000)});
    }
    blockedNetwork++;throw new Error(`Network destination blocked: ${url.origin}`);
  };
  fixture.setAuthHandler(async request=>{
    if(request.method==='PUT'&&request.path===`/auth/v1/admin/users/${userId}`){authUpdates++;authUpdatesTotal++;return failAuth?{status:503,body:{msg:'synthetic transient failure'}}:{body:{id:userId,email}};}
    if(request.path.startsWith('/auth/v1/token?grant_type=password')){
      if(onSignIn){const fn=onSignIn;onSignIn=null;await fn();}
      return{body:{access_token:fixture.token,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,user:{id:userId,email}}};
    }
    if(request.path==='/auth/v1/user')return{body:{id:userId,email}};
    throw new Error(`Unexpected Auth fixture path ${request.path}`);
  });
  const accounts=await import('../src/server/supabase/accounts.js');
  const recovery=await import('../src/server/supabase/credentialRecovery.js');
  const {createSupabaseDocumentClient}=await import('../src/server/supabase/documentClient.js');
  const documents=createSupabaseDocumentClient({shadowClient:client});
  const commerce=createSupabaseDocumentClient({shadowClient:client,commerceOnly:true,cutoverGeneration:0});
  const forbiddenMirror=new Proxy({}, {get(){throw new Error('Sanity mirror boundary must remain unused in refused-state checks');}});
  const row=async(id)=>{const [record]=await sql`select payload,source_revision,tombstoned,operational_imported from migration.source_documents where legacy_sanity_id=${id}`;return record;};
  const resetAccount=async()=>{
    fixture.setRequestHook(null);onSignIn=null;failAuth=false;authUpdates=0;
    await sql`delete from accounts.credential_operations`;
    await sql`delete from accounts.principals`;
    await sql`delete from auth.users`;
    await sql`insert into auth.users(id,email,email_confirmed_at) values(${userId}::uuid,${email},now()),(${otherId}::uuid,'other@example.invalid',now())`;
    await sql`insert into public.profiles(user_id,primary_email,display_name,status,legacy_sanity_id) values(${userId}::uuid,${email},'Fixture','active','referral.fixture')`;
    await sql`insert into accounts.creator_profiles(user_id,referral_code,legacy_sanity_id,active) values(${userId}::uuid,'fixture','referral.fixture',true)`;
    await sql`insert into accounts.account_roles(user_id,role) values(${userId}::uuid,'creator')`;
    await sql`insert into accounts.login_aliases(user_id,alias_type,normalized_value,verified) values(${userId}::uuid,'email',${email},true),(${userId}::uuid,'referral_code','fixture',true)`;
    const source=await documents.fetch('*[_id == $id][0]',{id:'referral.fixture'});
    if(source)await documents.patch(source._id).ifRevisionId(source._rev).set({creatorPassword:'old',credentialVersion:2,registrationStatus:'active',active:true}).commit();
    else await documents.create({_id:'referral.fixture',_type:'referral',creatorEmail:email,slug:{current:'fixture'},creatorPassword:'old',credentialVersion:2,registrationStatus:'active',active:true});
  };
  const args=async(overrides={})=>{
    const source=(await row('referral.fixture')).payload;
    const passwordHash=await bcrypt.hash(password,4);
    return{identifier:email,password,passwordHash,sourceBackend:'supabase',sourceDocumentId:source._id,sourceRevision:source._rev,sourcePreconditions:{creatorPassword:'old',credentialVersion:2},sourceMutation:accounts.buildCredentialSourceMutation({passwordHash,passwordChangedAt:new Date().toISOString(),consumeResetToken:true}),operationKey,adminClient:client,...overrides};
  };
  const saved=async()=>accounts.getSupabaseCredentialOperation({operationKey,adminClient:client});

  await run('schema-contract',async()=>{
    const {data,error}=await client.rpc('roo_commerce_control');assert.equal(error,null);assert.equal(data.primary_backend,'supabase');
    const [counts]=await sql`select (select count(*)::int from pg_constraint where connamespace in ('accounts'::regnamespace,'commerce'::regnamespace,'migration'::regnamespace)) as constraints,(select count(*)::int from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace in ('accounts'::regnamespace,'commerce'::regnamespace,'migration'::regnamespace))) as triggers`;
    assert.ok(counts.constraints>100);assert.ok(counts.triggers>=6);evidence.schemaCounts=counts;
  });
  await run('prepared-retry-real-rpcs',async()=>{
    await resetAccount();const original=await args();failAuth=true;await assert.rejects(accounts.updateSupabaseAccountPassword(original));
    const prepared=await saved();assert.equal(prepared.status,'prepared');failAuth=false;
    const result=await accounts.updateSupabaseAccountPassword(await args());assert.equal(result.passwordHash,prepared.password_hash);assert.deepEqual(result.sourceMutation,prepared.source_mutation);assert.equal(authUpdates,2);assert.equal((await saved()).status,'auth_applied');
    const applied=await client.rpc('roo_apply_credential_source_operation_v2',{p_operation_key:operationKey});assert.equal(applied.error,null);assert.equal(applied.data.status,'source_applied');
    const source=(await row('referral.fixture')).payload;assert.equal(source.creatorPassword,prepared.password_hash);assert.equal((await saved()).status,'auth_applied');assert.equal(authUpdates,2);
    await accounts.updateSupabaseAccountPassword(original);assert.equal(authUpdates,2);assert.equal((await row('referral.fixture')).payload._rev,source._rev);
    await assert.rejects(recovery.resumeSupabaseCredentialOperation({operationKey,password:'fixture-password-two',adminClient:client,sanityClient:forbiddenMirror}),error=>error.code==='23505');assert.equal(authUpdates,2);
    const [principal]=await sql`select session_version from accounts.principals where id=${userId}::uuid`;assert.equal(Number(principal.session_version),2);
    return{authAttempts:authUpdates,successfulAuthUpdates:1,operationStatus:(await saved()).status,sourcePasswordMatchesPreparation:source.creatorPassword===prepared.password_hash,sessionVersion:Number(principal.session_version),sourceApplicationStatus:applied.data.status,limit:'Real source application proved; external Sanity mirror/fully mirrored checkpoint not claimed.'};
  });
  await run('credential-key-content-refused-real-rpcs',async()=>{
    await resetAccount();failAuth=true;await assert.rejects(accounts.updateSupabaseAccountPassword(await args()));failAuth=false;
    for(const change of [{password:'fixture-password-two'},{sourceRevision:'changed-revision'},{sourcePreconditions:{credentialVersion:1}},{sourceDocumentId:'referral.other'},{sourceMutation:{...(await args()).sourceMutation,unset:[]}}])await assert.rejects(accounts.updateSupabaseAccountPassword(await args(change)));
    assert.equal(authUpdates,1);assert.equal((await saved()).status,'prepared');assert.equal((await row('referral.fixture')).payload.creatorPassword,'old');
  });
  await run('credential-source-owner-mismatch-real-joins',async()=>{
    await resetAccount();await assert.rejects(accounts.updateSupabaseAccountPassword(await args({sourceDocumentId:'referral.other'})),error=>error.code==='P0002');
    await sql`update accounts.creator_profiles set legacy_sanity_id=null where user_id=${userId}::uuid`;
    await assert.rejects(accounts.updateSupabaseAccountPassword(await args()),error=>error.code==='P0002');assert.equal(authUpdates,0);const [count]=await sql`select count(*)::int as count from accounts.credential_operations`;assert.equal(count.count,0);return{authCalls:0,operationRows:0};
  });
  for(const state of ['backoff','blocked','failed'])await run(`credential-exact-${state}-real-rpcs`,async()=>{
    await resetAccount();const input=await args();failAuth=true;await assert.rejects(accounts.updateSupabaseAccountPassword(input));failAuth=false;
    if(state==='backoff')await sql`update accounts.credential_operations set next_retry_at=now()+interval '60 seconds' where operation_key=${operationKey}`;
    if(state==='blocked')await sql`update accounts.credential_operations set source_recovery_blocked=true,source_recovery_blocked_at=now() where operation_key=${operationKey}`;
    if(state==='failed'){const r=await client.rpc('roo_mark_credential_operation_v2',{p_operation_key:operationKey,p_status:'failed',p_error_code:'FIXTURE_FAILED'});assert.equal(r.error,null);}
    await assert.rejects(accounts.updateSupabaseAccountPassword(input));
    await assert.rejects(accounts.updateSupabaseAccountPassword(await args()));
    await assert.rejects(recovery.resumeSupabaseCredentialOperation({operationKey,password,adminClient:client,sanityClient:forbiddenMirror}));
    assert.equal(authUpdates,1);assert.equal((await row('referral.fixture')).payload.creatorPassword,'old');
  });
  for(const state of ['disable','role-removed','version-changed','principal-changed'])await run(`login-${state}-real-current-joins`,async()=>{
    await resetAccount();onSignIn=async()=>{
      if(state==='disable')await sql`update accounts.principals set status='disabled' where id=${userId}::uuid`;
      if(state==='role-removed')await sql`delete from accounts.account_roles where user_id=${userId}::uuid and role='creator'`;
      if(state==='version-changed')await sql`update accounts.principals set session_version=2 where id=${userId}::uuid`;
      if(state==='principal-changed'){await sql`insert into accounts.principals(id) values(${otherId}::uuid) on conflict do nothing`;await sql`update accounts.login_aliases set principal_id=${otherId}::uuid where user_id=${userId}::uuid`;await sql`update accounts.creator_profiles set principal_id=${otherId}::uuid where user_id=${userId}::uuid`;}
    };
    const response=await accounts.authenticateSupabaseAccount({identifier:email,password,requiredRoles:['creator'],adminClient:client,authClient:client});assert.equal(response.ok,false);
  });
  await run('credential-concurrent-preparation-real-constraints',async()=>{
    await resetAccount();const inputs=await Promise.all([args(),args()]);
    const results=await Promise.all(inputs.map(input=>accounts.updateSupabaseAccountPassword(input)));
    assert.equal(results[0].passwordHash,results[1].passwordHash);const [count]=await sql`select count(*)::int as count from accounts.credential_operations where operation_key=${operationKey}`;assert.equal(count.count,1);
    const [principal]=await sql`select session_version from accounts.principals where id=${userId}::uuid`;assert.equal(Number(principal.session_version),2);return{operationRows:count.count,sessionVersion:Number(principal.session_version),authCalls:authUpdates};
  });
  const referralAuth=await import('../src/server/api/ref/auth.js');
  for(const state of ['principal-reassigned','creator-role-removed','version-changed'])await run(`session-${state}-real-rpc`,async()=>{
    await resetAccount();const cookie=referralAuth.createReferralSessionCookie({referralId:'referral.fixture',code:'fixture',authBackend:'supabase',principalId:userId,sessionVersion:1});
    if(state==='principal-reassigned'){
      await sql`insert into public.profiles(user_id,primary_email,status) values(${otherId}::uuid,'other@example.invalid','active')`;
      await sql`insert into accounts.account_roles(user_id,role) values(${otherId}::uuid,'creator')`;
      await sql`update accounts.creator_profiles set principal_id=${otherId}::uuid where user_id=${userId}::uuid`;
    }
    if(state==='creator-role-removed')await sql`delete from accounts.account_roles where user_id=${userId}::uuid and role='creator'`;
    if(state==='version-changed')await sql`update accounts.principals set session_version=2 where id=${userId}::uuid`;
    const res={statusCode:200,status(value){this.statusCode=value;return this;},json(){}};
    assert.equal(await referralAuth.requireReferralSession({headers:{cookie:`${cookie.name}=${cookie.value}`}},res),null);assert.equal(res.statusCode,401);
  });
  const identity=await import('../src/server/api/ref/referralIdentity.js');
  const registrationState=async()=>{
    const id='referral.registration';const claim=identity.buildReferralIdentityClaim({kind:'email',value:'registration@example.invalid',referralId:id});
    for(const target of [claim._id,id])if(await documents.fetch('*[_id == $id][0]',{id:target}))await documents.delete(target);
    const referral=await documents.create({_id:id,_type:'referral',creatorEmail:'registration@example.invalid',slug:{current:'registration'},registrationStatus:'pending_email',registrationVerificationExpiresAt:new Date(Date.now()-60000).toISOString()});
    const savedClaim=await documents.create(claim);return{referral,claim:savedClaim};
  };
  const cleanupTransaction=(state)=>documents.transaction().patch(state.referral._id,p=>p.ifRevisionId(state.referral._rev).set({registrationStatus:'pending_email'})).delete(state.referral._id).patch(state.claim._id,p=>p.ifRevisionId(state.claim._rev).set({referral:state.claim.referral})).delete(state.claim._id);
  await run('registration-cleanup-happy-actual-adapter',async()=>{
    const state=await registrationState();await cleanupTransaction(state).commit();assert.equal(await documents.fetch('*[_id == $id][0]',{id:state.referral._id}),null);assert.equal(await documents.fetch('*[_id == $id][0]',{id:state.claim._id}),null);
  });
  for(const race of ['activation','claim-owner'])await run(`registration-guarded-delete-${race}-atomic-rollback`,async()=>{
    const state=await registrationState();const before=await sql`select count(*)::int as count from migration.document_mutation_mirror_outbox`;
    if(race==='activation')await documents.patch(state.referral._id).ifRevisionId(state.referral._rev).set({registrationStatus:'active'}).commit();
    else await documents.patch(state.claim._id).ifRevisionId(state.claim._rev).set({referral:{_type:'reference',_ref:'referral.other'}}).commit();
    await assert.rejects(documents.transaction().delete(state.referral._id,{ifRevisionId:state.referral._rev}).delete(state.claim._id,{ifRevisionId:state.claim._rev}).commit(),error=>error.code==='40001');
    const referral=(await row(state.referral._id)).payload;const claim=(await row(state.claim._id)).payload;
    assert.equal(referral.registrationStatus,race==='activation'?'active':'pending_email');assert.equal(claim.referral._ref,race==='claim-owner'?'referral.other':state.referral._id);
    const after=await sql`select count(*)::int as count from migration.document_mutation_mirror_outbox`;assert.equal(after[0].count,before[0].count+1);
    return{registrationStatus:referral.registrationStatus,reservationOwner:claim.referral._ref,failedCleanupOutboxRows:0,scope:'actual adapter explicit revision-guarded deletes; legacy handler/Sanity engine not run'};
  });
  await run('registration-guarded-delete-happy-real-adapter',async()=>{
    const state=await registrationState();await documents.transaction().delete(state.referral._id,{ifRevisionId:state.referral._rev}).delete(state.claim._id,{ifRevisionId:state.claim._rev}).commit();assert.equal(await row(state.referral._id),undefined);assert.equal(await row(state.claim._id),undefined);
  });
  await run('registration-replacement-stale-revision-real-adapter',async()=>{
    const {referral}=await registrationState();await documents.patch(referral._id).ifRevisionId(referral._rev).set({registrationStatus:'active',successfulReferrals:1,xocPayments:[{amount:10}],currentCommissionPercent:20,bypassUnlock:true}).commit();
    await assert.rejects(documents.transaction().patch(referral._id,p=>p.ifRevisionId(referral._rev).set({registrationStatus:'pending_email',successfulReferrals:0,currentCommissionPercent:10}).unset(['xocPayments','bypassUnlock'])).commit(),error=>error.code==='40001');
    const source=(await row(referral._id)).payload;assert.equal(source.registrationStatus,'active');assert.equal(source.successfulReferrals,1);assert.deepEqual(source.xocPayments,[{amount:10}]);assert.equal(source.currentCommissionPercent,20);assert.equal(source.bypassUnlock,true);return{status:'active',successfulReferrals:1,retainedPaymentAmount:10,commissionPercent:20,bypassUnlock:true,scope:'actual adapter + route replacement structure; no handler override'};
  });
  const register=(await import('../src/server/api/ref/register.js')).default;
  const {installLegacySupabaseSession}=await import('../src/server/supabase/serverSession.js');
  await run('registration-replacement-real-handler-race',async()=>{
    await resetAccount();await documents.patch('referral.fixture').set({registrationStatus:'pending_email',registrationVerificationExpiresAt:new Date(Date.now()-60000).toISOString()}).commit();
    const headers=new Map();const res={statusCode:200,setHeader(key,value){headers.set(key,value);},getHeader(key){return headers.get(key);},status(value){this.statusCode=value;return this;},json(body){this.body=body;return this;}};
    await installLegacySupabaseSession({req:{headers:{}},res,session:{access_token:fixture.token,refresh_token:'fixture-refresh'}});
    const setCookie=headers.get('Set-Cookie');const cookie=(Array.isArray(setCookie)?setCookie:[setCookie]).filter(Boolean).map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
    let raced=false;fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='before'||raced||!request.path.endsWith('/roo_apply_document_mutations'))return;
      if(!request.body.p_mutations?.some(m=>m.document?._id==='referral.fixture'&&m.document.registrationStatus==='active'))return;
      raced=true;fixture.setRequestHook(null);await documents.patch('referral.fixture').set({registrationStatus:'active',successfulReferrals:1,xocPayments:[{amount:10}],currentCommissionPercent:20,bypassUnlock:true}).commit();
    });
    await register({method:'POST',headers:{cookie,'x-forwarded-for':'192.0.2.51'},body:{name:'Fixture User',email,paypalEmail:'paypal@example.invalid',slug:'fixture',password}},res);
    assert.equal(raced,true,JSON.stringify(res.body));assert.equal(res.statusCode,409,JSON.stringify(res.body));const source=(await row('referral.fixture')).payload;assert.equal(source.registrationStatus,'active');assert.equal(source.successfulReferrals,1);assert.deepEqual(source.xocPayments,[{amount:10}]);assert.equal(source.currentCommissionPercent,20);assert.equal(source.bypassUnlock,true);return{httpStatus:res.statusCode,preservedAccounting:true,preservedPolicy:true,scope:'unmodified register handler + Supabase SSR/SDK + current SQL; Auth user response synthetic'};
  });

  const flow=await import('../src/server/api/payment/flow.js');
  const {importShadowDocuments}=await import('../src/server/supabase/shadowStore.js');
  const seedVolume=async()=>{
    const [existing]=await sql`select count(*)::int as count from commerce.bookings where legacy_sanity_id like 'booking.adjacent.%'`;
    if(existing.count===1001)return;
    const entries=Array.from({length:1001},(_,index)=>({_id:`booking.adjacent.${String(index).padStart(4,'0')}`,_type:'booking',_rev:`adjacent-${index}`,_createdAt:'2026-01-01T00:00:00.000Z',_updatedAt:'2026-01-01T00:00:00.000Z',backendOwner:'sanity',cutoverGeneration:0,status:'completed',packageTitle:'Fixture',netAmount:9.99,paypalOrderId:`adjacent-order-${index}`,email:'adjacent@example.invalid'}));
    await importShadowDocuments({documents:entries,client,batchSize:100});
    const refreshed=await client.rpc('roo_refresh_operational_shadow');assert.equal(refreshed.error,null,JSON.stringify(refreshed.error));
    const [count]=await sql`select count(*)::int as count from commerce.bookings where legacy_sanity_id like 'booking.adjacent.%'`;assert.equal(count.count,1001);
    evidence.volume={adjacentBookings:1001,reason:'Exceeds default500 and maximum1000 targeted-fetch bounds; actual import and full projector, unrelated records retained.'};
  };
  const resetPayment=async(provider='razorpay',amount=9.99,extra={})=>{
    fixture.setRequestHook(null);await seedVolume();
    dodoEventId=`event-dodo-fixture-${++paymentScenario}`;
    const current=(await row('paymentRecord.fixture'))?.payload;
    await sql`delete from commerce.refunds where payment_record_id=(select id from commerce.payment_records where legacy_sanity_id='paymentRecord.fixture')`;
    const record={_id:'paymentRecord.fixture',_type:'paymentRecord',provider,backendOwner:'supabase',cutoverGeneration:0,status:'booked',providerOrderId:'order-fixture',providerPaymentId:provider==='paypal'?'capture-fixture':'payment-fixture',bookingId:'booking.fixture',sessionScope:'fixture-session-scope',quoteFingerprint:'fixture-quote',providerIdempotencyKey:'fixture-payment-key',bookingPayload:{packageTitle:'Vertex Essentials',email:'customer@example.invalid',startTimeUTC:'2099-01-01T10:00:00.000Z'},pricingFingerprint:'fixture-pricing',pricingSnapshot:{netAmount:amount},providerPublicData:{currency:'USD',productId:'pdt_fixture',environment:'test_mode',taxInclusive:false,totalAmount:Math.round(amount*100)},sessionExpiresAt:'2099-01-01T10:00:00.000Z',emailDispatch:{allSent:true},...extra};
    const booking={_id:'booking.fixture',_type:'booking',status:'captured',packageTitle:'Vertex Essentials',email:'customer@example.invalid',netAmount:amount,commissionAmount:1,paypalOrderId:'order-fixture',backendOwner:'supabase',cutoverGeneration:0};
    const existingBooking=(await row('booking.fixture'))?.payload;
    const deletes=await commerce.fetch('*[_type == "paymentWebhookReceipt"]{_id}');
    for(const item of deletes)await commerce.delete(item._id);
    let tx=commerce.transaction();
    if(existingBooking){tx=tx.patch(booking._id,p=>p.ifRevisionId(existingBooking._rev).set(booking).unset(['refundStatus','refundAccountingAppliedAt','refundedAmount','lastRefundId','lastRefundAt','slotReleasedAfterRefund','couponRestoredAfterRefund','referralReversedAfterRefund','processedRefundIds','dodoOriginalCommissionAmount','dodoTotalAmount','fixtureConcurrentEdit']));}else tx=tx.create(booking);
    if(current){tx=tx.patch(record._id,p=>p.ifRevisionId(current._rev).set(record).unset(['refunds','refundProcessedAmountInSubunits','refundState','refundRequiresBookingSync','refundBookingSync','recoveryReason','events']));}else tx=tx.create(record);
    await tx.commit();
    const isolatedBooking=await commerce.fetch('*[_type == "booking" && paypalOrderId == $paypalOrderId][0]{_id}',{paypalOrderId:'order-fixture'});assert.equal(isolatedBooking._id,booking._id);
    if(Object.keys(extra).length)await commerce.patch(record._id).set(extra).commit();
    paypalCapture={id:'capture-fixture',status:'REFUNDED',amount:{value:amount.toFixed(2),currency_code:'USD'},supplementary_data:{related_ids:{order_id:'order-fixture'}}};
    dodoPayment={payment_id:'payment-fixture',checkout_session_id:'order-fixture',metadata:{paymentRecordId:record._id},status:'succeeded',currency:'USD',total_amount:Math.round(amount*100),tax:0,product_cart:[{product_id:'pdt_fixture',quantity:1}],disputes:[],refunds:[],refund_status:null,customer:{email:'customer@example.invalid'}};
    dodoNotification=null;
  };
  const sendRazorRefund=async(id,amount,status='processed')=>{
    const event={event:`refund.${status}`,payload:{refund:{entity:{id,payment_id:'payment-fixture',amount,currency:'USD',status}}}};
    const rawBody=JSON.stringify(event);
    return flow.handleRazorpayWebhook({client:commerce,req:{body:event,rawBody,headers:{'x-razorpay-signature':crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')}}});
  };
  const sendPayPalRefund=async(id,value,eventId=id)=>{
    const event={id:eventId,event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id,status:'COMPLETED',supplementary_data:{related_ids:{capture_id:'capture-fixture'}},amount:{value,currency_code:'USD'}}};
    return flow.handlePayPalWebhook({client:commerce,req:{body:event,rawBody:JSON.stringify(event),headers:{'paypal-transmission-id':'fixture-transmission','paypal-transmission-time':new Date().toISOString(),'paypal-transmission-sig':'fixture-signature','paypal-cert-url':'https://example.invalid/cert','paypal-auth-algo':'SHA256withRSA'}}});
  };
  const sendDodo=async(alteredBody=false)=>{
    dodoNotification ||= structuredClone({business_id:'business-fixture',type:'payment.succeeded',timestamp:'2026-01-01T00:00:00.000Z',data:dodoPayment});
    const event=alteredBody?{...dodoNotification,timestamp:'2026-01-01T00:00:01.000Z'}:dodoNotification;
    const rawBody=JSON.stringify(event);const timestamp=String(Math.floor(Date.now()/1000));const id=dodoEventId;
    const signature=crypto.createHmac('sha256',Buffer.from('fixture-dodo-secret')).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
    return flow.handleDodoWebhook({client:commerce,req:{body:event,rawBody,headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}}});
  };
  const boundReceiptConflict=()=>{
    negativeProof={nativeConflictAttempts:0,budgetIntercepts:0,limit:3,scope:'Fixture-only stop after3 real23505 responses; never production refusal proof.'};
    fixture.setRequestHook(async(phase,request)=>{
      if(!request.path.endsWith('/roo_apply_commerce_document_mutations')||!request.body.p_mutations?.some(m=>m.operation==='create'&&m.document?._type==='paymentWebhookReceipt'))return;
      if(phase==='after'&&request.response?.code==='23505')negativeProof.nativeConflictAttempts++;
      if(phase==='before'&&negativeProof.nativeConflictAttempts>=3){
        negativeProof.budgetIntercepts++;
        const [snapshot]=await sql`select (select count(*)::int from commerce.webhook_receipts where provider='dodo' and event_id=${dodoEventId}) as receipts,(select count(*)::int from commerce.refunds refund join commerce.payment_records payment on payment.id=refund.payment_record_id where payment.legacy_sanity_id='paymentRecord.fixture') as refunds,(select payload->>'status' from migration.source_documents where legacy_sanity_id='booking.fixture') as booking_status,(select jsonb_array_length(coalesce(payload->'refunds','[]'::jsonb)) from migration.source_documents where legacy_sanity_id='paymentRecord.fixture') as source_refund_entries`;
        negativeProof.persistedSnapshot=snapshot;negativeProof.currentProviderRefundState=dodoPayment.refund_status;
        throw new Error('Negative-proof budget exhausted');
      }
    });
  };
  const assertPayment=async(cents,count,{full=true}={})=>{
    const payment=(await row('paymentRecord.fixture')).payload;const booking=(await row('booking.fixture')).payload;
    assert.equal(payment.refundProcessedAmountInSubunits,cents);assert.equal(payment.refunds.length,count);
    const [projection]=await sql`select payment.provider,payment.status,payment.refund_state,payment.source_revision,payment.backend_owner,payment.booking_id,(select count(*)::int from commerce.refunds refund where refund.payment_record_id=payment.id and refund.status='completed') as refunds,(select coalesce(sum(amount_subunits),0)::int from commerce.refunds refund where refund.payment_record_id=payment.id and refund.status='completed') as refunded_cents from commerce.payment_records payment where payment.legacy_sanity_id='paymentRecord.fixture'`;
    assert.equal(projection.refunds,count);assert.equal(projection.refunded_cents,cents);assert.equal(projection.source_revision,payment._rev);assert.equal(projection.backend_owner,'supabase');
    const [bookingProjection]=await sql`select status,booking_payload,backend_owner,source_revision from commerce.bookings where legacy_sanity_id='booking.fixture'`;
    assert.equal(bookingProjection.source_revision,booking._rev);assert.equal(bookingProjection.backend_owner,'supabase');assert.deepEqual(bookingProjection.booking_payload,booking);
    if(full){assert.equal(payment.status,'refunded');assert.equal(projection.status,'refunded');assert.equal(booking.status,'refunded');assert.equal(booking.refundedAmount,cents/100);assert.equal(bookingProjection.status,'refunded');}
    const [adjacent]=await sql`select count(*)::int as count from commerce.bookings where legacy_sanity_id like 'booking.adjacent.%' and status='completed'`;assert.equal(adjacent.count,1001);
    return{provider:projection.provider,sourceRefundEntries:count,operationalRefundRows:projection.refunds,refundCents:projection.refunded_cents,bookingStatus:bookingProjection.status,unchangedAdjacentBookings:adjacent.count};
  };
  for(const provider of ['paypal','razorpay'])await run(`${provider}-two-partials-projected`,async()=>{
    await resetPayment(provider);
    const send=provider==='paypal'?sendPayPalRefund:(id,value)=>sendRazorRefund(id,Math.round(Number(value)*100));
    const first=await send('refund-first','4.99');assert.equal(first.httpStatus,200,JSON.stringify(first));assert.equal((await row('booking.fixture')).payload.status,'captured');
    const second=await send('refund-second','5.00');assert.equal(second.httpStatus,200,JSON.stringify(second));
    const proof=await assertPayment(999,2);await send('refund-first','4.99','replay-first');await send('refund-second','5.00','replay-second');await assertPayment(999,2);return proof;
  });
  for(const provider of ['paypal','razorpay'])await run(`${provider}-refund-sync-conflict-reconcile-real-transaction`,async()=>{
    await resetPayment(provider);const send=provider==='paypal'?sendPayPalRefund:(id,value)=>sendRazorRefund(id,Math.round(Number(value)*100));assert.equal((await send('refund-first','4.99')).httpStatus,200);
    let conflicted=false;fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='before'||conflicted||!request.path.endsWith('/roo_apply_commerce_document_mutations'))return;
      if(!request.body.p_mutations?.some(m=>m.document?._id==='booking.fixture'&&m.document.refundStatus==='full'))return;
      conflicted=true;fixture.setRequestHook(null);await commerce.patch('booking.fixture').set({fixtureConcurrentEdit:'retained'}).commit();
    });
    const result=await send('refund-second','5.00');assert.equal(conflicted,true);assert.equal(result.httpStatus,202,JSON.stringify(result));assert.equal((await row('booking.fixture')).payload.status,'captured');assert.equal((await row('paymentRecord.fixture')).payload.refundRequiresBookingSync,true);
    const retry=await flow.reconcilePaymentSessions({client:commerce,req:{headers:{authorization:'Bearer fixture-cron'}}});assert.equal(retry.httpStatus,200,JSON.stringify(retry));const proof=await assertPayment(999,2);assert.equal((await row('booking.fixture')).payload.fixtureConcurrentEdit,'retained');return{...proof,initialWebhookStatus:202,reconcileStatus:200,competingEditRetained:true};
  });
  await run('refund-101-distinct-cents-projected',async()=>{
    await resetPayment('razorpay',1.01);
    for(let index=1;index<=101;index++){const result=await sendRazorRefund(`refund-${index}`,1);assert.equal(result.httpStatus,200,JSON.stringify({index,result}));}
    const proof=await assertPayment(101,101);const rebuilt=await client.rpc('roo_refresh_operational_shadow');assert.equal(rebuilt.error,null,JSON.stringify(rebuilt.error));await assertPayment(101,101);return{...proof,fullRebuild:'actual roo_refresh_operational_shadow retains101 entries'};
  });
  await run('refund-monotonic-identity-projected',async()=>{
    await resetPayment();for(const state of ['pending','processed','pending','failed','processed'])assert.equal((await sendRazorRefund('refund-monotonic',200,state)).httpStatus,200);
    const proof=await assertPayment(200,1,{full:false});const refused=await sendRazorRefund('refund-monotonic',999,'processed');assert.equal(refused.httpStatus,409);await assertPayment(200,1,{full:false});return proof;
  });
  for(const variant of ['legacy-amount','legacy-identity','legacy-monotonic'])await run(`refund-${variant}-real-ledger`,async()=>{
    const refundId='refund-legacy';const entry={_key:crypto.createHash('sha256').update(`razorpay:${refundId}`).digest('hex').slice(0,24),providerRefundId:variant==='legacy-identity'?'refund-other':'',providerPaymentId:'payment-fixture',status:'processed',amountInSubunits:200,currency:'USD'};
    await resetPayment('razorpay',9.99,{refunds:[entry],refundProcessedAmountInSubunits:200});
    const result=await sendRazorRefund(refundId,variant==='legacy-amount'?999:200,variant==='legacy-monotonic'?'pending':'processed');assert.equal(result.httpStatus,variant==='legacy-monotonic'?200:409,JSON.stringify(result));
    const record=(await row('paymentRecord.fixture')).payload;assert.equal(record.refundProcessedAmountInSubunits,200);assert.equal(record.refunds.length,1);assert.equal(record.refunds[0].status,'processed');if(variant!=='legacy-monotonic')assert.deepEqual(record.refunds,[entry]);
    const [refunds]=await sql`select count(*)::int as count,coalesce(sum(amount_subunits),0)::int as cents from commerce.refunds where payment_record_id=(select id from commerce.payment_records where legacy_sanity_id='paymentRecord.fixture')`;assert.equal(refunds.cents,200);assert.equal(refunds.count,1);return{constructed:true,sourceRefundEntries:1,operationalRefundRows:refunds.count,retainedCents:200,webhookStatus:result.httpStatus};
  });
  await run('refund-conflict-rebound-real-transaction',async()=>{
    await resetPayment();let rebound=false;
    fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='before'||rebound||!request.path.endsWith('/roo_apply_commerce_document_mutations'))return;
      if(!request.body.p_mutations?.some(m=>m.document?._id==='paymentRecord.fixture'&&m.document.refunds?.length))return;
      rebound=true;fixture.setRequestHook(null);await commerce.patch('paymentRecord.fixture').set({providerPaymentId:'other-payment'}).commit();
    });
    const result=await sendRazorRefund('refund-rebound',999);assert.equal(result.httpStatus,409,JSON.stringify(result));assert.equal(rebound,true);assert.equal((await row('paymentRecord.fixture')).payload.refunds,undefined);assert.equal((await row('booking.fixture')).payload.status,'captured');
    const [count]=await sql`select count(*)::int as count from commerce.refunds where payment_record_id=(select id from commerce.payment_records where legacy_sanity_id='paymentRecord.fixture')`;assert.equal(count.count,0);return{binding:'other-payment',operationalRefundRows:0};
  });
  await run('webhook-stale-lease-takeover-projected',async()=>{
    await resetPayment();let takeover=false;
    fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='after'||takeover||request.status>=300||!request.path.endsWith('/roo_apply_commerce_document_mutations'))return;
      if(!request.body.p_mutations?.some(m=>m.document?._id==='booking.fixture'&&m.document.refundStatus==='full'))return;
      takeover=true;fixture.setRequestHook(null);const receipts=await commerce.fetch('*[_type == "paymentWebhookReceipt"]');assert.equal(receipts.length,1);await commerce.patch(receipts[0]._id).ifRevisionId(receipts[0]._rev).set({leaseId:'new-lease-owner',leaseExpiresAt:new Date(Date.now()+120000).toISOString(),status:'processing'}).commit();
    });
    const result=await sendRazorRefund('refund-takeover',999);assert.equal(result.httpStatus,200,JSON.stringify(result));assert.equal(takeover,true);
    const receipt=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0];assert.equal(receipt.leaseId,'new-lease-owner');assert.equal(receipt.status,'processing');
    const [projection]=await sql`select lease_id,status,source_revision from commerce.webhook_receipts where legacy_sanity_id=${receipt._id}`;assert.equal(projection.lease_id,'new-lease-owner');assert.equal(projection.status,'processing');assert.equal(projection.source_revision,receipt._rev);return projection;
  });
  await run('webhook-expired-lease-real-takeover',async()=>{
    await resetPayment();let takeover=false;let newLease='';let secondResult;
    fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='before'||takeover||!request.path.endsWith('/roo_apply_commerce_document_mutations'))return;
      if(!request.body.p_mutations?.some(m=>m.document?._id==='booking.fixture'&&m.document.refundStatus==='full'))return;
      takeover=true;fixture.setRequestHook(null);const receipt=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0];await commerce.patch(receipt._id).ifRevisionId(receipt._rev).set({leaseExpiresAt:new Date(Date.now()-1000).toISOString()}).commit();
      secondResult=await sendRazorRefund('refund-expired',999);assert.equal(secondResult.httpStatus,200,JSON.stringify(secondResult));newLease=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0].leaseId;assert.notEqual(newLease,receipt.leaseId);
    });
    const result=await sendRazorRefund('refund-expired',999);assert.equal(takeover,true);assert.ok([200,202].includes(result.httpStatus),JSON.stringify(result));const receipt=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0];assert.equal(receipt.leaseId,newLease);assert.equal(receipt.httpStatus,200);assert.equal(receipt.status,'processed');
    const [projection]=await sql`select lease_id,status,http_status from commerce.webhook_receipts where legacy_sanity_id=${receipt._id}`;assert.equal(projection.lease_id,newLease);assert.equal(projection.http_status,200);assert.equal(projection.status,'processed');return{oldWebhookStatus:result.httpStatus,newWebhookStatus:secondResult.httpStatus,latestLeaseRetained:true,scope:'first request paused before booking write; lease persisted expired; second real webhook takes lease and finishes before stale write'};
  });
  await run('dodo-current-provider-state-replay-projected',async()=>{
    await resetPayment('dodo');boundReceiptConflict();assert.equal((await sendDodo()).httpStatus,200);
    const first=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0];const signedNotification=JSON.stringify(dodoNotification);
    dodoPayment.refund_status='partial';dodoPayment.refunds=[{refund_id:'refund-dodo-partial',payment_id:'payment-fixture',amount:200,currency:'USD',status:'succeeded',is_partial:true}];assert.equal((await sendDodo()).httpStatus,200);await assertPayment(200,1,{full:false});assert.equal((await row('booking.fixture')).payload.refundedAmount,2);
    dodoPayment.refund_status='full';dodoPayment.refunds.push({refund_id:'refund-dodo-rest',payment_id:'payment-fixture',amount:799,currency:'USD',status:'succeeded',is_partial:true});assert.equal((await sendDodo()).httpStatus,200);
    const receipts=await commerce.fetch('*[_type == "paymentWebhookReceipt"]');assert.equal(receipts.length,1);assert.equal(receipts[0]._id,first._id);assert.equal(JSON.stringify(dodoNotification),signedNotification);assert.equal(negativeProof.nativeConflictAttempts,0);assert.equal(negativeProof.budgetIntercepts,0);
    return{...await assertPayment(999,2),receiptIdRetained:true,unchangedSignedNotification:true,nativeCreateConflicts:0};
  });
  await run('dodo-new-state-expired-lease-takeover',async()=>{
    await resetPayment('dodo');assert.equal((await sendDodo()).httpStatus,200);dodoPayment.refund_status='partial';dodoPayment.refunds=[{refund_id:'refund-dodo-lease-first',payment_id:'payment-fixture',amount:200,currency:'USD',status:'succeeded',is_partial:true}];
    let takeover=false,newLease='',newResult;
    fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='before'||takeover||!request.path.endsWith('/roo_apply_commerce_document_mutations')||!request.body.p_mutations?.some(m=>m.document?._id==='paymentRecord.fixture'&&m.document.refunds?.length))return;
      takeover=true;fixture.setRequestHook(null);const receipt=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0];await commerce.patch(receipt._id).ifRevisionId(receipt._rev).set({leaseExpiresAt:new Date(Date.now()-1000).toISOString()}).commit();dodoPayment.refund_status='full';dodoPayment.refunds.push({refund_id:'refund-dodo-lease-rest',payment_id:'payment-fixture',amount:799,currency:'USD',status:'succeeded',is_partial:true});newResult=await sendDodo();assert.equal(newResult.httpStatus,200,JSON.stringify(newResult));newLease=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0].leaseId;
    });
    const stale=await sendDodo();assert.equal(takeover,true);assert.ok([200,503].includes(stale.httpStatus),JSON.stringify(stale));const receipts=await commerce.fetch('*[_type == "paymentWebhookReceipt"]');assert.equal(receipts.length,1);assert.equal(receipts[0].leaseId,newLease);assert.equal(receipts[0].status,'processed');return {...await assertPayment(999,2),staleStatus:stale.httpStatus,newStatus:newResult.httpStatus,newLeaseRetained:true};
  });
  await run('dodo-legacy-body-receipt-current-state-refresh',async()=>{
    await resetPayment('dodo');
    const legacyId=`paymentWebhookReceipt.dodo.${crypto.createHash('sha256').update(`${dodoEventId}:payment.succeeded:${JSON.stringify(dodoPayment)}`).digest('hex').slice(0,40)}`;
    await commerce.create({_id:legacyId,_type:'paymentWebhookReceipt',provider:'dodo',eventId:dodoEventId,eventType:'payment.succeeded',status:'processed',backendOwner:'supabase',leaseId:'legacy-lease',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),processedAt:new Date().toISOString()});
    dodoPayment.refund_status='partial';dodoPayment.refunds=[{refund_id:'refund-dodo-legacy',payment_id:'payment-fixture',amount:200,currency:'USD',status:'succeeded',is_partial:true}];boundReceiptConflict();assert.equal((await sendDodo()).httpStatus,200);await assertPayment(200,1,{full:false});const partialReceipts=await commerce.fetch('*[_type == "paymentWebhookReceipt"]');assert.equal(partialReceipts.length,1);assert.equal(partialReceipts[0]._id,legacyId);const unchangedNotification=JSON.stringify(dodoNotification);dodoPayment.refund_status='full';dodoPayment.refunds.push({refund_id:'refund-dodo-legacy-rest',payment_id:'payment-fixture',amount:799,currency:'USD',status:'succeeded',is_partial:true});assert.equal((await sendDodo()).httpStatus,200);const proof=await assertPayment(999,2);const receipts=await commerce.fetch('*[_type == "paymentWebhookReceipt"]');assert.equal(receipts.length,1);assert.equal(receipts[0]._id,legacyId);assert.equal(JSON.stringify(dodoNotification),unchangedNotification);assert.equal(negativeProof.nativeConflictAttempts,0);assert.equal(negativeProof.budgetIntercepts,0);return {...proof,legacyIdRetained:true,unchangedSignedNotification:true,nativeCreateConflicts:0};
  });
  for(const [field,value] of [['providerPaymentId','other-payment'],['paymentRecordId','paymentRecord.other'],['eventType','payment.failed']])await run(`dodo-receipt-conflicting-binding-refused${field==='providerPaymentId'?'':`-${field}`}`,async()=>{
    await resetPayment('dodo');assert.equal((await sendDodo()).httpStatus,200);const receipt=(await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))[0];await commerce.patch(receipt._id).set({[field]:value}).commit();dodoPayment.refund_status='partial';dodoPayment.refunds=[{refund_id:'refund-dodo-rebound',payment_id:'payment-fixture',amount:200,currency:'USD',status:'succeeded',is_partial:true}];boundReceiptConflict();const result=await sendDodo();assert.equal(result.httpStatus,409,JSON.stringify(result));const saved=(await row('paymentRecord.fixture')).payload;assert.equal(saved.refunds,undefined);return {httpStatus:result.httpStatus,field,refusedBinding:value};
  });
  await run('dodo-persistent-native-receipt-conflicts-bounded',async()=>{
    await resetPayment('dodo');assert.equal((await sendDodo()).httpStatus,200);
    dodoPayment.refund_status='partial';dodoPayment.refunds=[{refund_id:'refund-dodo-conflict',payment_id:'payment-fixture',amount:200,currency:'USD',status:'succeeded',is_partial:true}];
    let creates=0,conflicts=0;
    const invisible={...commerce,fetch:async(query,parameters)=>{
      const value=await commerce.fetch(query,parameters);return parameters?.type==='paymentWebhookReceipt'?null:value;
    },create:async(document,options)=>{creates++;try{return await commerce.create(document,options);}catch(error){if(error.code==='23505')conflicts++;throw error;}}};
    const rawBody=JSON.stringify(dodoNotification);const timestamp=String(Math.floor(Date.now()/1000));const signature=crypto.createHmac('sha256',Buffer.from('fixture-dodo-secret')).update(`${dodoEventId}.${timestamp}.${rawBody}`).digest('base64');
    const result=await flow.handleDodoWebhook({client:invisible,req:{body:dodoNotification,rawBody,headers:{'webhook-id':dodoEventId,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}}});
    assert.equal(result.httpStatus,503);assert.equal(creates,3);assert.equal(conflicts,3);
    const [count]=await sql`select count(*)::int count from commerce.webhook_receipts where provider='dodo' and event_id=${dodoEventId}`;assert.equal(count.count,1);assert.equal((await row('paymentRecord.fixture')).payload.refunds,undefined);
    return{httpStatus:503,actualNative23505:conflicts,boundedCreateAttempts:creates,receiptRows:1,scope:'only receipt lookup responses are hidden; each create invokes actual adapter/PostgREST/PostgreSQL uniqueness; no fourth-call safety interceptor'};
  });
  await run('dodo-receipt-rebuild-replay-projected',async()=>{
    await resetPayment('dodo');boundReceiptConflict();dodoPayment.refund_status='full';dodoPayment.refunds=[{refund_id:'refund-dodo-first',payment_id:'payment-fixture',amount:200,currency:'USD',status:'succeeded',is_partial:true},{refund_id:'refund-dodo-rest',payment_id:'payment-fixture',amount:799,currency:'USD',status:'succeeded',is_partial:true}];
    let result=await sendDodo();assert.equal(result.httpStatus,200,JSON.stringify(result));const proof=await assertPayment(999,2);
    for(const receipt of await commerce.fetch('*[_type == "paymentWebhookReceipt"]'))await commerce.delete(receipt._id);
    const rebuilt=await client.rpc('roo_refresh_operational_shadow');assert.equal(rebuilt.error,null,JSON.stringify(rebuilt.error));
    result=await sendDodo();assert.equal(result.httpStatus,200,JSON.stringify(result));await assertPayment(999,2);const [receipts]=await sql`select count(*)::int as count from commerce.webhook_receipts where event_id=${dodoEventId}`;assert.equal(receipts.count,1);return{...proof,rebuiltReceiptRows:receipts.count};
  });
  await run('webhook-same-id-changed-notification-current-payment',async()=>{
    await resetPayment('dodo');assert.equal((await sendDodo()).httpStatus,200);let attempts=0;
    fixture.setRequestHook(async(phase,request)=>{
      if(phase!=='before'||!request.path.endsWith('/roo_apply_commerce_document_mutations'))return;
      if(!request.body.p_mutations?.some(m=>m.operation==='create'&&m.document?._type==='paymentWebhookReceipt'))return;
      attempts++;if(attempts>3)throw new Error('Negative-proof budget exhausted');
    });
    let result;try{result=await sendDodo(true);}finally{fixture.setRequestHook(null);}
    const [count]=await sql`select count(*)::int as count from commerce.webhook_receipts where provider='dodo' and event_id=${dodoEventId}`;assert.equal(count.count,1);
    assert.equal(attempts,0);assert.equal(result.httpStatus,200);return{constructed:true,receiptRows:count.count,additionalCreates:attempts,scope:'changed signed notification; fetched current payment unchanged'};
  });

  assert.ok(evidence.scenarios.length,'Unknown scenario');
  assert.equal(blockedNetwork,0);
  const contracts=await sql`select namespace.nspname as schema,proc.proname as name,pg_get_function_identity_arguments(proc.oid) as arguments,pg_get_functiondef(proc.oid) as definition from pg_proc proc join pg_namespace namespace on namespace.oid=proc.pronamespace where namespace.nspname in ('accounts','commerce','migration','public') and proc.prokind='f' order by namespace.nspname,proc.proname,arguments`;
  fs.writeFileSync(path.join(fixture.scratch,'current-functions.sql'),contracts.map(entry=>entry.definition).join('\n'));
  evidence.functions=contracts.map(({schema,name,arguments:arguments_,definition})=>({schema,name,arguments:arguments_,sha256:crypto.createHash('sha256').update(definition).digest('hex')}));
  evidence.constraints=await sql`select namespace.nspname as schema,relation.relname as table_name,constraint_.conname as name,pg_get_constraintdef(constraint_.oid) as definition from pg_constraint constraint_ join pg_class relation on relation.oid=constraint_.conrelid join pg_namespace namespace on namespace.oid=relation.relnamespace where namespace.nspname in ('accounts','commerce','migration') order by namespace.nspname,relation.relname,constraint_.conname`;
  evidence.triggers=await sql`select namespace.nspname as schema,relation.relname as table_name,trigger_.tgname as name,pg_get_triggerdef(trigger_.oid) as definition from pg_trigger trigger_ join pg_class relation on relation.oid=trigger_.tgrelid join pg_namespace namespace on namespace.oid=relation.relnamespace where not trigger_.tgisinternal and namespace.nspname in ('accounts','commerce','migration','public') order by namespace.nspname,relation.relname,trigger_.tgname`;
  const [counts]=await sql`select (select count(*)::int from migration.source_documents) as source_documents,(select count(*)::int from commerce.bookings) as bookings,(select count(*)::int from commerce.payment_records) as payments,(select count(*)::int from commerce.refunds) as refunds,(select count(*)::int from commerce.webhook_receipts) as receipts,(select count(*)::int from accounts.credential_operations) as credential_operations`;
  evidence.finalRecordCounts=counts;
  evidence.modules=Object.fromEntries(['@supabase/supabase-js','@supabase/ssr','postgres','bcryptjs'].map(name=>[name,JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version]));
  evidence.ok=evidence.scenarios.every(s=>s.passed);
}catch(error){evidence.ok=false;evidence.failure={message:error.message,code:error.code||error.cause?.code,stack:error.stack,scratch:error.scratch,manifest:error.manifest};}
finally{
  globalThis.fetch=realFetch;
  if(fixture){evidence.runtime={postgres:fixture.postgresVersion,postgrest:fixture.postgrestVersion,host:testHost,scratch:fixture.scratch};evidence.appliedSql=fixture.manifest;evidence.requests={rest:fixture.requestLog.length,authUpdates:authUpdatesTotal,providerFixtures:providerRequests,blockedNetwork,rpcs:Object.fromEntries([...new Set(fixture.requestLog.filter(r=>r.rpc).map(r=>r.rpc))].map(name=>[name,fixture.requestLog.filter(r=>r.rpc===name).length]))};try{await fixture.stop();evidence.servicesStopped=true;}catch(error){evidence.ok=false;evidence.stopFailure=error.message;}}
  fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,`${JSON.stringify(evidence,null,2)}\n`);
  process.stdout.write(`${JSON.stringify({ok:evidence.ok,scenarios:evidence.scenarios.map(({name,passed,error})=>({name,passed,error})),failure:evidence.failure?.message,artifact,scratch:evidence.runtime?.scratch||evidence.failure?.scratch})}\n`);
}
if(!evidence.ok)process.exitCode=1;

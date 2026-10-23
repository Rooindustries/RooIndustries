import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const host=process.env.ROO_TEST_HOST||'127.0.0.1';
const originalFetch=globalThis.fetch;
const originalNow=Date.now;
const originalDate=Date;
const fullChain=process.argv.includes('--full-chain');
const legacyOwner=process.argv.includes('--legacy-owner');
const legacyVendorEnvironment=process.argv.includes('--leftover-vendor-env');
const sourceText=name=>fs.readFileSync(path.join(process.cwd(),name),'utf8');
const a1Mode=process.argv.includes('--a1')||process.argv.some(v=>v.startsWith('--scenario=')&&v.includes('a1-'));
const restores=[];
const summaryWarnings = [];
const originalWarn = console.warn;
console.warn = (...values) => { summaryWarnings.push(values); originalWarn(...values); };
restores.push(() => { console.warn = originalWarn; });
for(const key of Object.keys(process.env))if(/SENTRY.*DSN/i.test(key)||/^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND|BOOKING_EMAIL|FROM_EMAIL|OWNER_EMAIL|DATA_|COMMERCE_|VERCEL_ENV|REF_SESSION|CRON_|RATE_LIMIT_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|NODE_USE_ENV_PROXY)/.test(key))delete process.env[key];
process.env.RESEND_API_KEY='re_fixture';
if(a1Mode||process.argv.includes('--a2'))Object.assign(process.env,{FROM_EMAIL:'noreply@example.invalid',OWNER_EMAIL:'owner@example.invalid'});
Object.assign(process.env,{NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'supabase',COMMERCE_PRIMARY_BACKEND:'supabase',COMMERCE_FAILOVER_GENERATION:'0',PAYPAL_ENV:'sandbox',PAYPAL_CLIENT_ID:'fixture-client',PAYPAL_CLIENT_SECRET:'fixture-secret',PAYPAL_WEBHOOK_ID:'fixture-webhook',RAZORPAY_KEY_ID:'rzp_test_fixture',RAZORPAY_KEY_SECRET:'fixture-secret',RAZORPAY_WEBHOOK_SECRET:'fixture-webhook-secret',PAYMENT_SESSION_SECRET:'fixture-session-secret',REF_SESSION_SECRET:'fixture-ref-session-secret',CRON_SECRET:'fixture-cron',DODO_PAYMENTS_ENVIRONMENT:'test_mode',DODO_PAYMENTS_API_KEY:'fixture-dodo',DODO_PAYMENTS_WEBHOOK_KEY:`whsec_${Buffer.from('fixture-dodo-secret').toString('base64')}`,DODO_PAYMENTS_PRODUCT_ID:'pdt_fixture',DODO_PAYMENTS_RETURN_URL:'https://example.invalid/checkout'});
if(legacyVendorEnvironment)Object.assign(process.env,{SANITY_PROJECT_ID:'synthetic-ignored',SANITY_DATASET:'production',SANITY_READ_TOKEN:'synthetic-ignored-read',SANITY_WRITE_TOKEN:'synthetic-ignored-write',SANITY_API_VERSION:'2023-10-01',NEXT_PUBLIC_SANITY_PROJECT_ID:'synthetic-ignored',NEXT_PUBLIC_SANITY_DATASET:'synthetic-ignored',SANITY_PRIVATE_API_VERSION:'synthetic-ignored',SANITY_PRIVATE_DATASET:'synthetic-ignored',SANITY_PRIVATE_PROJECT_ID:'synthetic-ignored',SANITY_PRIVATE_READ_TOKEN:'synthetic-ignored',SANITY_PRIVATE_WRITE_TOKEN:'synthetic-ignored',SANITY_USER_API_VERSION:'synthetic-ignored',SANITY_WEBHOOK_SECRET:'synthetic-ignored',SANITY_REVERSE_MIRROR_WRITES:'1',SANITY_STUDIO_CMS_WRITES_PAUSED:'1'});
if(process.argv.includes('--currency-config'))Object.assign(process.env,{PAYPAL_CURRENCY:'EUR',RAZORPAY_CURRENCY:'KWD'});
const local=(value)=>{const url=new URL(value);assert.equal(url.protocol,'http:');assert.equal(url.hostname,host);assert.ok(url.port);assert.ok(!url.username&&!url.password);return url;};
globalThis.fetch=(input,init)=>{local(typeof input==='string'||input instanceof URL?String(input):input.url);return originalFetch(input,{...init,redirect:'error',signal:init?.signal||AbortSignal.timeout(30000)});};
for(const [module,protocol] of [[http,'http:'],[https,'https:']]){
  const request=module.request,get=module.get;
  module.request=function(input,options,callback){const settings=typeof input==='object'&&!(input instanceof URL)?input:typeof options==='object'?options:{};assert.ok(!settings.socketPath&&!settings.createConnection);local(typeof input==='string'||input instanceof URL?String(input):`${settings.protocol||protocol}//${settings.hostname||settings.host||'localhost'}:${settings.port||80}${settings.path||'/'}`);return request.call(this,input,options,callback);};
  module.get=function(...args){const req=module.request(...args);req.end();return req;};restores.push(()=>{module.request=request;module.get=get;});
}
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(specifier==='next/server')return nextResolve('next/server.js',context);if(!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;for(const suffix of ['.js','.ts','/index.js']){const candidate=new URL(`${specifier}${suffix}`,context.parentURL);if(fs.existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);}throw error;}}});
const only=process.argv.find(v=>v.startsWith('--scenario='))?.slice(11).split(',');
const a2Mode=process.argv.includes('--a2');
const currencyMode=process.argv.includes('--currency-config');
const recoveryMode = process.argv.includes('--recovery');
const reportMode = process.argv.includes('--reconcile-report');
const supportedScenario=name=>(!recoveryMode || name.startsWith('recovery-')) &&
  (!reportMode || name.startsWith('reconcile-report-')) &&
  (!name.startsWith('a1-')||a1Mode)&&
  (!/^(a2-|fix-c-legacy-)/.test(name)||a2Mode)&&
  (!name.startsWith('currency-configured-')||currencyMode)&&
  (!name.startsWith('gate-')||a2Mode);
if(only?.some(name=>!supportedScenario(name)))throw new Error('Selected fixture group requires --a1, --a2, or --currency-config; use the documented matching flag.');
const artifact=path.resolve(process.env.ROO_PAYMENT_PERSISTENCE_ARTIFACT||'test-results/payment-persistence-sweep.json');
fs.mkdirSync(path.dirname(artifact),{recursive:true});
const evidence={checkedAt:new Date().toISOString(),productionRequests:0,scenarios:[],standIns:[{boundary:'Provider HTTP',scope:'Synthetic PayPal/Razorpay/Dodo response shapes and held requests/disconnects through actual provider clients and Dodo SDK; no live API.'},{boundary:'Coupon dependency failure',scope:'The release case throws through an injected callback; release-stored reruns the boundary through the real coupon release module against a missing revision in PostgreSQL.'},{boundary:'Clock',scope:'For takeover cases Date.now advances91000ms inside this isolated process; stored90s lease timestamps and actual native projection remain real. PostgreSQL clock is not changed.'},{boundary:'Auth HTTP',scope:'Synthetic signed user response; actual installed SSR/AuthSDK selects submitted cookies and actual account/domain SQL evaluates identity. Hosted GoTrue excluded.'},{boundary:'Local infrastructure/grants',scope:'Shared fixture bootstrap auth/storage tables and expanded service_role grants. Actual repository account/commerce/migration SQL; hosted RLS and migration ledger excluded.'}],limits:['No Sanity query engine, hosted GoTrue/RLS, provider services, UI/browser, production Next server or full build.']};
let fixture,server,origin,commerce,documents,flow,access,sql,providers,a1Ui;
evidence.sourceEdition='current source';
let razorpayRefunds=[];
let dodoList=[];
let dodoPayment,dodoRefund,paypalOrder,paypalCapture,razorpayPayment,verificationStatus,verificationDisconnect,providerHook;
let providerRequests=[],blockedNetwork=0,authUnlinks=0,scenarioNumber=0,authUser,emailFailure=false;
const recordId='paymentRecord.fixture',bookingId='booking.fixture';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const row=async id=>(await sql`select payload,source_revision,tombstoned from migration.source_documents where legacy_sanity_id=${id}`)[0];
const record=async()=> (await row(recordId))?.payload;
const removeRevision=async(id,state)=>{await sql`update migration.source_documents set payload=case when ${state}='null' then jsonb_set(payload,'{_rev}','null'::jsonb) else payload-'_rev' end,source_revision=null where legacy_sanity_id=${id}`;};
const snapshot=async({receipts=false}={})=>{
  const source=await sql`select legacy_sanity_id,payload,source_revision,tombstoned from migration.source_documents where (${receipts} or document_type<>'paymentWebhookReceipt') order by legacy_sanity_id`;
  const tables={};for(const name of ['payment_records','bookings','refunds','payment_events','payment_start_claims','payment_proof_claims','payment_upgrade_locks','slot_holds','slot_claims','coupons','coupon_redemptions','referral_ledger'])tables[name]=await sql.unsafe(`select to_jsonb(t) as row from commerce.${name} t order by to_jsonb(t)::text`);
  tables.commerce_outbox=await sql`select to_jsonb(t) as row from migration.commerce_mirror_outbox t where (${receipts} or exists(select 1 from jsonb_array_elements(t.documents) d where d->>'_type'<>'paymentWebhookReceipt') or exists(select 1 from unnest(t.deleted_ids) d where d not like 'paymentWebhookReceipt.%')) order by id`;
  tables.document_outbox=await sql`select to_jsonb(t) as row from migration.document_mutation_mirror_outbox t order by sequence_no`;
  if(receipts)tables.webhook_receipts=await sql`select to_jsonb(t) as row from commerce.webhook_receipts t order by id`;
  return{source,tables};
};
const reset=async()=>{
  globalThis.Date=originalDate;
  if(!process.argv.includes('--fix-c-rate-before'))globalThis.__rooRateLimitBuckets?.clear();
  Date.now=originalNow;fixture.setRequestHook(null);providerHook=null;razorpayRefunds=[];scenarioNumber++;providerRequests=[];emailFailure=false;verificationStatus=200;verificationDisconnect=false;
  await sql.begin(async tx=>{
    await tx`delete from commerce.coupon_redemptions`;
    await tx`delete from commerce.slot_claims`;
    await tx`delete from commerce.booking_slots`;
    await tx`delete from commerce.recovery_cases`;
    await tx`delete from commerce.booking_slots`;
    await tx`delete from commerce.slot_holds`;
    await tx`delete from commerce.payment_records`;
    await tx`delete from commerce.bookings`;
    await tx`delete from commerce.webhook_receipts`;
    await tx`delete from migration.commerce_mirror_outbox`;
    await tx`delete from migration.commerce_commands`;
    await tx`delete from migration.source_documents where document_type in ('paymentRecord','paymentWebhookReceipt','paymentProofClaim','paymentStartClaim','paymentUpgradeLock','booking','bookingSlot','bookingRecoveryCase','slotHold','couponReservation','couponRedemption')`;
  });
  paypalOrder={id:'order-fixture',status:'COMPLETED',intent:'CAPTURE',purchase_units:[{amount:{value:'9.99',currency_code:'USD'},payments:{captures:[{id:'capture-fixture',status:'COMPLETED',amount:{value:'9.99',currency_code:'USD'}}]}}]};
  paypalCapture={id:'capture-fixture',status:'REFUNDED',amount:{value:'9.99',currency_code:'USD'},supplementary_data:{related_ids:{order_id:'order-fixture'}}};
  razorpayPayment={id:'payment-fixture',order_id:'order-fixture',status:'captured',captured:true,amount:999,currency:'USD',amount_refunded:0,refund_status:null};
  dodoPayment={billing:{country:'US',city:'Fixture',state:'Fixture',street:'Synthetic address',zipcode:'00000'},brand_id:'brand-fixture',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',digital_products_delivered:false,is_update_payment_method:false,payment_provider:'dodo',retry_attempt:0,settlement_amount:999,settlement_currency:'USD',payment_id:'payment-fixture',checkout_session_id:'order-fixture',metadata:{paymentRecordId:recordId},status:'succeeded',currency:'USD',total_amount:999,tax:0,product_cart:[{product_id:'pdt_fixture',quantity:1}],disputes:[],refunds:[],refund_status:null,customer:{customer_id:'customer-fixture',name:'Fixture',email:'customer@example.invalid'}};
  dodoList=[];
  dodoRefund={business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',customer:{customer_id:'customer-fixture',name:'Fixture',email:'customer@example.invalid'},metadata:{},refund_id:'refund-fixture',payment_id:'payment-fixture',amount:999,currency:'USD',status:'succeeded',is_partial:false};
};
const seed=async(provider='paypal',status='booked',changes={})=>{
  if(changes.booking!==null)await commerce.create({_id:bookingId,_type:'booking',status:'captured',netAmount:9.99,commissionAmount:1,packageTitle:'Vertex Essentials',email:'customer@example.invalid',paypalOrderId:provider==='paypal'?'order-fixture':'',razorpayOrderId:provider==='razorpay'?'order-fixture':'',razorpayPaymentId:provider==='razorpay'?'payment-fixture':'',backendOwner:legacyOwner?'sanity':'supabase',cutoverGeneration:0,...changes.booking});
  return commerce.create({_id:recordId,_type:'paymentRecord',provider,backendOwner:legacyOwner?'sanity':'supabase',cutoverGeneration:0,status,providerOrderId:'order-fixture',providerPaymentId:provider==='paypal'?'capture-fixture':'payment-fixture',bookingId,sessionScope:'fixture-session',providerIdempotencyKey:'fixture-key',bookingPayload:{packageTitle:'Vertex Essentials',email:'customer@example.invalid',startTimeUTC:'2099-01-01T10:00:00.000Z'},pricingFingerprint:'fixture-pricing',pricingSnapshot:{netAmount:9.99},providerPublicData:{currency:'USD',productId:'pdt_fixture',environment:'test_mode',taxInclusive:false,totalAmount:999},sessionExpiresAt:'2099-01-01T10:00:00.000Z',emailDispatch:{allSent:true},...changes.record});
};
const tokenFor=r=>access.createPaymentAccessToken({paymentRecordId:r._id,provider:r.provider,pricingFingerprint:r.pricingFingerprint,backend:'supabase',cutoverGeneration:0,expirySeconds:600});
const paypalReq=(type,resource,id=`event-fixture-${scenarioNumber}`)=>{const body={id,event_type:type,resource};return{body,rawBody:JSON.stringify(body),headers:{'paypal-transmission-id':'fixture-transmission','paypal-transmission-time':new Date().toISOString(),'paypal-transmission-sig':'fixture-signature','paypal-cert-url':'https://example.invalid/cert','paypal-auth-algo':'SHA256withRSA'}};};
const razorReq=(type,payload)=>{const body={event:type,payload};const rawBody=JSON.stringify(body);return{body,rawBody,headers:{'x-razorpay-signature':crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')}};};
const dodoReq=(payment=dodoPayment,type='payment.succeeded',id=`dodo-fixture-${scenarioNumber}`)=>{const body={business_id:'business-fixture',type,timestamp:'2026-01-01T00:00:00.000Z',data:payment};const rawBody=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));const signature=crypto.createHmac('sha256',Buffer.from('fixture-dodo-secret')).update(`${id}.${timestamp}.${rawBody}`).digest('base64');return{body,rawBody,headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}};};
const requestFlow=async(action,input={})=>{const response=await fetch(`${origin}/flow/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});return{status:response.status,body:await response.json()};};
const assertRefund=async({reversed=false}={})=>{
  const r=await record(),b=(await row(bookingId)).payload;
  const [p]=await sql`select status,refund_state,source_revision,backend_owner from commerce.payment_records where legacy_sanity_id=${recordId}`;
  const [bt]=await sql`select status,currency,amount_subunits,booking_payload,source_revision from commerce.bookings where legacy_sanity_id=${bookingId}`;
  const [ledger]=await sql`select count(*)::int as count,coalesce(sum(amount_subunits),0)::int as cents from commerce.refunds where payment_record_id=(select id from commerce.payment_records where legacy_sanity_id=${recordId}) and status=${reversed?'reversed':'completed'}`;
  assert.equal(r.status,'refunded');assert.equal(r.refundProcessedAmountInSubunits,999);assert.equal(r.refunds.length,1);assert.equal(b.status,'refunded');assert.equal(b.refundStatus,'full');assert.equal(b.refundedAmount,9.99);assert.equal(p.status,'refunded');assert.equal(p.source_revision,r._rev);assert.equal(bt.status,'refunded');assert.equal(bt.currency,r.providerPublicData.currency);assert.equal(Number(bt.amount_subunits),999);assert.deepEqual(bt.booking_payload,b);assert.equal(bt.source_revision,b._rev);assert.equal(ledger.count,1);assert.equal(ledger.cents,999);return{sourceStatus:r.status,sourceRefundCents:r.refundProcessedAmountInSubunits,typedPayment:p,typedRefundLedger:{...ledger,status:reversed?'reversed':'completed'},typedBooking:{status:bt.status,currency:bt.currency,amountSubunits:Number(bt.amount_subunits),refundedAmount:bt.booking_payload.refundedAmount,refundStatus:bt.booking_payload.refundStatus}};
};
const a1RebuildProof=async(name)=>{
  const money=async()=>({payment:await sql`select to_jsonb(t)-'imported_at'-'updated_at' as row from commerce.payment_records t order by legacy_sanity_id`,booking:await sql`select to_jsonb(t)-'imported_at'-'updated_at' as row from commerce.bookings t order by legacy_sanity_id`,email:await sql`select to_jsonb(t)-'updated_at' as row from commerce.email_dispatches t order by booking_id,dispatch_kind,recipient_type`});
  const incremental=await money(),rebuilds={};
  for(const [label,rpc] of [['originalFull','roo_project_operational_shadow'],['currentRefresh','roo_refresh_operational_shadow']]){assert.equal((await fixture.client.rpc(rpc)).error,null);rebuilds[label]=await money();}
  const proof={incremental,...rebuilds};fs.writeFileSync(`${artifact}.${name}.all-rebuild-rows.json`,JSON.stringify(proof,null,2));
  for(const rebuilt of Object.values(rebuilds))assert.deepEqual(rebuilt,incremental);
  return{incremental,...rebuilds,ignoredFields:['imported_at','updated_at'],sourceFinancialAndEmailFieldsIdentical:true};
};
const run = async (name, fn) => {
  if (!supportedScenario(name) || (only && !only.includes(name))) return;
  const emailSettings = { FROM_EMAIL: process.env.FROM_EMAIL, OWNER_EMAIL: process.env.OWNER_EMAIL };
  if (name.startsWith('recovery-')) {
    Object.assign(process.env, { FROM_EMAIL: 'noreply@example.invalid', OWNER_EMAIL: 'owner@example.invalid' });
  }
  const start = originalNow();
  let proof;
  try {
    await reset();
    proof = await fn();
    if (/^a1-.*(?:-client-(?:cron|webhook)|-uppercase-referral-preserved-payload-(?:cron|webhook)|-email-failure-completion-and-retry)$/.test(name)) {
      proof.fullProjectionProof = await a1RebuildProof(name);
    }
    evidence.scenarios.push({ name, passed: true, durationMs: originalNow() - start, proof,
      persisted: await snapshot({ receipts: true }), providerRequests: [...providerRequests] });
  } catch (error) {
    evidence.scenarios.push({ name, passed: false, durationMs: originalNow() - start,
      error: error.message, code: error.code, stack: error.stack, proof,
      providerRequests: [...providerRequests], persisted: await snapshot({ receipts: true }).catch(() => null) });
  } finally {
    for (const [key, value] of Object.entries(emailSettings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Date.now = originalNow;
    providerHook = null;
    fixture.setRequestHook(null);
  }
};

try{

  server=http.createServer(async(req,res)=>{try{
    const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString();
    if(req.url==='/a1-ui-complete'){assert.ok(a1Ui);a1Ui.done.resolve(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
    if(req.url==='/a1-paypal-stale-capture'){
      assert.ok(a1Ui);const source=sourceText('src/components/Payment.jsx');
      const onApprove=source.match(/onApprove=\{(async[\s\S]+?)\}\s+onError=/)?.[1];
      const finalize=source.slice(source.indexOf('  const finalizeSessionCheckout ='),source.indexOf('\n  const handleDodoCheckout',source.indexOf('  const finalizeSessionCheckout =')));
      assert.ok(onApprove&&finalize.includes('fetchJson'));
      const html=`<!doctype html><html><head><title>Roo Industries local PayPal continuation</title></head><body><h1>Local PayPal capture continuation</h1><p id="state">Ready</p><button id="run">Capture, then close checkout</button><pre id="proof"></pre><script>
      let current=true;const uiUpdates=[];const session=${JSON.stringify(a1Ui.session)};
      const getActivePaymentSession=()=>session,createPaymentOperation=()=>({current:()=>current}),ensureSlotBeforeAction=()=>true;
      const setPaymentStatusBusy=value=>uiUpdates.push({busy:value}),navigate=(...args)=>uiUpdates.push({navigate:args}),showBanner=(...args)=>uiUpdates.push({banner:args});
      const fetchJson=async(url,init)=>{const parsed=JSON.parse(init.body);const response=await fetch('/flow/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paymentAccessToken:session.paymentAccessToken,body:parsed})});return{response,data:await response.json()};};
      ${finalize}
      const onApprove=${onApprove};
      window.runScenario=async()=>{let resolveCapture;const capture=new Promise(resolve=>resolveCapture=resolve);const pending=onApprove({orderID:'order-fixture'},{order:{capture:()=>capture}});await Promise.resolve();current=false;document.getElementById('state').textContent='Checkout view closed before capture response';const updatesAtClose=uiUpdates.length;resolveCapture({id:'order-fixture',payer:{email_address:'customer@example.invalid'}});await pending;const proof={stale:true,updatesAtClose,updatesAfterClose:uiUpdates.slice(updatesAtClose),renderedState:document.getElementById('state').textContent};window.a1Proof=proof;document.getElementById('proof').textContent=JSON.stringify(proof,null,2);await fetch('/a1-ui-complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(proof)});return proof;};document.getElementById('run').onclick=()=>window.runScenario();</script></body></html>`;
      res.writeHead(200,{'content-type':'text/html'});res.end(html);return;
    }
    if (req.url === '/cancel-route') {
      const { default: handler } = await import('../src/server/api/payment/cancel.js');
      const response = {
        status(code) { this.statusCode = code; return this; },
        setHeader(name, value) { res.setHeader(name, value); },
        json(body) {
          res.writeHead(this.statusCode || 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
          return this;
        },
      };
      await handler({ method: 'POST', headers: req.headers, body: JSON.parse(raw) }, response);
      return;
    }
    if (req.url === '/start-route') {
      const { default: handler } = await import('../src/server/api/payment/start.js');
      const response = { status(code) { this.statusCode = code; return this; }, setHeader(name, value) { res.setHeader(name, value); }, json(body) { res.writeHead(this.statusCode || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return this; } };
      await handler({ method: 'POST', headers: {}, body: JSON.parse(raw) }, response);
      return;
    }
    if(req.url.startsWith('/flow/')){const input=raw?JSON.parse(raw):{};
      const override = input.confirmationReadOverride;
      const summaryClient = override ? new Proxy(commerce, { get(target, key) {
        if (key === 'fetch') return async (query, params) => {
          if (override.failBookingRead && query.includes('_type == "booking"')) throw new Error('Synthetic booking read failure');
          const result = await target.fetch(query, params);
          if (result?._id === recordId && override.record) return { ...result, ...override.record };
          if (result?._id === bookingId && override.booking) return { ...result, ...override.booking };
          return result;
        };
        return target[key];
      } }) : commerce;
      const args={...input,client:summaryClient};const action=req.url.slice(6);let result;
      if(action==='paypal')result=await flow.handlePayPalWebhook(args);else if(action==='razorpay')result=await flow.handleRazorpayWebhook(args);else if(action==='dodo')result=await flow.handleDodoWebhook(args);else if(action==='finalize')result=await flow.finalizePaymentSession(args);else if(action==='cancel')result=await flow.cancelPaymentSession(args);else if(action==='reconcile')result=await flow.reconcilePaymentSessions({client:commerce,req:{headers:{authorization:'Bearer fixture-cron'}}});else if(action==='start')result=await flow.startPaymentSession(args);else if(action==='status')result=await flow.getPaymentStatus(args);else throw new Error(`Unknown action ${action}`);res.writeHead(result.httpStatus,{'content-type':'application/json'});res.end(JSON.stringify(result.body));return;}
    if(req.url==='/booking'){const {default:handler}=await import('../src/server/api/ref/createBooking.js');const input=JSON.parse(raw),response={status(code){this.statusCode=code;return this;},json(body){res.writeHead(this.statusCode||200,{'content-type':'application/json'});res.end(JSON.stringify(body));return this;},setHeader(){}};await handler({method:'POST',headers:{},body:input.body,internalContext:input.internal?{documentClient:commerce,backendOwner:'supabase',cutoverGeneration:0,paymentFinalizeSource:'reconcile'}:undefined},response);return;}
    if(req.url==='/reconcile-route'){const {default:handler}=await import('../src/server/api/payment/reconcile.js');const response={status(code){this.statusCode=code;return this;},json(body){res.writeHead(this.statusCode||200,{'content-type':'application/json'});res.end(JSON.stringify(body));return this;},setHeader(){}};await handler({method:'POST',headers:{authorization:'Bearer fixture-cron'}},response);return;}
    if (req.url === '/reconcile-report') {
      const input = JSON.parse(raw || '{}');
      const report = await import('../src/server/api/payment/reconcileReport.js');
      if (input.route) {
        if (input.nextRoute) {
          const route = await import('../app/api/payment/[action]/route.js');
          const method = input.method || 'GET';
          const url = new URL(`${origin}/api/payment/report`);
          for (const [name, value] of Object.entries(input.query || {})) {
            for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(name, entry);
          }
          const request = new Request(url, { method, headers: input.headers || {} });
          const result = await route[method === 'POST' ? 'POST' : 'GET'](request, { params: Promise.resolve({ action: 'report' }) });
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(await result.text());
          return;
        }
        const headers = { 'content-type': 'application/json' };
        const response = {
          status(code) { this.statusCode = code; return this; },
          json(body) {
            res.writeHead(this.statusCode || 200, headers);
            res.end(JSON.stringify(body));
            return this;
          },
          setHeader(name, value) { headers[name.toLowerCase()] = value; },
        };
        await report.default({ method: input.method || 'GET', headers: input.headers || {}, query: input.query || {} }, response);
        return;
      }
      const body = await report.buildReconcileReport({ client: commerce, now: input.now, checks: input.checks });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if(req.url==='/identities'){const {POST}=await import('../app/api/auth/identities/route.js');const result=await POST(new Request(`${origin}/identities`,{method:req.method,headers:req.headers,body:raw}));res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;}
    const request={method:req.method,path:req.url,body:raw?(String(req.headers['content-type']||'').includes('application/json')?JSON.parse(raw):raw):null};providerRequests.push({method:req.method,path:req.url});
    if(providerHook){const result=await providerHook(request,req,res);if(result===true)return;}
    let body,status=200;
    if(req.url==='/v1/oauth2/token')body={access_token:'fixture-access',expires_in:3600};else if(req.url==='/v1/notifications/verify-webhook-signature'){if(verificationDisconnect){req.socket.destroy();return;}status=verificationStatus;body={verification_status:'SUCCESS'};}
    else if(req.url==='/emails'){status=emailFailure?503:200;body=emailFailure?{name:'application_error',message:'Synthetic delivery failure'}:{id:`email-fixture-${scenarioNumber}-${providerRequests.length}`};}else if(req.url==='/v2/checkout/orders/order-fixture')body=paypalOrder;else if(req.url==='/v2/payments/captures/capture-fixture')body=paypalCapture;
    else if(req.url.startsWith('/v1/payments/payment-fixture/refunds'))body={entity:'collection',count:razorpayRefunds.length,items:razorpayRefunds};else if(req.url==='/v1/payments/payment-fixture')body=razorpayPayment;else if(req.url==='/v1/orders/order-fixture/payments')body={items:[razorpayPayment]};else if(req.url==='/v1/orders/order-fixture')body={id:'order-fixture',status:'paid',amount_paid:999,currency:'USD'};
    else if(req.url.startsWith('/payments?'))body={items:dodoList};else if(req.url==='/payments/payment-fixture')body=dodoPayment;else if(req.url==='/payments/payment-gone'){status=404;body={code:'NOT_FOUND',message:'Payment not found'};}else if(req.url==='/refunds/refund-fixture')body=dodoRefund;else if(req.url==='/checkouts/order-fixture')body={id:'order-fixture',payment_id:'payment-fixture'};else throw new Error(`Unexpected local provider path ${req.url}`);
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));
  }catch(error){if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({fixtureError:error.message}));}}});
  server.listen(0,host);await once(server,'listening');origin=`http://${host}:${server.address().port}`;
  const { createSweepPostgresFixture } = await import('./lib/sweep-postgres-fixture.mjs');
  fixture = await createSweepPostgresFixture({ fullMigrationChain: fullChain });
  sql = fixture.sql;
  if (!fullChain) await fixture.apply('20261005000500_project_booking_payment_currency_subunits.sql');
  if (!fullChain) await fixture.apply('20261013000000_skip_review_only_recovery_rows.sql');
  const providerOrigins=new Set(['https://api-m.sandbox.paypal.com','https://api.razorpay.com','https://test.dodopayments.com','https://api.resend.com']);
  globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);let target;
    if([fixture.origin,origin].includes(url.origin))target=url.href;else if(providerOrigins.has(url.origin))target=`${origin}${url.pathname}${url.search}`;else{blockedNetwork++;throw new Error(`Nonlocal destination blocked ${url.origin}`);}return originalFetch(target,{...init,redirect:'error',signal:init?.signal||AbortSignal.timeout(30000)});};
  Object.assign(process.env,{SUPABASE_URL:fixture.origin,SUPABASE_SERVICE_ROLE_KEY:fixture.token,NEXT_PUBLIC_SUPABASE_URL:fixture.origin,NEXT_PUBLIC_SUPABASE_ANON_KEY:fixture.token});
  ({createSupabaseDocumentClient:documents}=await import('../src/server/supabase/documentClient.js'));commerce=documents({shadowClient:fixture.client,commerceOnly:true,cutoverGeneration:0});documents=documents({shadowClient:fixture.client});
  flow=await import('../src/server/api/payment/flow.js');access=await import('../src/server/api/payment/accessToken.js');providers=await import('../src/server/api/payment/providerClients.js');

  for(const provider of ['paypal','razorpay'])for(const mode of ['retryable','verified'])await run(`finalization-lease-takeover-${provider}-${mode}`,async()=>{
    const r=await seed(provider,'started',{record:{bookingId:'',finalizationLeaseId:'',finalizationLeaseExpiresAt:''}}),aGate=deferred(),bGate=deferred(),aStarted=deferred(),bStarted=deferred();let requests=0;
    const target=provider==='paypal'?'/v2/checkout/orders/order-fixture':'/v1/payments/payment-fixture';
    providerHook=async(request,req,res)=>{if(request.path!==target)return false;requests++;if(requests===1){aStarted.resolve();await aGate.promise;if(mode==='retryable'){res.writeHead(500,{'content-type':'application/json'});res.end('{}');return true;}return false;}if(requests===2){bStarted.resolve();await bGate.promise;res.writeHead(500,{'content-type':'application/json'});res.end('{}');return true;}return false;};
    const proofBody=provider==='paypal'?{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}:{razorpayOrderId:'order-fixture',razorpayPaymentId:'payment-fixture',razorpaySignature:crypto.createHmac('sha256','fixture-secret').update('order-fixture|payment-fixture').digest('hex')};
    const event=provider==='paypal'?paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}}):razorReq('payment.captured',{payment:{entity:razorpayPayment}});
    const a=requestFlow(provider,{req:event});await Promise.race([aStarted.promise,a.then(result=>{throw new Error(`A did not reach provider: ${JSON.stringify(result)}`);})]);
    const leasedA=await record();assert.ok(leasedA.finalizationLeaseId);assert.ok(new Date(leasedA.finalizationLeaseExpiresAt).getTime()-originalNow()>88000);Date.now=()=>originalNow()+91000;
    const b=requestFlow('finalize',{paymentAccessToken:tokenFor(r),body:proofBody});await Promise.race([bStarted.promise,b.then(result=>{throw new Error(`B did not reach provider: ${JSON.stringify(result)}`);})]);
    const leasedB=await record();assert.notEqual(leasedB.finalizationLeaseId,leasedA.finalizationLeaseId);const before=await snapshot();let result;
    try{aGate.resolve();result=await a;assert.deepEqual(await snapshot(),before);}finally{bGate.resolve();await b;}
    return{oldHttpStatus:result.status,leaseA:leasedA.finalizationLeaseId,leaseB:leasedB.finalizationLeaseId,currentOwnerUnchangedBeforeBRelease:true,expectedStateWhileBVerifies:before,clockAdvanceMs:91000,storedLeaseDurationSeconds:90,currentFailureCompatibility:(await record()).status};
  });
  for(const provider of ['paypal','razorpay'])await run(`legacy-refunded-booking-${provider}`,async()=>{
    await commerce.create({_id:bookingId,_type:'booking',backendOwner:'supabase',cutoverGeneration:0,status:'refunded',refundStatus:'full',refundedAmount:9.99,netAmount:9.99,packageTitle:'Vertex Essentials',email:'customer@example.invalid',paypalOrderId:provider==='paypal'?'order-fixture':'',razorpayOrderId:provider==='razorpay'?'order-fixture':'',razorpayPaymentId:provider==='razorpay'?'payment-fixture':'',refundAccountingAppliedAt:'2026-01-01T00:00:00.000Z',emailDispatchStatus:'pending'});const before=(await row(bookingId)).payload;
    const req=provider==='paypal'?paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}}):razorReq('payment.captured',{payment:{entity:razorpayPayment}});
    const result=await requestFlow(provider,{req});assert.equal(result.status,200,JSON.stringify(result));const payment=(await commerce.fetch('*[_type == "paymentRecord"]'))[0];assert.ok(payment);assert.equal(payment.status,'refunded');assert.equal(payment.refundState,'full');assert.equal(payment.refundProcessedAmountInSubunits,999);assert.equal(payment.emailDispatchRequired,false);assert.deepEqual((await row(bookingId)).payload,before);
    const [typed]=await sql`select status,refund_state,booking_id from commerce.payment_records where legacy_sanity_id=${payment._id}`;assert.equal(typed.status,'refunded');assert.equal(typed.refund_state,'full');const [bookingTyped]=await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`;assert.equal(bookingTyped.currency,'USD');assert.equal(Number(bookingTyped.amount_subunits),999);const state=await snapshot();assert.equal((await requestFlow(provider,{req})).status,200);assert.deepEqual(await snapshot(),state);return{httpStatus:result.status,paymentStatus:payment.status,refundTotalCents:999,typed,unchangedBooking:true,idempotentDuplicate:true,legacyRefundLedgerIdentitiesUnavailable:true};
  });
  for(const invalidCurrency of ['not-a-currency',0])await run(`legacy-refunded-booking-invalid-currency${invalidCurrency===0?'-zero':''}`,async()=>{
    await commerce.create({_id:bookingId,_type:'booking',backendOwner:'supabase',cutoverGeneration:0,status:'refunded',refundStatus:'full',refundedAmount:9.99,netAmount:9.99,currency:'USD',packageTitle:'Vertex Essentials',email:'customer@example.invalid',paypalOrderId:'order-fixture'});await sql`update migration.source_documents set payload=jsonb_set(payload,'{currency}',${sql.json(invalidCurrency)}) where legacy_sanity_id=${bookingId}`;const before=await snapshot();const req=paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}});const result=await requestFlow('paypal',{req});assert.equal(result.status,404,JSON.stringify(result));assert.deepEqual(await snapshot(),before);return{httpStatus:404,invalidStoredCurrency:invalidCurrency,noReconstructionOrBusinessMutation:true,receiptLifecycle:'existing error receipt only'};
  });
  for(const name of ['legacy-partial-refunded-booking-razorpay-kwd','legacy-partial-refund-currency-disagrees-record'])await run(name, async()=>{
    const currency='KWD',refundCents=2000,refundId='partial-kwd-refund';assert.notEqual(providers.DEFAULT_RAZORPAY_CURRENCY,currency);
    await commerce.create({_id:bookingId,_type:'booking',backendOwner:'supabase',cutoverGeneration:0,status:'captured',paymentProvider:'razorpay',refundStatus:'partial',refundedAmount:2,netAmount:9.99,grossAmount:9.99,packagePrice:'$9.99',currency,packageTitle:'Vertex Essentials',email:'customer@example.invalid',razorpayOrderId:'order-fixture',razorpayPaymentId:'payment-fixture',processedRefundIds:[refundId],paymentRefundVerification:{provider:'razorpay',refundStatus:'partial',providerPaymentId:'payment-fixture',amountRefundedInSubunits:refundCents,refundDetailsMissing:false,refunds:[{id:refundId,currency,amountInSubunits:refundCents}]},emailDispatchClientSentAt:'2026-01-01T00:00:00.000Z',emailDispatchOwnerSentAt:'2026-01-01T00:00:00.000Z'});
    const recordCurrency=name==='legacy-partial-refund-currency-disagrees-record'?'USD':currency;
    await commerce.create({_id:recordId,_type:'paymentRecord',provider:'razorpay',providerOrderId:'order-fixture',providerPaymentId:'payment-fixture',bookingId,status:'started',pricingSnapshot:{grossAmount:9.99,netAmount:9.99,currency:recordCurrency},providerPublicData:{currency:recordCurrency},refunds:[]});
    const recordBefore={source:await row(recordId),typed:(await sql`select to_jsonb(payment) row from commerce.payment_records payment where legacy_sanity_id=${recordId}`)[0].row};
    const body={status:'captured',email:'customer@example.invalid',packageTitle:'Vertex Essentials',packagePrice:'$9.99',paymentProvider:'razorpay',razorpayOrderId:'order-fixture',razorpayPaymentId:'payment-fixture',razorpaySignature:crypto.createHmac('sha256','fixture-secret').update('order-fixture|payment-fixture').digest('hex')};
    const replay=async()=>{const response=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});return {status:response.status,body:await response.json()};};
    const result=await replay();
    if(recordCurrency!==currency){const recordAfter={source:await row(recordId),typed:(await sql`select to_jsonb(payment) row from commerce.payment_records payment where legacy_sanity_id=${recordId}`)[0].row};assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.code,'payment_currency_mismatch');assert.deepEqual(recordAfter,recordBefore);return{requestPath:'/booking',httpStatus:result.status,code:result.body.code,bookingCurrency:currency,refundCurrency:currency,recordCurrency,recordBefore,recordAfter,recordUnchanged:true};}
    assert.equal(result.status,200,JSON.stringify(result));const payment=await record();assert.ok(payment);assert.equal(payment.refundCurrency,currency);assert.equal(payment.refundState,'partial');const {resolvePaymentCurrency}=await import('../src/server/api/ref/bookingRefunds.js');assert.equal(resolvePaymentCurrency(payment),currency);const booking=(await row(bookingId)).payload;assert.equal(booking.refundedAmount,2);assert.deepEqual(booking.processedRefundIds,[refundId]);
    await commerce.patch(bookingId).set({paymentRefundVerification:{...booking.paymentRefundVerification,refunds:[...booking.paymentRefundVerification.refunds,{id:'mismatched-currency-refund',currency:'USD',amountInSubunits:100}]}}).commit();const beforeMismatch=await record(),beforeBooking=(await row(bookingId)).payload,mismatch=await replay();assert.equal(mismatch.status,409,JSON.stringify(mismatch));assert.equal(mismatch.body.error,'Refund currencies do not agree.');assert.deepEqual(await record(),beforeMismatch);assert.deepEqual((await row(bookingId)).payload,beforeBooking);
    await commerce.patch(bookingId).set({paymentRefundVerification:{...booking.paymentRefundVerification,refunds:[]}}).commit();const fallback=await replay();assert.equal(fallback.status,200,JSON.stringify(fallback));const fallbackPayment=await record();assert.equal(fallbackPayment.refundCurrency,currency);assert.equal(resolvePaymentCurrency(fallbackPayment),currency);assert.equal((await row(bookingId)).payload.refundedAmount,2);
    return{httpStatus:200,requestPath:'/booking',fixtureRecordCurrency:recordBefore.source.payload.pricingSnapshot.currency,fixtureProviderPublicCurrency:recordBefore.source.payload.providerPublicData.currency,providerDefaultCurrency:providers.DEFAULT_RAZORPAY_CURRENCY,refundCurrency:payment.refundCurrency,resolvedCurrency:resolvePaymentCurrency(payment),refundCents,legacyPartialProof:booking.paymentRefundVerification,financialFieldsPreserved:true,mismatch:{httpStatus:mismatch.status,error:mismatch.body.error,financialFieldsUnchanged:true},noRefundsFallback:{httpStatus:fallback.status,refundCurrency:fallbackPayment.refundCurrency}};
  });
  for(const [provider,currency,cents] of [['paypal','EUR',999],['razorpay','KWD',9990]])await run(`legacy-refunded-booking-${provider}-${currency.toLowerCase()}`,async()=>{
    await commerce.create({_id:bookingId,_type:'booking',backendOwner:'supabase',cutoverGeneration:0,status:'refunded',refundStatus:'full',refundedAmount:9.99,netAmount:9.99,currency,packageTitle:'Vertex Essentials',email:'customer@example.invalid',paypalOrderId:provider==='paypal'?'order-fixture':'',razorpayOrderId:provider==='razorpay'?'order-fixture':'',razorpayPaymentId:provider==='razorpay'?'payment-fixture':'',refundAccountingAppliedAt:'2026-01-01T00:00:00.000Z',emailDispatchStatus:'pending'});
    const before=(await row(bookingId)).payload;razorpayPayment.currency=currency;razorpayPayment.amount=cents;const req=provider==='paypal'?paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',amount:{value:'9.99',currency_code:currency},supplementary_data:{related_ids:{order_id:'order-fixture'}}}):razorReq('payment.captured',{payment:{entity:razorpayPayment}});
    const result=await requestFlow(provider,{req});assert.equal(result.status,200,JSON.stringify(result));const payment=(await commerce.fetch('*[_type == "paymentRecord"]'))[0];assert.equal(payment.status,'refunded');assert.equal(payment.providerPublicData.currency,currency);assert.equal(payment.refundCurrency,currency);assert.equal(payment.refundProcessedAmountInSubunits,cents);assert.deepEqual((await row(bookingId)).payload,before);const [typed]=await sql`select status,currency,amount_subunits,refund_state from commerce.payment_records where legacy_sanity_id=${payment._id}`;assert.equal(typed.currency,currency);assert.equal(Number(typed.amount_subunits),cents);assert.equal(typed.refund_state,'full');const [bookingTyped]=await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`;assert.equal(bookingTyped.currency,currency);assert.equal(Number(bookingTyped.amount_subunits),cents);const state=await snapshot();assert.equal((await requestFlow(provider,{req})).status,200);assert.deepEqual(await snapshot(),state);return{httpStatus:200,storedCurrency:currency,sourceRefundCents:cents,typed,bookingTyped,unchangedBooking:true,duplicateUnchanged:true,legacyProviderCurrencyStandIn:'historical/imported booking source; no live provider incidence claimed'};
  });
  for(const provider of ['paypal','razorpay'])for(const mode of ['success','incomplete-refund'])await run(`legacy-booking-${provider}-${mode}`,async()=>{
    const refunded=mode==='incomplete-refund';await commerce.create({_id:bookingId,_type:'booking',backendOwner:'supabase',cutoverGeneration:0,status:refunded?'refunded':'captured',refundStatus:refunded?'full':'',...(refunded?{refundedAmount:null}:{}),netAmount:9.99,packageTitle:'Vertex Essentials',email:'customer@example.invalid',paypalOrderId:provider==='paypal'?'order-fixture':'',razorpayOrderId:provider==='razorpay'?'order-fixture':'',razorpayPaymentId:provider==='razorpay'?'payment-fixture':'',emailDispatchClientSentAt:'2026-01-01T00:00:00.000Z',emailDispatchOwnerSentAt:'2026-01-01T00:00:00.000Z'});
    const before=(await row(bookingId)).payload,beforeState=await snapshot(),req=provider==='paypal'?paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}}):razorReq('payment.captured',{payment:{entity:razorpayPayment}});const result=await requestFlow(provider,{req});const payment=(await commerce.fetch('*[_type == "paymentRecord"]'))[0];assert.deepEqual((await row(bookingId)).payload,before);if(refunded){assert.equal(payment,undefined);assert.equal(result.status,404,JSON.stringify(result));assert.deepEqual(await snapshot(),beforeState);return{httpStatus:404,noPaymentReconstruction:true,unchangedLegacyBookingAndBusinessPersistence:true,receiptLifecycle:'existing error receipt only',insufficientRefundAmountRefused:true};}else{assert.ok(payment);assert.equal(result.status,200,JSON.stringify(result));assert.equal(payment.status,'booked');assert.equal(payment.emailDispatch.allSent,true);}
    const [typed]=await sql`select payment.status,booking.status as booking_status,booking.booking_payload from commerce.payment_records payment cross join commerce.bookings booking where payment.legacy_sanity_id=${payment._id} and booking.legacy_sanity_id=${bookingId}`;assert.equal(typed.status,payment.status);assert.deepEqual(typed.booking_payload,before);return{httpStatus:result.status,paymentStatus:payment.status,bookingStatus:typed.booking_status,unchangedLegacyBooking:true,insufficientRefundAmountRefused:refunded,successfulLegacyReconstructionPreserved:!refunded};
  });
  await run('dodo-initial-bind-wrong-payment-id',async()=>{
    await seed('dodo','started',{record:{providerOrderId:'',providerPaymentId:'',bookingId:''}});const req=dodoReq();dodoPayment.payment_id='other-payment';const before=await snapshot({receipts:true});const result=await requestFlow('dodo',{req});assert.equal(result.status,409);assert.deepEqual(await snapshot({receipts:true}),before);return{httpStatus:409,noMutation:true,requested:'payment-fixture',returned:'other-payment'};
  });
  await run('dodo-initial-bind-same-payment-id',async()=>{
    await seed('dodo','booked',{record:{providerOrderId:'',providerPaymentId:''}});const result=await requestFlow('dodo',{req:dodoReq()});assert.equal(result.status,200,JSON.stringify(result));assert.equal((await record()).providerOrderId,'order-fixture');const [typed]=await sql`select provider_order_id from commerce.payment_records where legacy_sanity_id=${recordId}`;assert.equal(typed.provider_order_id,'order-fixture');return{httpStatus:200,typed};
  });
  const readReport = async (input) => {
    const before = await snapshot({ receipts: true });
    const requestsAt = providerRequests.length;
    const databaseRequestsAt = fixture.requestLog.length;
    const response = await fetch(`${origin}/reconcile-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    const after = await snapshot({ receipts: true });
    assert.deepEqual(after, before, 'Report changed business persistence');
    assert.ok(providerRequests.slice(requestsAt).every((request) => request.method === 'GET'));
    const checks = body?.checks || [];
    for (const check of checks) {
      assert.deepEqual(Object.keys(check).sort(), ['items', 'key', 'keys', 'state']);
      assert.ok(['recovered', 'unresolved', 'unknown'].includes(check.state));
      assert.equal(new Set(check.keys).size, check.keys.length);
      for (const key of [check.key, ...check.keys]) assert.match(key, /^(payment|booking|record|scan):[A-Za-z0-9_.:/-]{1,80}$/);
    }
    for (const item of [...(body?.items || []), ...checks.flatMap((check) => check.items)]) {
      assert.deepEqual(Object.keys(item).sort(), ['amount', 'currency', 'id', 'key', 'reason', 'ref']);
      assert.match(item.key, /^(payment|booking|record|scan):[A-Za-z0-9_.:/-]{1,80}$/);
    }
    for (const privateValue of [
      'customer@example.invalid', 'fixture_handle', 'Synthetic address', 'customer-fixture',
    ]) {
      assert.equal(text.includes(privateValue), false, privateValue);
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
      before,
      after,
      providerRequests: providerRequests.slice(requestsAt),
      databaseRequests: fixture.requestLog.slice(databaseRequestsAt),
    };
  };
  const reconcileReport = async (now = Date.now() + 60 * 60 * 1000) => {
    const result = await readReport({ now });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const reportRoute = async (headers = {}, method = 'GET', nextRoute = false, query = {}) => {
    return readReport({ route: true, headers, method, nextRoute, query });
  };
  const authorizedReport = async (method = 'GET', nextRoute = false, query = {}) => {
    const saved = process.env.RECONCILE_REPORT_TOKEN;
    try {
      process.env.RECONCILE_REPORT_TOKEN = 'report-fixture-token-that-is-at-least-32-characters';
      return await reportRoute(
        { authorization: `Bearer ${process.env.RECONCILE_REPORT_TOKEN}` },
        method,
        nextRoute,
        query,
      );
    } finally {
      if (saved === undefined) delete process.env.RECONCILE_REPORT_TOKEN;
      else process.env.RECONCILE_REPORT_TOKEN = saved;
    }
  };
  const dodoSummary = (payment = dodoPayment) => ({
    payment_id: payment.payment_id,
    status: payment.status,
    total_amount: payment.total_amount,
    currency: payment.currency,
    metadata: payment.metadata,
    created_at: payment.created_at,
    customer: payment.customer,
  });
  const dodoBooking = (changes = {}, recordChanges = {}) => ({
    booking: {
      _createdAt: new Date(Date.now() - 3600000).toISOString(),
      paymentProvider: 'dodo',
      dodoPaymentId: 'payment-fixture',
      dodoCheckoutSessionId: 'order-fixture',
      paymentRecordId: recordId,
      grossAmount: 9.99,
      dodoTotalAmount: 9.99,
      commissionPercent: 10,
      commissionAmount: 1,
      referralCode: 'creator-correct',
      referral: { _type: 'reference', _ref: 'referral.correct' },
      ...changes,
    },
    record: {
      ...recordChanges,
      pricingSnapshot: {
        currency: 'USD',
        grossAmount: 9.99,
        netAmount: 9.99,
        discountAmount: 0,
        discountPercent: 0,
        referralDiscountAmount: 0,
        referralDiscountPercent: 0,
        commissionPercent: 10,
        commissionAmount: 1,
        couponDiscountPercent: 0,
        couponDiscountAmount: 0,
        couponDiscountType: '',
        couponDiscountValue: 0,
        canCombineWithReferral: false,
        effectiveReferralCode: 'creator-correct',
        effectiveReferralId: 'referral.correct',
        ...recordChanges.pricingSnapshot,
      },
    },
  });
  const reportReasons = (report) => report.items.map((item) => item.reason);
  const expectReport = async (reasons) => {
    const result = await authorizedReport();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(reportReasons(result.body), reasons, JSON.stringify(result.body));
    assert.equal(result.body.count, reasons.length, JSON.stringify(result.body));
    return result;
  };
  const targetReport = (keys) => authorizedReport('GET', true, { check: JSON.stringify(keys) });
  const canonicalKeys = ['payment:payment-fixture', 'record:' + recordId, 'booking:' + bookingId];
  const assertTarget = (result, keys, states, reasons) => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.mode, 'checks');
    assert.deepEqual(result.body.complete, { payments: false, bookings: false, records: false, items: true });
    assert.deepEqual(result.body.checks.map((check) => check.key), keys);
    assert.deepEqual(result.body.checks.map((check) => check.state), states);
    assert.deepEqual(reportReasons(result.body), reasons);
    assert.equal(result.body.count, reasons.length);
    assert.equal(result.providerRequests.some((request) => request.path.startsWith('/payments?')), false);
    for (const check of result.body.checks) {
      assert.ok(check.keys.includes(check.key));
      if (check.state !== 'unresolved') assert.deepEqual(check.items, []);
      else assert.ok(check.items.every((item) => check.keys.includes(item.key)));
      if (check.state === 'recovered') {
        assert.deepEqual(check.keys, [...new Set([check.key, ...canonicalKeys])]);
      }
    }
  };
  await run('reconcile-report-target-aged-out', async () => {
    const old = new Date(Date.now() - 73 * 3600000).toISOString();
    await seed('dodo', 'booked', dodoBooking({ _createdAt: old, netAmount: 19.99 }));
    dodoPayment.created_at = old;
    dodoList = [];
    const window = await authorizedReport('GET', true);
    assert.equal(window.status, 200);
    assert.equal(window.body.count, 0, JSON.stringify(window.body));
    const report = await targetReport(canonicalKeys);
    await commerce.patch(bookingId).set({ netAmount: 9.99 }).commit();
    const control = await targetReport(canonicalKeys);
    const proof = { old, provider: dodoPayment, window, report, control };
    assert.equal(report.body.checks?.[0]?.state, 'unresolved', JSON.stringify(proof));
    assertTarget(report, canonicalKeys, ['unresolved', 'unresolved', 'unresolved'], ['amount_mismatch']);
    assertTarget(control, canonicalKeys, ['recovered', 'recovered', 'recovered'], []);
    assert.equal(window.body.mode, 'window');
    assert.deepEqual(window.body.checks, []);
    assert.deepEqual(window.body.complete, { payments: true, bookings: true, records: true, items: true });
    for (const result of [report, control]) {
      assert.equal(result.providerRequests.length, 1);
      assert.equal(result.providerRequests[0].path, '/payments/payment-fixture');
      assert.equal(result.databaseRequests.length, 2);
    }
    return proof;
  });
  await run('reconcile-report-frozen-commission', async () => {
    await seed('dodo', 'booked', dodoBooking({ commissionAmount: 0.5 }));
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoList = [dodoSummary()];
    return expectReport(['commission_mismatch']);
  });
  await run('reconcile-report-extra-booking', async () => {
    await seed('dodo', 'booked', dodoBooking());
    await commerce.patch(bookingId).set({ paymentRecordId: recordId }).commit();
    const { _id, _rev, ...canonical } = (await row(bookingId)).payload;
    await commerce.create({ ...canonical, _id: 'booking.extra', netAmount: 19.99 });
    const native = await sql`select legacy_sanity_id,payment_record_id,booking_payload from commerce.bookings order by legacy_sanity_id`;
    assert.equal(native.length, 2);
    assert.ok(native.every((booking) => booking.payment_record_id === native[0].payment_record_id));
    assert.ok(native[0].payment_record_id);
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoList = [dodoSummary()];
    const result = await expectReport(['payment_record_mismatch']);
    assert.equal(result.body.items[0].ref, 'booking.extra');
    assert.equal(providerRequests.filter((request) => request.path === '/payments/payment-fixture').length, 1);
    return { native, ...result };
  });
  await run('reconcile-report-reverse-old-payment', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.created_at = new Date(Date.now() - 73 * 3600000).toISOString();
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [];
    const result = await expectReport(['refund_not_applied']);
    assert.equal(result.body.items[0].ref, bookingId);
    assert.ok(providerRequests.some((request) => request.path === '/payments/payment-fixture'));
    return { provider: dodoPayment, ...result };
  });
  await run('reconcile-report-referral-binding', async () => {
    await seed('dodo', 'booked', dodoBooking({
      referralCode: 'creator-wrong',
      referral: { _type: 'reference', _ref: 'referral.wrong' },
    }));
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoList = [dodoSummary()];
    return expectReport(['referral_binding_mismatch']);
  });
  for (const [name, booking, reason] of [
    ['missing', { commissionAmount: undefined }, 'commission_mismatch'],
    ['null', { commissionAmount: null }, 'commission_mismatch'],
    ['empty', { commissionAmount: '' }, 'commission_mismatch'],
    ['zero', { commissionAmount: 0 }, 'commission_mismatch'],
    ['negative', { commissionAmount: -1 }, 'commission_mismatch'],
    ['inflated-rate', { commissionPercent: 50, commissionAmount: 5 }, 'commission_exceeds_kept_share'],
    ['changed-rate', { commissionPercent: 50 }, 'commission_mismatch'],
    ['missing-rate', { commissionPercent: undefined }, 'commission_mismatch'],
    ['original-mismatch', { dodoOriginalCommissionAmount: 0.5 }, 'commission_mismatch'],
    ['original-null', { dodoOriginalCommissionAmount: null }, 'commission_mismatch'],
  ]) {
    await run(`reconcile-report-frozen-commission-${name}`, async () => {
      await seed('dodo', 'booked', dodoBooking(booking));
      dodoList = [dodoSummary()];
      return expectReport([reason]);
    });
  }
  await run('reconcile-report-frozen-commission-referral-base', async () => {
    await seed('dodo', 'booked', dodoBooking(
      { commissionAmount: 2 },
      { pricingSnapshot: { commissionAmount: 2 } },
    ));
    dodoList = [dodoSummary()];
    return expectReport([]);
  });
  await run('reconcile-report-booking-gross-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking({ grossAmount: 19.99 }));
    dodoList = [dodoSummary()];
    return expectReport(['amount_mismatch']);
  });
  const frozenCases = [
    ...['grossAmount', 'netAmount', 'commissionAmount', 'commissionPercent', 'effectiveReferralCode', 'effectiveReferralId']
      .map((field) => [`missing-${field}`, { [field]: undefined }]),
    ['null-gross', { grossAmount: null }],
    ['empty-net', { netAmount: '' }],
    ['numeric-string', { commissionAmount: '1' }],
    ['negative-amount', { commissionAmount: -1 }],
    ['invalid-percent', { commissionPercent: 101 }],
    ['net-above-gross', { grossAmount: 1 }],
    ['zero-rate-with-commission', { commissionPercent: 0 }],
    ['invalid-code', { effectiveReferralCode: 123 }],
    ['unpaired-recipient', { effectiveReferralId: '' }],
    ['unpaired-code', { effectiveReferralCode: '' }],
    ['no-recipient-with-commission', { effectiveReferralCode: '', effectiveReferralId: '' }],
  ];
  for (const [name, pricingSnapshot] of frozenCases) {
    await run(`reconcile-report-frozen-pricing-${name}`, async () => {
      await seed('dodo', 'booked', dodoBooking({}, { pricingSnapshot }));
      dodoList = [dodoSummary()];
      return expectReport(['frozen_pricing_unavailable']);
    });
  }
  await run('reconcile-report-frozen-pricing-missing', async () => {
    await seed('dodo', 'booked', dodoBooking());
    await commerce.patch(recordId).unset(['pricingSnapshot']).commit();
    dodoList = [dodoSummary()];
    return expectReport(['frozen_pricing_unavailable']);
  });
  for (const wrongRecipient of [false, true]) {
    await run(`reconcile-report-no-referral-${wrongRecipient ? 'wrong-recipient' : 'zero'}`, async () => {
      await seed('dodo', 'booked', dodoBooking({
        commissionAmount: 0,
        commissionPercent: 0,
        referralCode: wrongRecipient ? 'creator-wrong' : '',
        referral: wrongRecipient ? { _type: 'reference', _ref: 'referral.wrong' } : null,
      }, {
        pricingSnapshot: {
          commissionAmount: 0,
          commissionPercent: 0,
          effectiveReferralCode: '',
          effectiveReferralId: '',
        },
      }));
      dodoList = [dodoSummary()];
      return expectReport(wrongRecipient ? ['referral_binding_mismatch'] : []);
    });
  }
  await run('reconcile-report-referral-code-normalization', async () => {
    await seed('dodo', 'booked', dodoBooking({
      referralCode: ' CREATOR-CORRECT ',
      referral: { _type: 'reference', _ref: ' referral.correct ' },
    }));
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoList = [dodoSummary()];
    const booking = (await row(bookingId)).payload;
    const report = await authorizedReport();
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    await commerce.patch(bookingId).set({
      referralCode: 'CREATOR-CORRECT',
      referral: { _type: 'reference', _ref: 'referral.correct' },
    }).commit();
    const control = await authorizedReport();
    const controlEarnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    const proof = { booking, report, earnings, control, controlEarnings };
    assert.equal(report.status, 200);
    assert.equal(earnings.total, 0, JSON.stringify(earnings));
    assert.equal(control.status, 200);
    assert.equal(control.body.count, 0, JSON.stringify(control.body));
    assert.deepEqual(control.body.items, []);
    assert.equal(controlEarnings.total, 1, JSON.stringify(controlEarnings));
    assert.deepEqual(reportReasons(report.body), ['referral_binding_mismatch'], JSON.stringify(proof));
    return proof;
  });
  for (const [name, changes] of [
    ['code', { referralCode: ' CREATOR-CORRECT ' }],
    ['id', { referral: { _type: 'reference', _ref: ' referral.correct ' } }],
  ]) {
    await run(`reconcile-report-referral-${name}-padding`, async () => {
      await seed('dodo', 'booked', dodoBooking(changes));
      dodoList = [dodoSummary()];
      const report = await expectReport(['referral_binding_mismatch']);
      const earnings = await commerce.referralEarnings({
        referralId: 'referral.correct', referralCode: 'creator-correct',
      });
      assert.equal(earnings.total, 1, JSON.stringify(earnings));
      return { report, earnings };
    });
  }
  await run('reconcile-report-referral-id-case-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking({
      referral: { _type: 'reference', _ref: 'Referral.Correct' },
    }));
    dodoList = [dodoSummary()];
    return expectReport(['referral_binding_mismatch']);
  });
  for (const [commissionAmount, reasons] of [
    [0.67, []],
    [0.66, ['commission_mismatch']],
    [0.68, ['commission_exceeds_kept_share']],
  ]) {
    await run(`reconcile-report-rounded-partial-commission-${commissionAmount}`, async () => {
      await seed('dodo', 'booked', dodoBooking({
        refundedAmount: 3.33,
        refundStatus: 'partial',
        commissionAmount,
        dodoOriginalCommissionAmount: 1,
      }));
      dodoPayment.refund_status = 'partial';
      dodoPayment.refunds = [{ ...dodoRefund, amount: 333, is_partial: true }];
      dodoList = [dodoSummary()];
      return expectReport(reasons);
    });
  }
  for (const booked of [true, false]) {
    await run(`reconcile-report-processed-full-refund-${booked ? 'booked' : 'unbooked'}`, async () => {
      const data = dodoBooking({}, booked ? {} : { bookingId: '' });
      await seed('dodo', booked ? 'booked' : 'started', { ...data, booking: booked ? data.booking : null });
      dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
      dodoPayment.refund_status = 'full';
      dodoPayment.refunds = [dodoRefund];
      dodoList = [dodoSummary()];
      const refund = await requestFlow('dodo', { req: dodoReq(dodoRefund, 'refund.succeeded') });
      assert.equal(refund.status, 200, JSON.stringify(refund));
      const saved = await record();
      assert.equal(saved.status, 'refunded');
      assert.equal(saved.refundRequiresBookingSync, false);
      assert.equal(saved.refundProcessedAmountInSubunits, 999);
      if (booked) assert.equal((await row(bookingId)).payload.commissionAmount, 1);
      else {
        assert.equal(saved.bookingId, '');
        assert.equal(saved.refundBookingSync.releasedUnbookedPaymentResources, true);
      }
      const earnings = await commerce.referralEarnings({ referralId: 'referral.correct', referralCode: 'creator-correct' });
      assert.equal(earnings.total, 0);
      const window = await authorizedReport('GET', true);
      const keys = booked ? canonicalKeys : canonicalKeys.slice(0, 2);
      const targeted = await targetReport(keys);
      assert.equal(window.status, 200, JSON.stringify(window.body));
      assert.equal(window.body.count, 0, JSON.stringify(window.body));
      assert.deepEqual(targeted.body.checks.map(check => check.state), keys.map(() => 'recovered'), JSON.stringify(targeted.body));
      assert.equal(targeted.body.count, 0);
      if (!booked) {
        for (const check of targeted.body.checks) assert.deepEqual(new Set(check.keys), new Set(keys));
        const missing = await targetReport([canonicalKeys[2]]);
        assert.equal(missing.body.checks[0].state, 'unknown');
      }
      return { refund, saved, earnings, window, targeted };
    });
  }
  for (const variant of [
    { name: 'sync-pending', record: { refundRequiresBookingSync: true } },
    { name: 'sync-unknown', record: { refundRequiresBookingSync: null } },
    { name: 'release-pending', record: { resourceReleasePending: true } },
    { name: 'missing-release-proof', record: { refundBookingSync: {} } },
    { name: 'contradictory-release-proof', record: { refundBookingSync: { bookingId, releasedUnbookedPaymentResources: true } } },
    { name: 'recovery-pending', record: { recoveryReason: 'refund_requires_booking_sync' } },
    { name: 'recovery-exhausted', record: { reconciliationRecoveryTerminal: true } },
    { name: 'unfinished-status', record: { status: 'needs_recovery' } },
    { name: 'partial-local-state', record: { refundState: 'partial' } },
    { name: 'wrong-local-total', record: { refundProcessedAmountInSubunits: 998 } },
    { name: 'wrong-local-currency', importedCurrency: 'EUR' },
    { name: 'dangling-booking', record: { bookingId: 'booking-missing' } },
    { name: 'owner-review', record: { status: 'needs_recovery', providerRecoveryTerminal: true, providerRecoveryTerminalReason: 'dodo_refund_mismatch' } },
    { name: 'partial-provider', payment: { refund_status: 'partial' }, refund: { amount: 500, is_partial: true } },
    { name: 'missing-provider-refunds', payment: { refunds: [] }, unavailable: true },
    { name: 'wrong-provider-currency', refund: { currency: 'EUR' }, unavailable: true },
    { name: 'unknown-dispute', payment: { disputes: [{ dispute_id: 'dispute-fixture', payment_id: 'payment-fixture', currency: 'USD', dispute_status: 'unknown', dispute_stage: 'dispute' }] }, unavailable: true },
  ]) {
    await run(`reconcile-report-unbooked-refund-${variant.name}`, async () => {
      await seed('dodo', 'started', { ...dodoBooking({}, { bookingId: '' }), booking: null });
      dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
      dodoPayment.refund_status = 'full';
      dodoPayment.refunds = [dodoRefund];
      const refund = await requestFlow('dodo', { req: dodoReq(dodoRefund, 'refund.succeeded') });
      assert.equal(refund.status, 200, JSON.stringify(refund));
      if (variant.record) await commerce.patch(recordId).set(variant.record).commit();
      if (variant.importedCurrency) await sql`update migration.source_documents set payload=jsonb_set(payload,'{refundCurrency}',${sql.json(variant.importedCurrency)}) where legacy_sanity_id=${recordId}`;
      if (variant.refund) Object.assign(dodoRefund, variant.refund);
      Object.assign(dodoPayment, variant.payment);
      dodoList = [dodoSummary()];
      const window = await authorizedReport('GET', true);
      const targeted = await targetReport(canonicalKeys.slice(0, 2));
      for (const result of [window, targeted]) {
        if (variant.unavailable) assert.equal(result.status, 503, JSON.stringify(result.body));
        else {
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.ok(result.body.count > 0, JSON.stringify(result.body));
          assert.ok((result.body.checks || []).every(check => check.state === 'unresolved'));
        }
      }
      return { refund, window, targeted };
    });
  }
  await run('reconcile-report-full-refund-zero-commission', async () => {
    await seed('dodo', 'refunded', dodoBooking({
      status: 'refunded',
      refundedAmount: 9.99,
      refundStatus: 'full',
      commissionAmount: 0,
      dodoOriginalCommissionAmount: 1,
    }));
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [dodoSummary()];
    return expectReport([]);
  });
  await run('reconcile-report-partial-zero-original-earnings', async () => {
    await seed('dodo', 'booked', dodoBooking({
      refundedAmount: 9.98,
      refundStatus: 'partial',
      commissionAmount: 0,
    }));
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: 998, is_partial: true }];
    dodoList = [dodoSummary()];
    const booking = (await row(bookingId)).payload;
    assert.equal(Object.hasOwn(booking, 'dodoOriginalCommissionAmount'), false);
    const report = await authorizedReport();
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    await commerce.patch(bookingId).set({ dodoOriginalCommissionAmount: 1 }).commit();
    const control = await authorizedReport();
    const controlEarnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    const proof = { booking, provider: dodoPayment, report, earnings, control, controlEarnings };
    assert.equal(report.status, 200);
    assert.equal(earnings.total, 1, JSON.stringify(earnings));
    assert.equal(control.status, 200);
    assert.equal(control.body.count, 0, JSON.stringify(control.body));
    assert.deepEqual(control.body.items, []);
    assert.equal(controlEarnings.total, 0, JSON.stringify(controlEarnings));
    assert.deepEqual(reportReasons(report.body), ['commission_mismatch'], JSON.stringify(proof));
    return proof;
  });
  await run('reconcile-report-partial-nonzero-original-earnings', async () => {
    await seed('dodo', 'booked', dodoBooking({
      refundedAmount: 3.33,
      refundStatus: 'partial',
      commissionAmount: 0.67,
    }));
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: 333, is_partial: true }];
    dodoList = [dodoSummary()];
    const booking = (await row(bookingId)).payload;
    assert.equal(Object.hasOwn(booking, 'dodoOriginalCommissionAmount'), false);
    const report = await expectReport(['commission_mismatch']);
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    await commerce.patch(bookingId).set({ dodoOriginalCommissionAmount: 1 }).commit();
    const control = await expectReport([]);
    const controlEarnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(earnings.total, 0.67, JSON.stringify(earnings));
    assert.equal(controlEarnings.total, 0.67, JSON.stringify(controlEarnings));
    return { booking, provider: dodoPayment, report, earnings, control, controlEarnings };
  });
  await run('reconcile-report-full-refund-no-original-earnings', async () => {
    await seed('dodo', 'refunded', dodoBooking({
      status: 'refunded',
      refundedAmount: 9.99,
      refundStatus: 'full',
      commissionAmount: 0,
    }));
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [dodoSummary()];
    const booking = (await row(bookingId)).payload;
    assert.equal(Object.hasOwn(booking, 'dodoOriginalCommissionAmount'), false);
    const report = await expectReport([]);
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(earnings.total, 0, JSON.stringify(earnings));
    return { booking, provider: dodoPayment, report, earnings };
  });
  const dodoDispute = (status) => ({
    dispute_id: 'dispute-fixture',
    payment_id: 'payment-fixture',
    dispute_status: status,
    dispute_stage: 'dispute',
    amount: '999',
    currency: 'USD',
  });
  const zeroCommissionFixture = async (bookingChanges = {}, percent = 0.04) => {
    const { resolveBookingPricing } = await import('../src/server/api/ref/pricing.js');
    const quote = await resolveBookingPricing({
      packageTitle: 'Vertex Essentials',
      paymentProvider: 'dodo',
      client: commerce,
      pricingInputs: {
        packageDoc: { _id: 'package.zero-commission', title: 'Vertex Essentials', price: '$9.99' },
        referralDoc: {
          _id: 'referral.correct',
          slug: { current: 'creator-correct' },
          currentCommissionPercent: percent,
          currentDiscountPercent: 0,
        },
        couponDoc: null,
      },
    });
    assert.equal(quote.effectiveGrossAmount, 9.99);
    assert.equal(quote.effectiveNetAmount, 9.99);
    assert.equal(quote.effectiveCommissionPercent, percent);
    assert.equal(quote.commissionAmount, 0);
    assert.equal(quote.effectiveReferralId, 'referral.correct');
    assert.equal(quote.effectiveReferralCode, 'creator-correct');
    await seed('dodo', bookingChanges.status === 'refunded' ? 'refunded' : 'booked', dodoBooking({
      grossAmount: quote.effectiveGrossAmount,
      netAmount: quote.effectiveNetAmount,
      commissionAmount: quote.commissionAmount,
      commissionPercent: quote.effectiveCommissionPercent,
      referralCode: quote.effectiveReferralCode,
      referral: { _type: 'reference', _ref: quote.effectiveReferralId },
      ...bookingChanges,
    }, { pricingSnapshot: {
      grossAmount: quote.effectiveGrossAmount,
      netAmount: quote.effectiveNetAmount,
      commissionAmount: quote.commissionAmount,
      commissionPercent: quote.effectiveCommissionPercent,
      effectiveReferralCode: quote.effectiveReferralCode,
      effectiveReferralId: quote.effectiveReferralId,
    } }));
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoList = [dodoSummary()];
    return quote;
  };
  await run('reconcile-report-unrefunded-zero-commission-consumer', async () => {
    const quote = await zeroCommissionFixture();
    const secondRecordId = 'paymentRecord.zero-two';
    const secondBookingId = 'booking.zero-two';
    const secondPaymentId = 'payment-zero-two';
    const secondOrderId = 'order-zero-two';
    const { _id: firstBookingId, _rev: bookingRevision, ...bookingCopy } = (await row(bookingId)).payload;
    await commerce.create({
      ...bookingCopy,
      _id: secondBookingId,
      paymentRecordId: secondRecordId,
      dodoPaymentId: secondPaymentId,
      dodoCheckoutSessionId: secondOrderId,
    });
    const { _id: firstRecordId, _rev: recordRevision, ...recordCopy } = await record();
    await commerce.create({
      ...recordCopy,
      _id: secondRecordId,
      bookingId: secondBookingId,
      providerPaymentId: secondPaymentId,
      providerOrderId: secondOrderId,
      providerIdempotencyKey: 'zero-two-key',
      sessionScope: 'zero-two-session',
    });
    await commerce.patch(bookingId).set({ paymentRecordId: recordId }).commit();
    await commerce.patch(secondBookingId).set({ paymentRecordId: secondRecordId }).commit();
    const secondPayment = {
      ...dodoPayment,
      payment_id: secondPaymentId,
      checkout_session_id: secondOrderId,
      metadata: { paymentRecordId: secondRecordId },
    };
    providerHook = (request, req, res) => {
      if (request.path !== `/payments/${secondPaymentId}`) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(secondPayment));
      return true;
    };
    dodoList = [dodoSummary(), dodoSummary(secondPayment)];
    const nativeBookings = await sql`select legacy_sanity_id,payment_record_id,booking_payload from commerce.bookings order by legacy_sanity_id`;
    const nativeRecords = await sql`select id,legacy_sanity_id from commerce.payment_records order by legacy_sanity_id`;
    const recordIdentities = new Map(nativeRecords.map((payment) => [payment.id, payment.legacy_sanity_id]));
    assert.equal(nativeBookings.length, 2);
    assert.equal(nativeRecords.length, 2);
    assert.equal(new Set(nativeBookings.map((booking) => booking.payment_record_id)).size, 2);
    for (const booking of nativeBookings) {
      assert.ok(booking.payment_record_id);
      assert.equal(recordIdentities.get(booking.payment_record_id), booking.booking_payload.paymentRecordId);
      assert.equal(booking.booking_payload.commissionAmount, 0);
      assert.equal(Object.hasOwn(booking.booking_payload, 'dodoOriginalCommissionAmount'), false);
    }
    const frozenRecords = [await record(), (await row(secondRecordId)).payload];
    const frozenCommissionsSum = frozenRecords.reduce((sum, payment) => sum + payment.pricingSnapshot.commissionAmount, 0);
    assert.equal(frozenCommissionsSum, 0);
    const report = await authorizedReport('GET', true);
    const targets = [...canonicalKeys, 'payment:' + secondPaymentId, 'record:' + secondRecordId, 'booking:' + secondBookingId];
    const targeted = await targetReport(targets);
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(earnings.total, 0.01, JSON.stringify(earnings));
    for (const id of [bookingId, secondBookingId]) {
      await commerce.patch(id).set({ dodoOriginalCommissionAmount: 0 }).commit();
    }
    const control = await authorizedReport('GET', true);
    const targetedControl = await targetReport(targets);
    const controlEarnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(control.status, 200);
    assert.equal(control.body.count, 0, JSON.stringify(control.body));
    assert.deepEqual(control.body.items, []);
    assert.equal(controlEarnings.total, 0, JSON.stringify(controlEarnings));
    const proof = {
      quote, frozenRecords, frozenCommissionsSum, nativeBookings, nativeRecords,
      providerPayments: [dodoPayment, secondPayment], report, earnings, control, controlEarnings,
      targeted, targetedControl,
      engine: JSON.parse(sourceText('node_modules/next/package.json')).version,
      pricingSha256: crypto.createHash('sha256').update(sourceText('src/server/api/ref/pricing.js')).digest('hex'),
    };
    assert.deepEqual(report.body.items, [
      { key: 'payment:payment-fixture', id: 'payment-fixture', ref: bookingId, amount: '9.99', currency: 'USD', reason: 'commission_mismatch' },
      { key: 'payment:' + secondPaymentId, id: secondPaymentId, ref: secondBookingId, amount: '9.99', currency: 'USD', reason: 'commission_mismatch' },
    ], JSON.stringify(proof));
    assert.equal(report.body.count, 2);
    assert.equal(targeted.status, 200);
    assert.equal(targeted.body.count, 2);
    assert.deepEqual(targeted.body.checks.map((check) => check.state), Array(6).fill('unresolved'));
    assert.ok(targeted.body.checks.every((check) => check.items[0].reason === 'commission_mismatch'));
    assert.equal(targetedControl.status, 200);
    assert.equal(targetedControl.body.count, 0);
    assert.deepEqual(targetedControl.body.checks.map((check) => check.state), Array(6).fill('recovered'));
    for (const result of [targeted, targetedControl]) {
      assert.equal(result.providerRequests.length, 2);
      assert.ok(result.providerRequests.every((request) => !request.path.startsWith('/payments?')));
    }
    return proof;
  });
  for (const [name, status, dispute] of [
    ['single', 'captured', null],
    ['completed', 'completed', null],
    ['resolved-dispute', 'captured', 'dispute_won'],
  ]) {
    await run(`reconcile-report-${name}-zero-commission-consumer`, async () => {
      const quote = await zeroCommissionFixture({ status });
      if (dispute) dodoPayment.disputes = [dodoDispute(dispute)];
      const report = await expectReport(['commission_mismatch']);
      const earnings = await commerce.referralEarnings({
        referralId: 'referral.correct', referralCode: 'creator-correct',
      });
      assert.equal(earnings.total, 0, JSON.stringify(earnings));
      await commerce.patch(bookingId).set({ dodoOriginalCommissionAmount: 0 }).commit();
      const control = await expectReport([]);
      const controlEarnings = await commerce.referralEarnings({
        referralId: 'referral.correct', referralCode: 'creator-correct',
      });
      assert.equal(controlEarnings.total, 0, JSON.stringify(controlEarnings));
      return {
        quote, report, earnings, control, controlEarnings,
        nativeRoundingLimit: 'A single positive unrounded fallback rounds to zero; multiple rows can accumulate.',
      };
    });
  }
  await run('reconcile-report-zero-rate-creator-consumer', async () => {
    const quote = await zeroCommissionFixture({}, 0);
    const report = await expectReport([]);
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(earnings.total, 0, JSON.stringify(earnings));
    return { quote, report, earnings };
  });
  for (const state of ['active-dispute', 'full-refund']) {
    await run(`reconcile-report-${state}-zero-commission-consumer`, async () => {
      const refunded = state === 'full-refund';
      const quote = await zeroCommissionFixture(refunded ? {
        status: 'refunded', refundedAmount: 9.99, refundStatus: 'full',
      } : { status: 'pending', dodoDisputeActive: true });
      if (refunded) {
        dodoPayment.refund_status = 'full';
        dodoPayment.refunds = [dodoRefund];
      } else dodoPayment.disputes = [dodoDispute('dispute_opened')];
      const booking = (await row(bookingId)).payload;
      assert.equal(Object.hasOwn(booking, 'dodoOriginalCommissionAmount'), false);
      const report = await expectReport([]);
      const earnings = await commerce.referralEarnings({
        referralId: 'referral.correct', referralCode: 'creator-correct',
      });
      assert.equal(earnings.total, 0, JSON.stringify(earnings));
      return { quote, booking, report, earnings };
    });
  }
  await run('reconcile-report-partial-disputed-original-earnings', async () => {
    await seed('dodo', 'booked', dodoBooking({
      status: 'pending',
      dodoDisputeActive: true,
      refundedAmount: 9.98,
      refundStatus: 'partial',
      commissionAmount: 0,
    }));
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: 998, is_partial: true }];
    dodoPayment.disputes = [dodoDispute('dispute_opened')];
    dodoList = [dodoSummary()];
    const booking = (await row(bookingId)).payload;
    assert.equal(Object.hasOwn(booking, 'dodoOriginalCommissionAmount'), false);
    const report = await expectReport(['commission_mismatch']);
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    await commerce.patch(bookingId).set({ dodoOriginalCommissionAmount: 1 }).commit();
    const control = await expectReport([]);
    const controlEarnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(earnings.total, 0, JSON.stringify(earnings));
    assert.equal(controlEarnings.total, 0, JSON.stringify(controlEarnings));
    return { booking, provider: dodoPayment, report, earnings, control, controlEarnings };
  });
  for (const status of ['dispute_opened', 'dispute_won', 'dispute_cancelled']) {
    await run(`reconcile-report-commission-${status}`, async () => {
      const active = status === 'dispute_opened';
      await seed('dodo', 'booked', dodoBooking({
        status: active ? 'pending' : 'captured',
        dodoDisputeActive: active,
        commissionAmount: active ? 0 : 1,
        dodoOriginalCommissionAmount: 1,
      }));
      dodoPayment.disputes = [dodoDispute(status)];
      dodoList = [dodoSummary()];
      return expectReport([]);
    });
  }
  const reverseCases = [
    { name: 'clean' },
    {
      name: 'partial-refund-applied', refund: 333,
      booking: { refundedAmount: 3.33, refundStatus: 'partial', commissionAmount: 0.67, dodoOriginalCommissionAmount: 1 },
    },
    { name: 'partial-refund-unapplied', refund: 333, reason: 'refund_not_applied' },
    { name: 'dispute-unapplied', dispute: 'dispute_opened', reason: 'dispute_not_applied' },
    {
      name: 'owner-review', reason: 'owner_review_dodo_currency_mismatch',
      record: { providerRecoveryTerminal: true, providerRecoveryTerminalReason: 'dodo_currency_mismatch' },
    },
    { name: 'booking-binding', booking: { dodoCheckoutSessionId: 'checkout-other' }, reason: 'payment_record_mismatch' },
    { name: 'record-binding', record: { providerOrderId: 'checkout-other' }, reason: 'dodo_payment_binding_mismatch' },
    { name: 'record-missing', payment: { metadata: { paymentRecordId: 'paymentRecord.absent' } }, reason: 'payment_without_record' },
    { name: 'other-product', payment: { product_cart: [{ product_id: 'pdt_other_brand', quantity: 1 }] }, reason: 'dodo_product_mismatch' },
    { name: 'currency', payment: { currency: 'EUR' }, reason: 'dodo_currency_mismatch' },
    { name: 'amount', payment: { total_amount: 1999 }, reason: 'dodo_amount_mismatch' },
    { name: 'undercredit', booking: { commissionAmount: 0.5 }, reason: 'commission_mismatch' },
    { name: 'recipient', booking: { referralCode: 'creator-wrong' }, reason: 'referral_binding_mismatch' },
    { name: 'frozen-pricing', record: { pricingSnapshot: { commissionAmount: undefined } }, reason: 'frozen_pricing_unavailable' },
  ];
  for (const variant of reverseCases) {
    await run(`reconcile-report-reverse-old-${variant.name}`, async () => {
      await seed('dodo', variant.record?.providerRecoveryTerminal ? 'needs_recovery' : 'booked', dodoBooking(
        variant.booking,
        { ...variant.record, updatedAt: new Date().toISOString() },
      ));
      dodoPayment = {
        ...dodoPayment,
        ...variant.payment,
        created_at: new Date(Date.now() - 73 * 3600000).toISOString(),
      };
      if (variant.refund) {
        dodoPayment.refund_status = 'partial';
        dodoPayment.refunds = [{ ...dodoRefund, amount: variant.refund, is_partial: true }];
      }
      if (variant.dispute) dodoPayment.disputes = [dodoDispute(variant.dispute)];
      dodoList = [];
      return expectReport(variant.reason ? [variant.reason] : []);
    });
  }
  await run('reconcile-report-reverse-old-refund-unavailable', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.created_at = new Date(Date.now() - 73 * 3600000).toISOString();
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: null, currency: null }];
    providerHook = (request, req, res) => {
      if (request.path !== '/refunds/refund-fixture') return;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'fixture_refund_unavailable' }));
      return true;
    };
    const result = await authorizedReport();
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    assert.ok(providerRequests.some((request) => request.path === '/refunds/refund-fixture'));
    return result;
  });
  await run('reconcile-report-duplicate-canonical-payment', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoList = [dodoSummary(), dodoSummary()];
    const result = await expectReport([]);
    assert.equal(providerRequests.filter((request) => request.path === '/payments/payment-fixture').length, 1);
    return result;
  });
  await run('reconcile-report-bounded-payment-lookups', async () => {
    dodoPayment.metadata = {};
    const payments = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(dodoPayment), payment_id: `payment-parallel-${index}` }));
    dodoList = payments.map(dodoSummary);
    let active = 0, maximum = 0;
    providerHook = async (_request, req, res) => {
      const payment = payments.find(payment => req.url === `/payments/${payment.payment_id}`);
      if (!payment) return false;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, (32 - payments.indexOf(payment)) * 2));
      active--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payment));
      return true;
    };
    const result = await authorizedReport('GET', true);
    assert.equal(result.status, 200);
    assert.ok(maximum > 1 && maximum <= 8, `expected 2..8 concurrent lookups, observed ${maximum}`);
    assert.deepEqual(result.body.items.map(item => item.id), payments.map(payment => payment.payment_id));
    assert.ok(result.body.items.every(item => item.reason === 'payment_without_record'));
    return { maximumConcurrency: maximum, payments: payments.length, report: result.body, readOnly: true };
  });
  await run('reconcile-report-distinct-booking-identities', async () => {
    await seed('dodo', 'booked', dodoBooking());
    await commerce.patch(bookingId).set({ paymentRecordId: recordId }).commit();
    const { _id, _rev, ...canonical } = (await row(bookingId)).payload;
    for (const id of ['booking.extra-one', 'booking.extra-two']) {
      await commerce.create({ ...canonical, _id: id });
    }
    dodoList = [dodoSummary()];
    const result = await expectReport(['payment_record_mismatch', 'payment_record_mismatch']);
    assert.deepEqual(result.body.items.map((item) => item.ref).sort(), ['booking.extra-one', 'booking.extra-two']);
    assert.equal(providerRequests.filter((request) => request.path === '/payments/payment-fixture').length, 1);
    return result;
  });
  for (const foreignState of ['valid', 'malformed', 'unavailable']) {
    await run(`reconcile-report-foreign-${foreignState}-with-site-mismatch`, async () => {
      await seed('dodo', 'started', { ...dodoBooking({}, { bookingId: '' }), booking: null });
      dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
      const foreign = { ...structuredClone(dodoPayment), payment_id: 'payment-foreign', metadata: {}, product_cart: [{ product_id: 'pdt_foreign', quantity: 1 }] };
      if (foreignState === 'malformed') foreign.refunds = null;
      dodoList = [dodoSummary(), dodoSummary(foreign)];
      providerHook = (request, req, res) => {
        if (request.path !== '/payments/payment-foreign') return false;
        res.writeHead(foreignState === 'unavailable' ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(foreignState === 'unavailable' ? { code: 'fixture_unavailable' } : foreign));
        return true;
      };
      const result = await authorizedReport('GET', true);
      if (foreignState === 'valid') {
        assert.equal(result.status, 200);
        assert.deepEqual(reportReasons(result.body), ['payment_without_booking']);
        assert.equal(result.body.complete.payments, true);
      } else {
        assert.equal(result.status, 503);
        assert.equal(result.body.ok, false);
        assert.equal(Object.hasOwn(result.body, 'items'), false);
      }
      return { foreignState, result, refusesIncompleteAudit: foreignState !== 'valid' };
    });
  }
  await run('reconcile-report-clean', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.equal(report.count, 0, JSON.stringify(report));
    assert.deepEqual(report.items, []);
    const booking = (await row(bookingId)).payload;
    assert.equal(Object.hasOwn(booking, 'dodoOriginalCommissionAmount'), false);
    const earnings = await commerce.referralEarnings({
      referralId: 'referral.correct', referralCode: 'creator-correct',
    });
    assert.equal(earnings.total, 1, JSON.stringify(earnings));
    return { count: report.count, from: report.from, to: report.to, booking, earnings };
  });
  await run('reconcile-report-payment-without-record', async () => {
    dodoPayment.metadata = {};
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['payment_without_record']);
    assert.equal(report.items[0].id, 'payment-fixture');
    assert.equal(report.items[0].amount, '9.99');
    return report.items;
  });
  await run('reconcile-report-other-product-ignored', async () => {
    dodoPayment.metadata = {};
    dodoPayment.product_cart = [{ product_id: 'pdt_other_brand', quantity: 1 }];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.equal(report.count, 0, JSON.stringify(report));
    return { count: report.count };
  });
  await run('reconcile-report-payment-without-booking', async () => {
    await seed('dodo', 'captured_webhook', dodoBooking({}, { bookingId: 'booking-missing' }));
    await commerce.delete(bookingId);
    dodoList = [dodoSummary()];
    const result = await authorizedReport('GET', true);
    assert.equal(result.status, 200);
    const report = result.body;
    assert.deepEqual(reportReasons(report), ['payment_without_booking']);
    assert.equal(report.items[0].ref, recordId);
    return { report, readOnly: true, throughNextRoute: true };
  });
  for (const missing of ['booking', 'record']) {
    await run(`reconcile-report-late-capture-without-${missing}`, async () => {
      await seed('dodo', 'captured_webhook', dodoBooking({}, { bookingId: 'booking-missing' }));
      await commerce.delete(bookingId);
      if (missing === 'record') {
        await commerce.delete(recordId);
        dodoPayment.metadata = {};
      }
      dodoPayment.created_at = new Date(Date.now() - 10 * 86400000).toISOString();
      dodoList = [dodoSummary()];
      providerHook = async (_request, req, res) => {
        if (!req.url.startsWith('/payments?')) return false;
        const query = new URL(req.url, origin).searchParams;
        const included = !query.has('created_at_gte') ||
          Date.parse(query.get('created_at_gte')) <= Date.parse(dodoPayment.created_at);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: included ? dodoList : [] }));
        return true;
      };
      const result = await authorizedReport('GET', true);
      assert.equal(result.status, 200);
      assert.deepEqual(reportReasons(result.body), [`payment_without_${missing}`]);
      assert.ok(result.providerRequests.some(request => {
        if (!request.path.startsWith('/payments?')) return false;
        const query = new URL(request.path, origin).searchParams;
        return !query.has('created_at_gte') && query.get('status') === 'succeeded';
      }));
      return { report: result.body, readOnly: true, createdDaysBeforeSettlement: 10 };
    });
  }
  for (const transition of ['settlement', 'public-link', 'refund', 'dispute-open', 'dispute-closed']) {
    await run(`reconcile-report-transition-grace-${transition}`, async () => {
      const observedAt = originalNow();
      const changedAt = observedAt - 60000;
      const old = new Date(observedAt - 10 * 86400000).toISOString();
      const recent = new Date(changedAt).toISOString();
      await seed('dodo', 'booked', dodoBooking());
      dodoPayment.created_at = old;
      dodoPayment.updated_at = recent;
      let reason, keys = canonicalKeys;
      if (['settlement', 'public-link'].includes(transition)) {
        await commerce.delete(bookingId);
        keys = canonicalKeys.slice(0, 2);
        if (transition === 'public-link') {
          await commerce.delete(recordId);
          dodoPayment.metadata = {};
          keys = canonicalKeys.slice(0, 1);
        }
        reason = transition === 'public-link' ? 'payment_without_record' : 'payment_without_booking';
      } else if (transition === 'refund') {
        dodoPayment.updated_at = null;
        dodoPayment.refund_status = 'partial';
        dodoPayment.refunds = [{ ...dodoRefund, amount: 250, is_partial: true, created_at: recent }];
        reason = 'refund_not_applied';
      } else {
        const closed = transition === 'dispute-closed';
        dodoPayment.disputes = [{ ...dodoDispute(closed ? 'dispute_won' : 'dispute_opened'), created_at: closed ? old : recent }];
        if (closed) await commerce.patch(bookingId).set({ status: 'pending', dodoDisputeActive: true, dodoDisputeBookingStatus: 'captured', dodoOriginalCommissionAmount: 1, commissionAmount: 0 }).commit();
        else delete dodoPayment.updated_at;
        reason = 'dispute_not_applied';
      }
      dodoList = [dodoSummary()];
      Date.now = () => observedAt;
      const before = await authorizedReport('GET', true);
      const targetedBefore = await targetReport(keys);
      assert.equal(before.status, 200, JSON.stringify(before.body));
      assert.equal(before.body.count, 0, JSON.stringify(before.body));
      assertTarget(targetedBefore, keys, keys.map(() => 'unknown'), []);
      dodoList = [];
      const reverseBefore = await authorizedReport('GET', true);
      assert.equal(reverseBefore.body.count, 0, JSON.stringify(reverseBefore.body));
      dodoList = [dodoSummary()];
      Date.now = () => changedAt + 1800000 - 1;
      const boundaryBefore = await targetReport(keys);
      assertTarget(boundaryBefore, keys, keys.map(() => 'unknown'), []);
      Date.now = () => changedAt + 1800000;
      const mature = await authorizedReport('GET', true);
      const targetedMature = await targetReport(keys);
      assert.equal(mature.status, 200, JSON.stringify(mature.body));
      assert.deepEqual(reportReasons(mature.body), [reason]);
      assertTarget(targetedMature, keys, keys.map(() => 'unresolved'), [reason]);
      Date.now = originalNow;
      let repair;
      if (['refund', 'dispute-open', 'dispute-closed'].includes(transition)) {
        const type = transition === 'refund' ? 'refund.succeeded' : transition === 'dispute-open' ? 'dispute.opened' : 'dispute.won';
        const webhook = await requestFlow('dodo', { req: dodoReq(transition === 'refund' ? dodoPayment.refunds[0] : dodoPayment.disputes[0], type) });
        assert.equal(webhook.status, 200, JSON.stringify(webhook));
        const duringGrace = await targetReport(keys);
        assertTarget(duringGrace, keys, keys.map(() => 'unknown'), []);
        Date.now = () => changedAt + 1800000;
        const after = await authorizedReport('GET', true);
        const targetedAfter = await targetReport(keys);
        assert.equal(after.body.count, 0, JSON.stringify(after.body));
        assertTarget(targetedAfter, keys, keys.map(() => 'recovered'), []);
        Date.now = originalNow;
        repair = { webhook, duringGrace, after, targetedAfter };
      }
      return { transition, provider: dodoPayment, before, targetedBefore, reverseBefore, boundaryBefore, mature, targetedMature, repair, createdDaysBeforeTransition: 10, graceMilliseconds: 1800000 };
    });
  }
  for (const update of ['absent', null, 'old', 'invalid', 42, 'future']) {
    await run(`reconcile-report-transition-timestamp-${String(update)}`, async () => {
      await seed('dodo', 'booked', dodoBooking());
      await commerce.delete(bookingId);
      if (update !== 'absent') dodoPayment.updated_at = update === 'old' ? dodoPayment.created_at
        : update === 'future' ? new Date(originalNow() + 86400000).toISOString() : update;
      dodoList = [dodoSummary()];
      const report = await authorizedReport('GET', true);
      const targeted = await targetReport(canonicalKeys.slice(0, 2));
      if (['invalid', 42, 'future'].includes(update)) {
        assert.equal(report.status, 503, JSON.stringify(report.body));
        assert.equal(targeted.status, 503, JSON.stringify(targeted.body));
      } else {
        assert.equal(report.status, 200, JSON.stringify(report.body));
        assert.deepEqual(reportReasons(report.body), ['payment_without_booking']);
        assertTarget(targeted, canonicalKeys.slice(0, 2), ['unresolved', 'unresolved'], ['payment_without_booking']);
      }
      return { update, report, targeted };
    });
  }
  for (const field of ['created_at', 'refund', 'dispute']) {
    await run(`reconcile-report-transition-malformed-${field}`, async () => {
      await seed('dodo', 'booked', dodoBooking());
      if (field === 'created_at') dodoPayment.created_at = 'invalid';
      if (field === 'refund') dodoPayment.refunds = [{ ...dodoRefund, created_at: 'invalid' }];
      if (field === 'dispute') dodoPayment.disputes = [{ ...dodoDispute('dispute_opened'), created_at: 42 }];
      dodoList = [dodoSummary()];
      const report = await authorizedReport('GET', true);
      const targeted = await targetReport(canonicalKeys);
      assert.equal(report.status, 503, JSON.stringify(report.body));
      assert.equal(targeted.status, 503, JSON.stringify(targeted.body));
      return { field, report, targeted };
    });
  }
  await run('reconcile-report-transition-terminal-immediate', async () => {
    await seed('dodo', 'needs_recovery', dodoBooking({}, {
      reconciliationRecoveryTerminal: true, bookingId: '', updatedAt: new Date().toISOString(),
    }));
    await commerce.delete(bookingId);
    dodoPayment.updated_at = new Date().toISOString();
    dodoList = [dodoSummary()];
    const report = await authorizedReport('GET', true);
    const targeted = await targetReport(canonicalKeys.slice(0, 2));
    assert.deepEqual(reportReasons(report.body), ['owner_review_unknown']);
    assertTarget(targeted, canonicalKeys.slice(0, 2), ['unresolved', 'unresolved'], ['owner_review_unknown', 'owner_review_unknown']);
    return { report, targeted };
  });
  await run('reconcile-report-transition-during-scan', async () => {
    await seed('dodo', 'booked', dodoBooking());
    await commerce.delete(bookingId);
    const startedAt = originalNow();
    Date.now = () => startedAt;
    dodoList = [dodoSummary()];
    providerHook = async (request) => {
      if (request.path !== '/payments/payment-fixture') return;
      dodoPayment.updated_at = new Date(startedAt + 90000).toISOString();
      Date.now = () => startedAt + 120000;
    };
    const report = await authorizedReport('GET', true);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.at, new Date(startedAt).toISOString());
    assert.equal(report.body.count, 0);
    return { report, startedAt, providerChangedAt: dodoPayment.updated_at, observedAt: Date.now() };
  });
  await run('reconcile-report-booking-amount-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking({ netAmount: 19.99 }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['amount_mismatch']);
    return report.items;
  });
  await run('reconcile-report-dodo-amount-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.total_amount = 1999;
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['dodo_amount_mismatch']);
    return report.items;
  });
  await run('reconcile-report-refund-not-applied', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['refund_not_applied']);
    return report.items;
  });
  await run('reconcile-report-dispute-not-applied', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.disputes = [
      {
        dispute_id: 'dispute-fixture',
        payment_id: 'payment-fixture',
        dispute_status: 'dispute_opened',
        dispute_stage: 'dispute',
        amount: '999',
        currency: 'USD',
      },
    ];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['dispute_not_applied']);
    return report.items;
  });
  await run('reconcile-report-commission-over-kept-share', async () => {
    await seed('dodo', 'booked', dodoBooking({ commissionAmount: 5 }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['commission_exceeds_kept_share']);
    return report.items;
  });
  await run('reconcile-report-owner-review', async () => {
    await seed('dodo', 'needs_recovery', dodoBooking({}, {
      providerRecoveryTerminal: true,
      providerRecoveryTerminalReason: 'dodo_currency_mismatch',
      updatedAt: new Date().toISOString(),
    }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['owner_review_dodo_currency_mismatch']);
    return report.items;
  });
  await run('reconcile-report-owner-review-outside-payment-window', async () => {
    await seed('dodo', 'needs_recovery', dodoBooking({}, {
      providerRecoveryTerminal: true,
      providerRecoveryTerminalReason: 'dodo_dispute_lost_owner_review',
      updatedAt: new Date().toISOString(),
    }));
    dodoList = [];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['owner_review_dodo_dispute_lost_owner_review']);
    return report.items;
  });
  for (const variant of [
    { name: 'reconciliation', flag: true, expected: 'owner_review_unknown' },
    { name: 'both', flag: true, providerFlag: true, expected: 'owner_review_dodo_currency_mismatch' },
    { name: 'false', flag: false },
    { name: 'absent' },
    { name: 'null', flag: null },
    { name: 'string', flag: 'true' },
    { name: 'booked', flag: true, status: 'booked' },
    { name: 'other-provider', flag: true, provider: 'paypal' },
    { name: 'old', flag: true, age: 96 * 3600000 },
    { name: 'future', flag: true, age: -2 * 3600000 },
  ]) await run(`reconcile-report-terminal-record-${variant.name}`, async () => {
    const data = dodoBooking({}, {
      bookingId: '', updatedAt: new Date(originalNow() - (variant.age || 0)).toISOString(),
      ...(Object.hasOwn(variant, 'flag') ? { reconciliationRecoveryTerminal: variant.flag } : {}),
      ...(variant.providerFlag ? { providerRecoveryTerminal: true, providerRecoveryTerminalReason: 'dodo_currency_mismatch' } : {}),
    });
    data.booking = null;
    await seed(variant.provider || 'dodo', variant.status || 'needs_recovery', data);
    const window = await authorizedReport('GET', true);
    assert.equal(window.status, 200, JSON.stringify(window.body));
    assert.deepEqual(reportReasons(window.body), variant.expected ? [variant.expected] : [], JSON.stringify(window.body));
    assert.equal(window.body.complete.records, true);
    let targeted;
    if (variant.expected) {
      assert.equal(window.body.items[0].key, `record:${recordId}`);
      targeted = await targetReport([`record:${recordId}`, 'payment:payment-fixture']);
      assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
      assert.deepEqual(targeted.body.checks.map(check => check.state), ['unresolved', 'unresolved']);
      assert.ok(targeted.body.items.every(item => item.reason === variant.expected));
    }
    return { variant, window, targeted };
  });
  await run('reconcile-report-reconciliation-terminal-read-unavailable', async () => {
    let failed = false;
    fixture.setRequestHook((phase, request) => {
      if (phase !== 'before' || !request.body?.p_filters?.some(filter => filter.path === 'reconciliationRecoveryTerminal')) return;
      failed = true;
      throw new Error('fixture_terminal_read_unavailable');
    });
    const report = await authorizedReport('GET', true);
    assert.equal(failed, true);
    assert.equal(report.status, 503);
    assert.equal(report.body.code, 'reconcile_report_unavailable');
    return report;
  });
  await run('reconcile-report-upgrade-credit-owner-review', async () => {
    await seed('dodo', 'needs_recovery', dodoBooking({}, {
      providerRecoveryTerminal: true,
      providerRecoveryTerminalReason: 'upgrade_credit_changed_after_quote',
      updatedAt: new Date().toISOString(),
    }));
    dodoList = [];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['owner_review_upgrade_credit_changed_after_quote']);
    return report.items;
  });
  await run('reconcile-report-booking-without-payment', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.status = 'failed';
    dodoList = [];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['booking_without_payment']);
    assert.equal(report.items[0].ref, bookingId);
    return report.items;
  });
  await run('reconcile-report-booking-payment-not-found', async () => {
    await seed('dodo', 'booked', dodoBooking({ dodoPaymentId: 'payment-gone' }));
    dodoList = [];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['booking_without_payment']);
    assert.equal(report.items[0].id, 'payment-gone');
    assert.equal(report.items[0].ref, bookingId);
    return report.items;
  });
  await run('reconcile-report-dodo-lookup-unavailable', async () => {
    await seed(
      'dodo',
      'booked',
      dodoBooking({
        dodoPaymentId: 'payment-unreachable',
        _createdAt: new Date(Date.now() - 3600000).toISOString(),
      }),
    );
    dodoList = [];
    const saved = process.env.RECONCILE_REPORT_TOKEN;
    try {
      process.env.RECONCILE_REPORT_TOKEN = 'z'.repeat(40);
      const result = await reportRoute({
        authorization: `Bearer ${'z'.repeat(40)}`,
      });
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      assert.equal(JSON.stringify(result.body).includes('booking_without_payment'), false);
      return result;
    } finally {
      if (saved === undefined) delete process.env.RECONCILE_REPORT_TOKEN;
      else process.env.RECONCILE_REPORT_TOKEN = saved;
    }
  });
  await run('reconcile-report-no-personal-data', async () => {
    await seed(
      'dodo',
      'booked',
      dodoBooking({
        netAmount: 19.99,
        email: 'customer@example.invalid',
        discord: 'fixture_handle',
      }),
    );
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    const text = JSON.stringify(report);
    for (const secret of [
      'customer@example.invalid',
      'fixture_handle',
      'Synthetic address',
      'Fixture',
      'customer-fixture',
    ])
      assert.ok(!text.includes(secret), secret);
    assert.deepEqual(Object.keys(report.items[0]).sort(), [
      'amount',
      'currency',
      'id',
      'key',
      'reason',
      'ref',
    ]);
    return { items: report.items };
  });
  await run('reconcile-report-route-auth', async () => {
    const saved = process.env.RECONCILE_REPORT_TOKEN;
    try {
      delete process.env.RECONCILE_REPORT_TOKEN;
      assert.equal((await reportRoute({ authorization: 'Bearer anything' })).status, 404);
      process.env.RECONCILE_REPORT_TOKEN = 'x'.repeat(40);
      assert.equal((await reportRoute({})).status, 403);
      assert.equal((await reportRoute({ authorization: `Bearer ${'y'.repeat(40)}` })).status, 403);
      await seed('dodo', 'booked', dodoBooking());
      dodoList = [dodoSummary()];
      const ok = await reportRoute({ authorization: `Bearer ${'x'.repeat(40)}` });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.count, 0, JSON.stringify(ok.body));
      return { missing: 404, wrong: 403, right: ok.status };
    } finally {
      if (saved === undefined) delete process.env.RECONCILE_REPORT_TOKEN;
      else process.env.RECONCILE_REPORT_TOKEN = saved;
    }
  });
  for (const [field, value] of [
    ['paymentProvider', 'paypal'],
    ['paymentRecordId', 'paymentRecord.other'],
    ['dodoPaymentId', 'payment-other'],
    ['dodoCheckoutSessionId', 'checkout-other'],
  ])
    await run(`reconcile-report-booking-binding-${field}`, async () => {
      await seed('dodo', 'booked', dodoBooking({ [field]: value }));
      dodoList = [dodoSummary()];
      const report = await reconcileReport();
      assert.ok(reportReasons(report).includes('payment_record_mismatch'), JSON.stringify(report));
      return report.items;
    });
  await run('reconcile-report-booking-currency-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking({ currency: 'EUR' }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['amount_mismatch']);
    return report.items;
  });
  await run('reconcile-report-booking-total-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking({ dodoTotalAmount: 19.99 }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['amount_mismatch']);
    return report.items;
  });
  await run('reconcile-report-booking-status-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking({ status: 'pending' }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['payment_record_mismatch']);
    return report.items;
  });
  for (const amount of [1, 5])
    await run(`reconcile-report-partial-refund-mismatch-${amount}`, async () => {
      await seed(
        'dodo',
        'booked',
        dodoBooking({
          refundedAmount: amount,
          refundStatus: 'partial',
          commissionAmount: 0,
        }),
      );
      dodoPayment.refund_status = 'partial';
      dodoPayment.refunds = [{ ...dodoRefund, amount: 250, is_partial: true }];
      dodoList = [dodoSummary()];
      const report = await reconcileReport();
      assert.deepEqual(reportReasons(report), ['refund_not_applied']);
      return report.items;
    });
  await run('reconcile-report-full-refund-accounting-missing', async () => {
    await seed(
      'dodo',
      'refunded',
      dodoBooking({ status: 'refunded', commissionAmount: 0, refundedAmount: 0 }),
    );
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['refund_not_applied']);
    return report.items;
  });
  await run('reconcile-report-refund-details-retrieved', async () => {
    await seed(
      'dodo',
      'booked',
      dodoBooking({
        refundedAmount: 2.5,
        refundStatus: 'partial',
        commissionAmount: 0.75,
        dodoOriginalCommissionAmount: 1,
      }),
    );
    dodoRefund = { ...dodoRefund, amount: 250, is_partial: true };
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: null, currency: null }];
    dodoList = [dodoSummary()];
    const before = await snapshot({ receipts: true });
    const report = await reconcileReport();
    assert.equal(report.count, 0, JSON.stringify(report));
    assert.ok(providerRequests.some((request) => request.path === '/refunds/refund-fixture'));
    assert.deepEqual(await snapshot({ receipts: true }), before);
    return { count: report.count, noMutation: true };
  });
  for (const status of ['pending', 'failed', 'review'])
    await run(`reconcile-report-refund-${status}`, async () => {
      await seed('dodo', 'booked', dodoBooking());
      dodoPayment.refunds = [{ ...dodoRefund, status, amount: null, currency: null }];
      dodoList = [dodoSummary()];
      const report = await reconcileReport();
      assert.equal(report.count, 0, JSON.stringify(report));
      return { count: report.count };
    });
  await run('reconcile-report-refund-lookup-unavailable', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: null, currency: null }];
    dodoList = [dodoSummary()];
    providerHook = (request, req, res) => {
      if (request.path !== '/refunds/refund-fixture') return;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'fixture_refund_unavailable' }));
      return true;
    };
    const result = await authorizedReport();
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    return { status: result.status };
  });
  await run('reconcile-report-dispute-resolved-but-stored-active', async () => {
    await seed(
      'dodo',
      'booked',
      dodoBooking({
        status: 'pending',
        dodoDisputeActive: true,
        commissionAmount: 0,
      }),
    );
    dodoPayment.disputes = [
      {
        dispute_id: 'dispute-fixture',
        payment_id: 'payment-fixture',
        dispute_status: 'dispute_won',
        dispute_stage: 'dispute',
        amount: '999',
        currency: 'USD',
      },
    ];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['dispute_not_applied']);
    return report.items;
  });
  for (const cancelBeforeOpen of [true, false]) {
    for (const resolvedStatus of ['dispute_won', 'dispute_cancelled']) {
      await run(`reconcile-report-admin-cancel-${cancelBeforeOpen ? 'before' : 'during'}-${resolvedStatus}`, async () => {
        await seed('dodo', 'booked', dodoBooking({ status: cancelBeforeOpen ? 'cancelled' : 'captured' }));
        dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
        dodoPayment.disputes = [dodoDispute('dispute_opened')];
        dodoList = [dodoSummary()];
        const opened = await requestFlow('dodo', { req: dodoReq(dodoPayment, 'dispute.opened') });
        assert.equal(opened.status, 200, JSON.stringify(opened));
        if (!cancelBeforeOpen) await commerce.patch(bookingId).set({ status: 'cancelled' }).commit();
        const openWindow = await authorizedReport('GET', true);
        const openTargets = await targetReport(canonicalKeys);
        dodoPayment.disputes = [dodoDispute(resolvedStatus)];
        const resolved = await requestFlow('dodo', { req: dodoReq(dodoPayment, 'dispute.' + resolvedStatus.slice(8), `dodo-resolved-${scenarioNumber}`) });
        assert.equal(resolved.status, 200, JSON.stringify(resolved));
        const booking = (await row(bookingId)).payload;
        assert.equal(booking.status, 'cancelled');
        assert.equal(booking.commissionAmount, 1);
        const earnings = await commerce.referralEarnings({ referralId: 'referral.correct', referralCode: 'creator-correct' });
        assert.equal(earnings.total, 0);
        const closedWindow = await authorizedReport('GET', true);
        const closedTargets = await targetReport(canonicalKeys);
        for (const result of [openWindow, openTargets, closedWindow, closedTargets]) {
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.count, 0, JSON.stringify(result.body));
          assert.ok(result.body.checks.every(check => check.state === 'recovered'));
        }
        await commerce.patch(bookingId).set({ dodoDisputeActive: true }).commit();
        const unsynced = await targetReport(canonicalKeys);
        assertTarget(unsynced, canonicalKeys, Array(3).fill('unresolved'), ['dispute_not_applied']);
        return { opened, resolved, booking, earnings, openWindow, openTargets, closedWindow, closedTargets, unsynced };
      });
    }
  }
  await run('reconcile-report-disputed-pending-commission', async () => {
    await seed('dodo', 'needs_recovery', dodoBooking({ status: 'pending', dodoDisputeActive: true }));
    dodoPayment.disputes = [
      {
        dispute_id: 'dispute-fixture',
        payment_id: 'payment-fixture',
        dispute_status: 'dispute_opened',
        dispute_stage: 'dispute',
        amount: '999',
        currency: 'USD',
      },
    ];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['commission_exceeds_kept_share']);
    return report.items;
  });
  await run('reconcile-report-refunded-commission', async () => {
    await seed(
      'dodo',
      'refunded',
      dodoBooking({
        status: 'refunded',
        refundedAmount: 9.99,
        refundStatus: 'full',
      }),
    );
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), []);
    return report.items;
  });
  await run('reconcile-report-refunded-without-booking', async () => {
    await seed('dodo', 'refunded', dodoBooking({}, { bookingId: 'booking-missing' }));
    await commerce.delete(bookingId);
    dodoPayment.refund_status = 'full';
    dodoPayment.refunds = [dodoRefund];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['payment_without_booking']);
    return report.items;
  });
  await run('reconcile-report-provider-identity-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoPayment.payment_id = 'payment-other';
    dodoList = [{ ...dodoSummary(), payment_id: 'payment-fixture' }];
    const result = await authorizedReport();
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    return { status: result.status };
  });
  await run('reconcile-report-refund-identity-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [
      {
        ...dodoRefund,
        payment_id: 'payment-other',
        amount: 250,
        is_partial: true,
      },
    ];
    dodoList = [dodoSummary()];
    const result = await authorizedReport();
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    return { status: result.status };
  });
  await run('reconcile-report-dispute-identity-mismatch', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.disputes = [
      {
        dispute_id: 'dispute-fixture',
        payment_id: 'payment-other',
        dispute_status: 'dispute_opened',
        dispute_stage: 'dispute',
        amount: '999',
        currency: 'USD',
      },
    ];
    dodoList = [dodoSummary()];
    const result = await authorizedReport();
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    return { status: result.status };
  });
  await run('reconcile-report-database-unavailable', async () => {
    let failed = false;
    fixture.setRequestHook((phase, request) => {
      if (phase === 'before' && request.path === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted') {
        failed = true;
        throw new Error('fixture_database_unavailable');
      }
    });
    const result = await authorizedReport();
    assert.equal(failed, true);
    assert.equal(result.status, 503);
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    return { status: result.status };
  });
  await run('reconcile-report-zero-based-pagination', async () => {
    const requests = [];
    providerHook = (request, req, res) => {
      if (!request.path.startsWith('/payments?')) return;
      const query = new URL(request.path, origin).searchParams;
      const page = Number(query.get('page_number'));
      requests.push(page);
      assert.equal(query.get('page_size'), '100');
      const items =
        page === 0
          ? Array.from({ length: 100 }, (_, index) => ({
              ...dodoSummary(),
              payment_id: `payment-failed-${index}`,
              status: 'failed',
            }))
          : [dodoSummary()];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items }));
      return true;
    };
    const report = await reconcileReport();
    assert.deepEqual(requests, [0, 1]);
    assert.deepEqual(reportReasons(report), ['payment_without_record']);
    assert.equal(new Date(report.to) - new Date(report.from), (72 * 60 - 30) * 60000);
    return { requests, items: report.items };
  });
  await run('reconcile-report-page-cap', async () => {
    dodoList = Array.from({ length: 100 }, (_, index) => ({
      ...dodoSummary(),
      payment_id: `payment-failed-${index}`,
      status: 'failed',
    }));
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['report_truncated']);
    assert.equal(report.items[0].key, 'scan:dodo-payments');
    assert.deepEqual(report.complete, { payments: false, bookings: true, records: true, items: true });
    const pages = providerRequests.filter((request) => request.path.startsWith('/payments?'));
    assert.equal(pages.length, 20);
    assert.equal(new URL(pages.at(-1).path, origin).searchParams.get('page_number'), '19');
    return { pages: pages.length, items: report.items };
  });
  await run('reconcile-report-malformed-list', async () => {
    providerHook = (request, req, res) => {
      if (!request.path.startsWith('/payments?')) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture_bad_response' }));
      return true;
    };
    const result = await authorizedReport();
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'items'), false);
    return { status: result.status };
  });
  await run('reconcile-report-personal-data-in-metadata', async () => {
    dodoPayment.metadata = { paymentRecordId: 'customer@example.invalid' };
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['payment_without_record']);
    assert.equal(report.items[0].ref, '');
    assert.equal(JSON.stringify(report).includes('customerexample.invalid'), false);
    return report.items;
  });
  await run('reconcile-report-unconfigured-products', async () => {
    const saved = process.env.DODO_PAYMENTS_PRODUCT_ID;
    try {
      delete process.env.DODO_PAYMENTS_PRODUCT_ID;
      dodoPayment.metadata = {};
      dodoList = [dodoSummary()];
      const result = await authorizedReport();
      assert.equal(result.status, 503, JSON.stringify(result.body));
      return { status: result.status };
    } finally {
      if (saved === undefined) delete process.env.DODO_PAYMENTS_PRODUCT_ID;
      else process.env.DODO_PAYMENTS_PRODUCT_ID = saved;
    }
  });
  await run('reconcile-report-record-checkout-missing', async () => {
    await seed('dodo', 'booked', dodoBooking({}, { providerOrderId: '' }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['dodo_payment_binding_mismatch']);
    return report.items;
  });
  for (const field of ['total_amount', 'refunds'])
    await run(`reconcile-report-incomplete-detail-${field}`, async () => {
      await seed('dodo', 'booked', dodoBooking());
      dodoList = [dodoSummary()];
      delete dodoPayment[field];
      const result = await authorizedReport();
      assert.equal(result.status, 503, JSON.stringify(result.body));
      assert.equal(Object.hasOwn(result.body, 'items'), false);
      return { status: result.status };
    });
  await run('reconcile-report-refund-status-mismatch', async () => {
    await seed(
      'dodo',
      'booked',
      dodoBooking({ refundedAmount: 2.5, refundStatus: 'full', commissionAmount: 0.75 }),
    );
    dodoPayment.refund_status = 'partial';
    dodoPayment.refunds = [{ ...dodoRefund, amount: 250, is_partial: true }];
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['refund_not_applied']);
    return report.items;
  });
  await run('reconcile-report-personal-data-in-recovery-code', async () => {
    await seed('dodo', 'needs_recovery', dodoBooking({}, {
      providerRecoveryTerminal: true,
      providerRecoveryTerminalReason: 'customer@example.invalid',
      updatedAt: new Date().toISOString(),
    }));
    dodoList = [dodoSummary()];
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['owner_review_unknown']);
    assert.equal(JSON.stringify(report).includes('customer'), false);
    return report.items;
  });
  await run('reconcile-report-booking-lookup-cap', async () => {
    let transaction = commerce.transaction();
    for (let index = 0; index < 201; index += 1) {
      transaction.create({
        _id: `booking.report-${index}`,
        _type: 'booking',
        paymentProvider: 'dodo',
        dodoPaymentId: `payment-report-${index}`,
        status: 'captured',
        netAmount: 9.99,
        backendOwner: 'supabase',
        cutoverGeneration: 0,
      });
      if ((index + 1) % 100 === 0) {
        await transaction.commit();
        transaction = commerce.transaction();
      }
    }
    await transaction.commit();
    providerHook = (request, req, res) => {
      if (!request.path.startsWith('/payments/payment-report-')) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...dodoPayment,
          payment_id: request.path.slice('/payments/'.length),
        }),
      );
      return true;
    };
    const report = await reconcileReport();
    assert.equal(report.count, 201);
    assert.equal(report.items.length, 50);
    assert.equal(report.items[0].reason, 'report_truncated');
    assert.equal(report.items[0].key, 'scan:dodo-bookings');
    assert.deepEqual(report.complete, { payments: true, bookings: false, records: true, items: false });
    assert.ok(report.items.slice(1).every((item) => item.key.startsWith('booking:booking.report-')));
    assert.ok(report.items.slice(1).every((item) => item.reason === 'payment_without_record'));
    assert.equal(
      providerRequests.filter((request) => request.path.startsWith('/payments/payment-report-'))
        .length,
      200,
    );
    return { count: report.count, items: report.items, lookups: 200 };
  });
  await run('reconcile-report-old-bookings-do-not-hide-current', async () => {
    let transaction = commerce.transaction();
    for (let index = 0; index < 500; index += 1) {
      transaction.create({
        _id: `booking.000-old-${String(index).padStart(3, '0')}`,
        _type: 'booking',
        _createdAt: '2026-01-01T00:00:00.000Z',
        paymentProvider: 'dodo',
        dodoPaymentId: `payment-old-${index}`,
        status: 'captured',
        netAmount: 9.99,
        backendOwner: 'supabase',
        cutoverGeneration: 0,
      });
      if ((index + 1) % 100 === 0 && index !== 499) {
        await transaction.commit();
        transaction = commerce.transaction();
      }
    }
    await transaction.commit();
    await seed('dodo', 'booked', dodoBooking({ dodoPaymentId: 'payment-gone' }));
    const report = await reconcileReport();
    assert.deepEqual(reportReasons(report), ['booking_without_payment']);
    assert.equal(report.items[0].ref, bookingId);
    return report.items;
  });
  await run('reconcile-report-auth-method-and-no-writes', async () => {
    const saved = process.env.RECONCILE_REPORT_TOKEN;
    const before = await snapshot({ receipts: true });
    try {
      process.env.RECONCILE_REPORT_TOKEN = 'short';
      const short = await reportRoute({ authorization: 'Bearer short' });
      assert.equal(short.status, 404);
      process.env.RECONCILE_REPORT_TOKEN = 'x'.repeat(40);
      assert.equal((await reportRoute({ authorization: 'Bearer too-short' })).status, 403);
      const method = await reportRoute({ authorization: `Bearer ${'x'.repeat(40)}` }, 'POST');
      assert.equal(method.status, 405);
      assert.equal(method.headers.allow, 'GET');
      assert.equal(method.headers['cache-control'], 'private, no-store');
      assert.deepEqual(providerRequests, []);
      const result = await authorizedReport();
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.count, 0);
      assert.equal(result.headers['cache-control'], 'private, no-store');
      assert.deepEqual(await snapshot({ receipts: true }), before);
      assert.ok(providerRequests.every((request) => request.method === 'GET'));
      return { short: short.status, method: method.status, noMutation: true };
    } finally {
      if (saved === undefined) delete process.env.RECONCILE_REPORT_TOKEN;
      else process.env.RECONCILE_REPORT_TOKEN = saved;
    }
  });
  await run('reconcile-report-next-route', async () => {
    const before = await snapshot({ receipts: true });
    const results = {};
    for (const method of ['GET', 'HEAD', 'POST']) {
      const result = await authorizedReport(method, true);
      assert.equal(result.status, method === 'GET' ? 200 : 405, JSON.stringify(result));
      assert.equal(result.headers['cache-control'], 'private, no-store');
      if (method === 'GET') assert.deepEqual(result.body.items, []);
      else assert.equal(result.headers.allow, 'GET');
      results[method] = result.status;
    }
    assert.deepEqual(await snapshot({ receipts: true }), before);
    return { results, noMutation: true };
  });
  await run('reconcile-report-target-extra-booking', async () => {
    const old = new Date(Date.now() - 73 * 3600000).toISOString();
    await seed('dodo', 'booked', dodoBooking({ _createdAt: old }));
    const { _id, _rev, ...canonical } = (await row(bookingId)).payload;
    await commerce.create({ ...canonical, _id: 'booking.extra', netAmount: 19.99 });
    dodoPayment.created_at = old;
    const keys = ['payment:payment-fixture', 'booking:booking.extra'];
    const report = await targetReport(keys);
    assertTarget(report, keys, ['recovered', 'unresolved'], ['payment_record_mismatch']);
    assert.equal(report.body.items[0].key, 'booking:booking.extra');
    assert.equal(report.providerRequests.length, 1);
    await commerce.delete('booking.extra');
    const control = await targetReport(keys);
    assertTarget(control, keys, ['recovered', 'unknown'], []);
    assert.deepEqual(control.body.checks[1].keys, ['booking:booking.extra']);
    return { report, control };
  });
  for (const state of ['failed', 'null', 'missing']) {
    await run('reconcile-report-target-payment-' + state, async () => {
      const paymentId = state === 'missing' ? 'payment-gone' : 'payment-fixture';
      await seed('dodo', 'booked', dodoBooking({ dodoPaymentId: paymentId }, { providerPaymentId: paymentId }));
      dodoPayment.status = state === 'null' ? null : 'failed';
      const keys = ['payment:' + paymentId, 'booking:' + bookingId, 'record:' + recordId];
      const report = await targetReport(keys);
      const reason = state === 'missing' ? 'payment_not_found' : 'payment_not_succeeded';
      assertTarget(report, keys, Array(3).fill('unresolved'), [reason, 'booking_without_payment', reason]);
      assert.deepEqual(report.body.items.map((item) => item.key), keys);
      assert.equal(report.providerRequests.length, 1);
      if (state === 'missing') {
        assert.deepEqual(report.body.items[0], {
          key: 'payment:payment-gone', id: 'payment-gone', ref: '', amount: '', currency: '', reason,
        });
      }
      return { provider: dodoPayment, report };
    });
  }
  await run('reconcile-report-target-unknown-and-fallback', async () => {
    await seed('dodo', 'booked', dodoBooking({ paymentProvider: 'paypal' }, { provider: 'paypal' }));
    const keys = ['booking:booking.missing', 'record:paymentRecord.missing', 'booking:' + bookingId, 'record:' + recordId];
    const unknown = await targetReport(keys);
    assertTarget(unknown, keys, Array(4).fill('unknown'), []);
    assert.ok(unknown.body.checks.every((check) => check.keys.length === 1));
    assert.deepEqual(unknown.providerRequests, []);
    await commerce.patch(bookingId).set({ paymentProvider: 'dodo', dodoPaymentId: '' }).commit();
    await commerce.patch(recordId).set({ provider: 'dodo', providerPaymentId: '' }).commit();
    const missingId = await targetReport(['record:' + recordId, 'booking:' + bookingId]);
    assertTarget(missingId, ['record:' + recordId, 'booking:' + bookingId], ['unknown', 'unresolved'], ['booking_without_payment']);
    assert.deepEqual(missingId.providerRequests, []);
    await commerce.patch(bookingId).set({ dodoPaymentId: ' payment-fixture ' }).commit();
    const unsafeId = await targetReport(['record:' + recordId, 'booking:' + bookingId]);
    assertTarget(unsafeId, ['record:' + recordId, 'booking:' + bookingId], ['unknown', 'unresolved'], ['booking_without_payment']);
    assert.deepEqual(unsafeId.providerRequests, []);
    await commerce.patch(bookingId).set({ dodoPaymentId: 'payment-fixture', paymentRecordId: 'paymentRecord.wrong' }).commit();
    const wrongAssociation = await targetReport(['record:' + recordId]);
    assertTarget(wrongAssociation, ['record:' + recordId], ['unknown'], []);
    assert.deepEqual(wrongAssociation.providerRequests, []);
    await commerce.patch(bookingId).set({ paymentRecordId: recordId }).commit();
    const fallback = await targetReport(['record:' + recordId]);
    assertTarget(fallback, ['record:' + recordId], ['recovered'], []);
    assert.equal(fallback.providerRequests.length, 1);
    await commerce.patch(recordId).set({ providerPaymentId: ' payment-fixture ' }).commit();
    const invalidPrimary = await targetReport(['record:' + recordId]);
    assertTarget(invalidPrimary, ['record:' + recordId], ['unknown'], []);
    assert.deepEqual(invalidPrimary.providerRequests, []);
    return { unknown, missingId, unsafeId, wrongAssociation, fallback, invalidPrimary };
  });
  await run('reconcile-report-target-record-binding', async () => {
    await seed('dodo', 'booked', dodoBooking());
    dodoPayment.metadata = { paymentRecordId: 'paymentRecord.somebody' };
    const binding = await targetReport(['record:' + recordId]);
    assertTarget(binding, ['record:' + recordId], ['unresolved'], ['payment_record_mismatch']);
    assert.equal(binding.body.items[0].key, 'record:' + recordId);
    assert.equal(binding.body.items[0].ref, recordId);
    dodoPayment.metadata = {};
    dodoPayment.product_cart = [{ product_id: 'pdt_unrelated', quantity: 1 }];
    const unrelated = await targetReport(['payment:payment-fixture']);
    assertTarget(unrelated, ['payment:payment-fixture'], ['unresolved'], ['payment_without_record']);
    return { binding, unrelated };
  });
  for (const provider of ['missing', 'paypal']) {
    await run('reconcile-report-target-extra-record-' + provider, async () => {
      await seed('dodo', 'booked', dodoBooking());
      const { _id, _rev, ...canonical } = (await row(bookingId)).payload;
      await commerce.create({ ...canonical, _id: 'booking.extra' });
      if (provider === 'missing') dodoPayment.metadata = {};
      else await commerce.patch(recordId).set({ provider }).commit();
      const keys = ['payment:payment-fixture', 'booking:' + bookingId, 'booking:booking.extra'];
      const report = await targetReport(keys);
      dodoList = [dodoSummary()];
      const window = await authorizedReport('GET', true);
      const proof = { report, window };
      assert.deepEqual(report.body.items.map((item) => item.key), keys, JSON.stringify(proof));
      assertTarget(report, keys, Array(3).fill('unresolved'), Array(3).fill('payment_without_record'));
      assert.deepEqual(window.body.items.map((item) => item.key).sort(), [...keys].sort());
      return proof;
    });
  }
  await run('reconcile-report-target-owner-recovery', async () => {
    const old = new Date(Date.now() - 73 * 3600000).toISOString();
    await seed('dodo', 'needs_recovery', dodoBooking({ _createdAt: old, netAmount: 19.99 }, {
      updatedAt: old,
      providerRecoveryTerminal: true,
      providerRecoveryTerminalReason: 'dodo_currency_mismatch',
    }));
    dodoPayment.created_at = old;
    const window = await authorizedReport('GET', true);
    assert.equal(window.body.count, 0);
    const keys = ['record:' + recordId, 'payment:payment-fixture'];
    const owner = await targetReport(keys);
    assertTarget(owner, keys, ['unresolved', 'unresolved'], Array(2).fill('owner_review_dodo_currency_mismatch'));
    assert.deepEqual(owner.body.items.map((item) => item.key), keys);
    await commerce.patch(recordId).set({ providerRecoveryTerminal: false, status: 'booked' }).commit();
    const stillBroken = await targetReport(keys);
    assertTarget(stillBroken, keys, ['unresolved', 'unresolved'], ['amount_mismatch']);
    assert.equal(stillBroken.body.items[0].key, 'payment:payment-fixture');
    await commerce.patch(bookingId).set({ netAmount: 9.99 }).commit();
    const repaired = await targetReport(keys);
    assertTarget(repaired, keys, ['recovered', 'recovered'], []);
    return { old, window, owner, stillBroken, repaired };
  });
  for (const variant of [
    { name: 'partial', booking: { refundedAmount: 3.33, refundStatus: 'partial', commissionAmount: 0.67 }, repair: { dodoOriginalCommissionAmount: 1 }, reason: 'commission_mismatch' },
    { name: 'full', booking: { refundedAmount: 3.33, refundStatus: 'partial', commissionAmount: 1 }, repair: { status: 'refunded', refundedAmount: 9.99, refundStatus: 'full' }, reason: 'refund_not_applied' },
    { name: 'active', booking: { status: 'pending', dodoDisputeActive: false, commissionAmount: 0 }, repair: { dodoDisputeActive: true }, reason: 'dispute_not_applied' },
    { name: 'resolved', booking: { dodoDisputeActive: true }, repair: { dodoDisputeActive: false }, reason: 'dispute_not_applied' },
  ]) {
    await run('reconcile-report-target-' + variant.name + '-recovery', async () => {
      await seed('dodo', variant.name === 'full' ? 'refunded' : 'booked', dodoBooking(variant.booking));
      if (variant.name === 'partial' || variant.name === 'full') {
        dodoPayment.refund_status = variant.name;
        dodoPayment.refunds = [{ ...dodoRefund, amount: variant.name === 'partial' ? 333 : 999, is_partial: variant.name === 'partial' }];
      } else {
        dodoPayment.disputes = [dodoDispute(variant.name === 'active' ? 'dispute_opened' : 'dispute_won')];
      }
      const report = await targetReport(canonicalKeys);
      assertTarget(report, canonicalKeys, Array(3).fill('unresolved'), [variant.reason]);
      await commerce.patch(bookingId).set(variant.repair).commit();
      const control = await targetReport(canonicalKeys);
      assertTarget(control, canonicalKeys, Array(3).fill('recovered'), []);
      assert.equal(report.providerRequests.length, 1);
      assert.equal(control.providerRequests.length, 1);
      return { provider: dodoPayment, report, control };
    });
  }
  for (const variant of [
    { name: 'frozen', record: { pricingSnapshot: { netAmount: null } }, reason: 'frozen_pricing_unavailable' },
    { name: 'commission', booking: { commissionAmount: 0.5 }, reason: 'commission_mismatch' },
    { name: 'recipient', booking: { referralCode: ' creator-correct ' }, reason: 'referral_binding_mismatch' },
    { name: 'original', booking: { dodoOriginalCommissionAmount: 0 }, reason: 'commission_mismatch' },
    { name: 'currency', booking: { currency: 'EUR' }, reason: 'amount_mismatch' },
    { name: 'product', productId: 'pdt_unrelated', reason: 'dodo_product_mismatch' },
  ]) {
    await run('reconcile-report-target-audit-' + variant.name, async () => {
      await seed('dodo', 'booked', dodoBooking(variant.booking, variant.record));
      if (variant.productId) dodoPayment.product_cart[0].product_id = variant.productId;
      const report = await targetReport(canonicalKeys);
      assertTarget(report, canonicalKeys, Array(3).fill('unresolved'), [variant.reason]);
      return report;
    });
  }
  await run('reconcile-report-target-refund-cache', async () => {
    await seed('dodo', 'booked', dodoBooking({
      refundedAmount: 2.5, refundStatus: 'partial', commissionAmount: 0.75, dodoOriginalCommissionAmount: 1,
    }));
    dodoPayment.refund_status = 'partial';
    dodoRefund = { ...dodoRefund, amount: 250, is_partial: true };
    dodoPayment.refunds = [{ ...dodoRefund, amount: null, currency: null }];
    const report = await targetReport(canonicalKeys);
    assertTarget(report, canonicalKeys, Array(3).fill('recovered'), []);
    assert.deepEqual(report.providerRequests.map((request) => request.path), ['/payments/payment-fixture', '/refunds/refund-fixture']);
    return { provider: dodoPayment, report };
  });
  await run('reconcile-report-target-query-validation', async () => {
    const keys = Array.from({ length: 20 }, (_, index) => 'record:paymentRecord.missing-' + index);
    const boundary = await authorizedReport('GET', true, { check: JSON.stringify(keys).padEnd(2048, ' ') });
    assertTarget(boundary, keys, Array(20).fill('unknown'), []);
    assert.deepEqual(boundary.providerRequests, []);
    const two = await targetReport(keys.slice(0, 2));
    assertTarget(two, keys.slice(0, 2), ['unknown', 'unknown'], []);
    const strict = await targetReport(['record:' + 'x'.repeat(80), 'record:Case._:/-']);
    assertTarget(strict, ['record:' + 'x'.repeat(80), 'record:Case._:/-'], ['unknown', 'unknown'], []);
    const invalid = [];
    for (const check of [
      '', '{', 'null', '{}', '"payment:payment-fixture"', '1', '[]',
      JSON.stringify([...keys, 'record:paymentRecord.too-many']),
      JSON.stringify([keys[0], keys[0]]),
      JSON.stringify([null]), JSON.stringify([1]), JSON.stringify([{}]),
      JSON.stringify(['scan:dodo-payments']), JSON.stringify(['payment:']),
      JSON.stringify(['paymentX']), JSON.stringify(['bookingX']), JSON.stringify(['recordX']), JSON.stringify([':x']),
      JSON.stringify(['payment: payment-fixture']), JSON.stringify(['payment:payment-fixture ']),
      JSON.stringify(['payment:customer@example.invalid']), JSON.stringify(['payment:' + 'x'.repeat(81)]),
      JSON.stringify(keys).padEnd(2049, ' '),
    ]) {
      const result = await authorizedReport('GET', true, { check });
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.equal(result.body.code, 'reconcile_report_checks_invalid');
      assert.equal(result.headers['cache-control'], 'private, no-store');
      assert.deepEqual(result.providerRequests, []);
      assert.deepEqual(result.databaseRequests, []);
      invalid.push({ check, ...result });
    }
    const directArray = await authorizedReport('GET', false, { check: [JSON.stringify(keys.slice(0, 2))] });
    assert.equal(directArray.status, 400);
    assert.equal(directArray.body.code, 'reconcile_report_checks_invalid');
    assert.deepEqual(directArray.databaseRequests, []);
    assert.deepEqual(directArray.providerRequests, []);
    const repeated = await authorizedReport('GET', true, { check: ['["payment:payment-fixture"]', '["booking:booking.fixture"]'] });
    assert.equal(repeated.status, 400);
    assert.equal(repeated.body.code, 'duplicate_query');
    assert.deepEqual(repeated.databaseRequests, []);
    assert.deepEqual(repeated.providerRequests, []);
    const internal = [];
    for (const checks of [null, {}, 'payment:payment-fixture', [keys[0], keys[0]], [...keys, 'record:paymentRecord.too-many'], ['paymentX'], ['bookingX'], ['recordX'], [':x']]) {
      const result = await readReport({ checks });
      assert.equal(result.status, 500);
      assert.equal(result.body.fixtureError, 'reconcile_report_checks_invalid');
      assert.deepEqual(result.databaseRequests, []);
      assert.deepEqual(result.providerRequests, []);
      internal.push(result);
    }
    return { boundary, two, strict, invalid, directArray, repeated, internal };
  });
  await run('reconcile-report-target-key-separator', async () => {
    const results = [];
    for (const key of ['paymentX', 'bookingX', 'recordX', ':x']) {
      const publicResult = await authorizedReport('GET', true, { check: JSON.stringify([key]) });
      assert.equal(publicResult.status, 400, JSON.stringify({ key, publicResult }));
      assert.equal(publicResult.body.code, 'reconcile_report_checks_invalid');
      assert.deepEqual(publicResult.providerRequests, []);
      assert.deepEqual(publicResult.databaseRequests, []);
      const internalResult = await readReport({ checks: [key] });
      assert.equal(internalResult.status, 500, JSON.stringify({ key, internalResult }));
      assert.equal(internalResult.body.fixtureError, 'reconcile_report_checks_invalid');
      assert.deepEqual(internalResult.providerRequests, []);
      assert.deepEqual(internalResult.databaseRequests, []);
      results.push({ key, publicResult, internalResult });
    }
    return results;
  });
  await run('reconcile-report-canonical-identity-boundary', async () => {
    const longId = 'booking.' + 'x'.repeat(74);
    const repairedId = 'booking.' + 'y'.repeat(72);
    assert.equal(longId.length, 82);
    assert.equal(repairedId.length, 80);
    await seed('dodo', 'booked', dodoBooking());
    const { _id, _rev, ...canonical } = (await row(bookingId)).payload;
    await commerce.create({ ...canonical, _id: longId });
    await commerce.patch(recordId).set({ bookingId: longId }).commit();
    await commerce.delete(bookingId);
    const sourceBooking = await row(longId);
    const sourceRecord = await record();
    const nativeBookings = await sql`select b.legacy_sanity_id,b.payment_record_id,b.booking_payload,s.tombstoned from commerce.bookings b join migration.source_documents s on s.legacy_sanity_id=b.legacy_sanity_id order by b.legacy_sanity_id`;
    const nativeRecords = await sql`select id,legacy_sanity_id from commerce.payment_records order by legacy_sanity_id`;
    assert.equal(sourceBooking.tombstoned, false);
    assert.equal(sourceBooking.payload._id, longId);
    assert.equal(sourceRecord.bookingId, longId);
    assert.equal((await row(bookingId)).tombstoned, true);
    const activeBookings = nativeBookings.filter((booking) => !booking.tombstoned);
    assert.equal(activeBookings.length, 1);
    assert.equal(nativeRecords.length, 1);
    assert.equal(activeBookings[0].legacy_sanity_id, longId);
    assert.equal(activeBookings[0].payment_record_id, nativeRecords[0].id);
    assert.equal(nativeRecords[0].legacy_sanity_id, recordId);
    assert.equal(activeBookings[0].booking_payload.paymentRecordId, recordId);
    dodoPayment.created_at = new Date(Date.now() - 3600000).toISOString();
    dodoList = [dodoSummary()];
    const window = await authorizedReport('GET', true);
    const target = await targetReport(['payment:payment-fixture']);
    const { _id: unsafeId, _rev: unsafeRevision, ...unchangedBooking } = sourceBooking.payload;
    await commerce.create({ ...unchangedBooking, _id: repairedId });
    await commerce.patch(recordId).set({ bookingId: repairedId }).commit();
    await commerce.delete(longId);
    const repairedWindow = await authorizedReport('GET', true);
    const repairedTarget = await targetReport(['payment:payment-fixture']);
    const proof = {
      nativeIdentityAccepted: true, longId, repairedId, sourceBooking, sourceRecord,
      nativeBookings, activeBookings, nativeRecords, provider: dodoPayment, window, target, repairedWindow, repairedTarget,
    };
    assert.equal(window.body.count, 1, JSON.stringify(proof));
    assert.equal(window.status, 200);
    assert.deepEqual(window.body.items, [{
      key: 'scan:identity-invalid', id: 'payment-fixture', ref: '',
      amount: '9.99', currency: 'USD', reason: 'report_identity_invalid',
    }]);
    assert.deepEqual(window.body.complete, { payments: true, bookings: true, records: true, items: true });
    assert.equal(target.status, 200);
    assert.equal(target.body.count, 1);
    assert.equal(target.body.checks[0].state, 'unresolved');
    assert.deepEqual(target.body.checks[0].keys, ['payment:payment-fixture', 'scan:identity-invalid']);
    assert.deepEqual(target.body.items, window.body.items);
    assert.deepEqual(target.body.checks[0].items, window.body.items);
    for (const result of [window, target]) assert.equal(JSON.stringify(result.body).includes(longId), false);
    assert.equal(repairedWindow.status, 200);
    assert.equal(repairedWindow.body.count, 0);
    assert.deepEqual(repairedWindow.body.items, []);
    assert.equal(repairedTarget.status, 200);
    assert.equal(repairedTarget.body.count, 0);
    assert.deepEqual(repairedTarget.body.checks, [{
      key: 'payment:payment-fixture', state: 'recovered',
      keys: ['payment:payment-fixture', 'record:' + recordId, 'booking:' + repairedId], items: [],
    }]);
    return proof;
  });
  await run('reconcile-report-target-auth-before-json', async () => {
    const saved = process.env.RECONCILE_REPORT_TOKEN;
    const results = {};
    try {
      delete process.env.RECONCILE_REPORT_TOKEN;
      results.unset = await reportRoute({ authorization: 'Bearer wrong' }, 'GET', true, { check: '{' });
      assert.equal(results.unset.status, 404);
      process.env.RECONCILE_REPORT_TOKEN = 'x'.repeat(40);
      results.wrong = await reportRoute({ authorization: 'Bearer wrong' }, 'GET', true, { check: '{' });
      assert.equal(results.wrong.status, 403);
      results.repeated = await reportRoute({ authorization: 'Bearer wrong' }, 'GET', true, { check: ['[]', '[]'] });
      assert.equal(results.repeated.status, 400);
      assert.equal(results.repeated.body.code, 'duplicate_query');
      for (const method of ['POST', 'HEAD']) {
        const result = await authorizedReport(method, true, { check: '{' });
        assert.equal(result.status, 405);
        assert.equal(result.headers.allow, 'GET');
        results[method] = result;
      }
      for (const result of Object.values(results)) {
        assert.deepEqual(result.providerRequests, []);
        assert.deepEqual(result.databaseRequests, []);
        assert.equal(result.headers['cache-control'], 'private, no-store');
      }
      return results;
    } finally {
      if (saved === undefined) delete process.env.RECONCILE_REPORT_TOKEN;
      else process.env.RECONCILE_REPORT_TOKEN = saved;
    }
  });
  for (const dependency of ['provider', 'database']) {
    await run('reconcile-report-target-last-' + dependency + '-unavailable', async () => {
      await seed('dodo', 'booked', dodoBooking());
      let failed = false;
      if (dependency === 'provider') {
        providerHook = (request, req, res) => {
          if (request.path !== '/payments/payment-unavailable') return;
          failed = true;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'fixture_payment_unavailable' }));
          return true;
        };
      } else {
        fixture.setRequestHook((phase, request) => {
          if (phase !== 'before' || !request.body?.p_ids?.includes('paymentRecord.unavailable')) return;
          failed = true;
          throw new Error('fixture_database_unavailable');
        });
      }
      const report = await targetReport(['payment:payment-fixture', dependency === 'provider' ? 'payment:payment-unavailable' : 'record:paymentRecord.unavailable']);
      assert.equal(failed, true);
      assert.equal(report.status, 503, JSON.stringify(report.body));
      assert.equal(report.body.code, 'reconcile_report_unavailable');
      for (const field of ['checks', 'items', 'count']) assert.equal(Object.hasOwn(report.body, field), false);
      assert.equal(report.providerRequests.filter((request) => request.path === '/payments/payment-fixture').length, 1);
      assert.equal(report.providerRequests.some((request) => request.path.startsWith('/payments?')), false);
      return report;
    });
  }
  await run('reconcile-report-item-cap-completeness', async () => {
    dodoList = Array.from({ length: 51 }, (_, index) => ({ ...dodoSummary(), payment_id: 'payment-cap-' + index }));
    providerHook = (request, req, res) => {
      if (!request.path.startsWith('/payments/payment-cap-')) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...dodoPayment, payment_id: request.path.slice('/payments/'.length), metadata: {} }));
      return true;
    };
    const report = await authorizedReport('GET', true);
    assert.equal(report.status, 200);
    assert.equal(report.body.count, 51);
    assert.equal(report.body.items.length, 50);
    assert.deepEqual(report.body.complete, { payments: true, bookings: true, records: true, items: false });
    assert.ok(report.body.items.every((item) => item.key === 'payment:' + item.id));
    return report;
  });
  for (const mode of ['provider', 'reconciliation', 'both', 'mixed']) await run('reconcile-report-terminal-cap-completeness' + (mode === 'provider' ? '' : '-' + mode), async () => {
    let transaction = commerce.transaction();
    for (let index = 0; index < 201; index += 1) {
      transaction.create({
        _type: 'paymentRecord', _id: 'paymentRecord.cap-' + index, provider: 'dodo',
        status: 'needs_recovery',
        providerRecoveryTerminal: mode === 'provider' || mode === 'both' || (mode === 'mixed' && index % 2 === 0),
        reconciliationRecoveryTerminal: mode === 'reconciliation' || mode === 'both' || (mode === 'mixed' && index % 2 !== 0),
        recoveryReason: 'create_booking_failed',
        ...(mode === 'reconciliation' ? {} : { providerRecoveryTerminalReason: 'dodo_currency_mismatch' }),
        updatedAt: new Date().toISOString(), pricingSnapshot: { netAmount: 9.99 },
        backendOwner: 'supabase', cutoverGeneration: 0,
      });
      if ((index + 1) % 100 === 0) {
        await transaction.commit();
        transaction = commerce.transaction();
      }
    }
    await transaction.commit();
    const report = await authorizedReport('GET', true);
    assert.equal(report.status, 200);
    assert.equal(report.body.count, 201);
    assert.equal(report.body.items.length, 50);
    assert.equal(report.body.items[0].key, 'scan:dodo-records');
    assert.deepEqual(report.body.complete, { payments: true, bookings: true, records: false, items: false });
    assert.ok(report.body.items.slice(1).every((item) => item.key === 'record:' + item.ref));
    return report;
  });
  await run('reconcile-report-unsafe-identity-key', async () => {
    dodoPayment.payment_id = 'payment unsafe';
    dodoPayment.metadata = {};
    dodoList = [dodoSummary()];
    providerHook = (request, req, res) => {
      if (decodeURIComponent(request.path) !== '/payments/payment unsafe') return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(dodoPayment));
      return true;
    };
    const report = await authorizedReport('GET', true);
    assert.equal(report.status, 200);
    assert.equal(report.body.count, 1);
    assert.equal(report.body.items[0].key, 'scan:identity-invalid');
    assert.equal(report.body.items[0].id, 'paymentunsafe');
    assert.equal(report.body.items[0].reason, 'payment_without_record');
    return report;
  });
  for(const revisionState of ['absent','null'])await run(`missing-payment-authorizing-revision${revisionState==='null'?'-null':''}`,async()=>{
    await seed('paypal','started',{record:{bookingId:''}});await removeRevision(recordId,revisionState);let raced=false,reads=0,before;
    fixture.setRequestHook(async(phase,request)=>{if(phase!=='after'||raced||!request.response)return;const raw=JSON.stringify(request.response);if(!raw.includes(recordId)||!raw.includes('pricingSnapshot')||++reads!==2)return;raced=true;fixture.setRequestHook(null);const current=await record();await commerce.patch(recordId).set({status:'finalizing',finalizationLeaseId:'newer-owner',finalizationLeaseExpiresAt:new Date(originalNow()+120000).toISOString()}).commit();before=await snapshot({receipts:true});});
    const result=await requestFlow('finalize',{paymentAccessToken:tokenFor({_id:recordId,provider:'paypal',pricingFingerprint:'fixture-pricing'}),body:{paypalOrderId:'order-fixture'}});assert.equal(raced,true);assert.deepEqual(await snapshot({receipts:true}),before);assert.equal((await record()).finalizationLeaseId,'newer-owner');assert.equal(providerRequests.filter(x=>x.path.includes('/checkout/orders/')).length,0);assert.ok(result.status>=400||result.status===202);return{status:result.status,revisionState,fullSnapshotUnchanged:true,snapshotAfterConcurrentWriter:before,snapshotAfterObsoleteFinalize:await snapshot({receipts:true}),newerOwnerRetained:true,providerVerificationRequests:0};
  });
  const startInput=async()=>{
    const packageTitle='Fixture Payment';
    for(const doc of [{_id:'package.payment-integration',_type:'package',title:packageTitle,price:'$9.99'},{_id:'6d8a3646-0ed2-44b5-ad45-c5c9d578126a',_type:'bookingSettings',dateSlots:[{date:'2099-01-01',times:['15:30']}]}]){
      const current=await documents.fetch('*[_id == $id][0]',{id:doc._id});if(current)await documents.patch(doc._id).ifRevisionId(current._rev).set(doc).commit();else await documents.create(doc);
    }
    const expiresAt=new Date(originalNow()+1800000).toISOString();
    const hold={_id:'slotHold.fixture',_type:'slotHold',backendOwner:'supabase',cutoverGeneration:0,startTimeUTC:'2099-01-01T10:00:00.000Z',packageTitle,phase:'holding',holdNonce:'fixture-hold-owner',expiresAt};await commerce.create(hold);
    const {issueHoldToken}=await import('../src/server/booking/holdToken.js');
    const bookingPayload={packageTitle,email:'customer@example.invalid',discord:'fixture',specs:'synthetic computer',mainGame:'fixture game',localTimeZone:'Asia/Kolkata',startTimeUTC:hold.startTimeUTC,slotHoldId:hold._id,slotHoldToken:issueHoldToken({holdId:hold._id,startTimeUTC:hold.startTimeUTC,expiresAt,holdNonce:hold.holdNonce,backend:'supabase',cutoverGeneration:0})};
    const {resolvePaymentQuote}=await import('../src/server/api/ref/pricing.js');const quote=await resolvePaymentQuote({packageTitle,client:commerce});const {buildQuoteFingerprint}=await import('../src/server/api/payment/paymentRecord.js');return{provider:'paypal',bookingPayload,quoteFingerprint:buildQuoteFingerprint({bookingPayload,quote})};
  };
  const a1Start=async(provider='paypal',variant='normal')=>{
    fixture.setRequestHook(async(phase,request)=>{if(phase==='after'&&(request.status>=400||request.response?.ok===false||request.response?.error)){evidence.databaseErrors||=[];evidence.databaseErrors.push({scenario:scenarioNumber,response:request.response});}});
    const input=await startInput();input.provider=provider;input.bookingPayload.message='Original note';emailFailure=variant==='email-failure';
    if (variant === 'upgrade') {
      const original = { ...input.bookingPayload, _id: 'booking.original', _type: 'booking',
        backendOwner: 'supabase', cutoverGeneration: 0, status: 'captured',
        packagePrice: '$9.99', grossAmount: 9.99, netAmount: 9.99, paymentProvider: 'paypal',
        paypalOrderId: 'order-original', startTimeUTC: '2099-02-01T00:30:00.000Z', localTimeZone: 'Pacific/Honolulu' };
      delete original.slotHoldId;
      delete original.slotHoldToken;
      await commerce.create(original);
      const target = { _id: 'package.fixture-upgrade', _type: 'package', title: 'Fixture Upgrade', price: '$19.98' };
      const existing = await documents.getDocument(target._id);
      if (existing) await documents.patch(target._id).set(target).commit();
      else await documents.create(target);
      const { issueUpgradeIntentToken } = await import('../src/server/api/ref/upgradeIntentToken.js');
      input.bookingPayload = { originalOrderId: original._id, packageTitle: target.title, email: original.email,
        upgradeIntentToken: issueUpgradeIntentToken({ bookingId: original._id, email: original.email, targetPackageTitle: target.title, backend: 'supabase', cutoverGeneration: 0 }) };
    }
    if(variant==='referral'){
      const referral={_id:'referral.a1',_type:'referral',slug:{_type:'slug',current:'fixture'},registrationStatus:'verified',currentDiscountPercent:0,currentCommissionPercent:10,totalSales:0,totalEarnings:0,backendOwner:'supabase',cutoverGeneration:0};
      const current=await documents.getDocument(referral._id);if(current)await documents.patch(referral._id).ifRevisionId(current._rev).set(referral).commit();else await documents.create(referral);
      input.bookingPayload.referralCode='FIXTURE';
    }
    if (variant === 'blank-referral') input.bookingPayload.referralCode = ' \t ';
    if (variant === 'unknown-referral') input.bookingPayload.referralCode = ' NOT-A-CREATOR ';
    if(variant==='coupon'||provider==='free'){
      const code=`A1${scenarioNumber}`,percent=provider==='free'?100:10;
      await commerce.create({_id:`coupon.a1.${scenarioNumber}`,_type:'coupon',code,isActive:true,discountType:'percent',discountPercent:percent,canCombineWithReferral:true,timesUsed:0,activeReservations:0,maxUses:0,backendOwner:'supabase',cutoverGeneration:0});input.bookingPayload.couponCode=code;
    }
    const {resolvePaymentQuote}=await import('../src/server/api/ref/pricing.js');
    const quote=await resolvePaymentQuote({...input.bookingPayload,client:commerce});
    const {buildQuoteFingerprint}=await import('../src/server/api/payment/paymentRecord.js');input.quoteFingerprint=buildQuoteFingerprint({bookingPayload:input.bookingPayload,quote});
    const amount=providers.toSubunits(quote.effectiveNetAmount,'USD'),value=Number(quote.effectiveNetAmount).toFixed(2);
    providerHook=async(request,req,res)=>{
      let body;
      if(provider==='razorpay'&&request.path.startsWith('/v1/orders?'))body={items:[]};
      else if(request.method==='POST'&&request.path===(provider==='paypal'?'/v2/checkout/orders':'/v1/orders'))body=provider==='paypal'?{id:'order-fixture',status:'CREATED'}:{id:'order-fixture',currency:'USD',amount,receipt:request.body.receipt,status:'created'};
      else if(provider==='dodo'&&request.method==='GET'&&request.path==='/products/pdt_fixture')body={product_id:'pdt_fixture',is_recurring:false,price:{type:'one_time_price',currency:'USD',pay_what_you_want:true,tax_inclusive:false,purchasing_power_parity:false,discount:0,price:0}};
      else if(provider==='dodo'&&request.method==='POST'&&request.path==='/checkouts')body={session_id:'order-fixture',checkout_url:'https://test.checkout.dodopayments.com/session/fixture'};
      else return false;
      res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(body));return true;
    };
    paypalOrder.status='CREATED';paypalOrder.purchase_units[0].amount={value,currency_code:'USD'};paypalOrder.purchase_units[0].payments={captures:[]};
    const browserResponse = variant === 'browser' ? await fetch(`${origin}/start-route`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) : null;
    const started = browserResponse ? { status: browserResponse.status, body: await browserResponse.json(), cacheControl: browserResponse.headers.get('cache-control') } : await requestFlow('start', { body: input });
    assert.equal(started.status,200,JSON.stringify(started));
    const [payment]=await commerce.fetch('*[_type == "paymentRecord"]');assert.ok(payment?._id);
    paypalOrder.status='COMPLETED';paypalOrder.purchase_units[0].payments={captures:[{id:'capture-fixture',status:'COMPLETED',amount:{value,currency_code:'USD'}}]};
    razorpayPayment.amount=amount;dodoPayment.metadata={paymentRecordId:payment._id};dodoPayment.total_amount=amount;
    const proof=provider==='paypal'?{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}:provider==='razorpay'?{razorpayOrderId:'order-fixture',razorpayPaymentId:'payment-fixture',razorpaySignature:crypto.createHmac('sha256','fixture-secret').update('order-fixture|payment-fixture').digest('hex')}:{};
    return{input,quote,started,id:payment._id,proof};
  };
  const a1Hook=async provider=>requestFlow(provider,{req:provider==='paypal'?paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}}):provider==='razorpay'?razorReq('payment.captured',{payment:{entity:razorpayPayment}}):dodoReq()});
  await run('recovery-report-exhausted-finalize-outside-provider-cap', async () => {
    const checkout = await a1Start('dodo');
    await sql.unsafe(`create or replace function public.payment_capture_failure_fixture() returns trigger language plpgsql as $$
      begin
        if new.document_type = 'booking' then raise exception 'Synthetic booking storage failure'; end if;
        return new;
      end $$;
      create trigger payment_capture_failure_fixture before insert or update on migration.source_documents
      for each row execute function public.payment_capture_failure_fixture();`);
    const attempts = [];
    let exhausted;
    try {
      await a1Hook('dodo');
      for (let index = 0; index < 12; index += 1) {
        const current = (await row(checkout.id)).payload;
        attempts.push(current.recoveryFailureCount);
        if (current.recoveryFailureCount === 12) { exhausted = current; break; }
        const when = new originalDate(current.nextRecoveryAt).getTime() + 1;
        globalThis.Date = class extends originalDate {
          constructor(...args) { super(...(args.length ? args : [when])); }
          static now() { return when; }
        };
        const retried = await requestFlow('reconcile');
        assert.ok(retried.body.summary, JSON.stringify(retried));
        assert.equal(retried.body.summary.scanned, 1, JSON.stringify(retried));
        assert.equal(retried.body.summary.providerUnavailable, 0);
        assert.equal(retried.status, retried.body.summary.failed ? 503 : 200, JSON.stringify(retried));
      }
    } finally {
      await sql.unsafe('drop trigger payment_capture_failure_fixture on migration.source_documents');
    }
    assert.equal(attempts[0], 1);
    assert.equal(attempts.at(-1), 12);
    assert.ok(attempts.every((count, index) => index === 0 || count > attempts[index - 1]));
    assert.equal(exhausted.status, 'needs_recovery');
    assert.equal(exhausted.reconciliationRecoveryTerminal, true);
    assert.notEqual(exhausted.providerRecoveryTerminal, true);
    assert.equal(exhausted.bookingId, '');
    const foreign = { ...dodoPayment, payment_id: 'payment-foreign-history', metadata: {},
      product_cart: [{ product_id: 'pdt_other_site', quantity: 1 }] };
    dodoList = Array.from({ length: 2000 }, () => dodoSummary(foreign));
    providerHook = (request, req, res) => {
      let body;
      if (request.path.startsWith('/payments?')) {
        const page = Number(new URL(request.path, origin).searchParams.get('page_number'));
        body = { items: dodoList.slice(page * 100, (page + 1) * 100) };
      } else if (request.path === '/payments/payment-foreign-history') body = foreign;
      else return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return true;
    };
    const window = await authorizedReport('GET', true);
    assert.equal(window.status, 200, JSON.stringify(window.body));
    assert.deepEqual(reportReasons(window.body), ['report_truncated', 'owner_review_unknown'], JSON.stringify(window.body));
    assert.equal(window.body.items[1].key, `record:${checkout.id}`);
    assert.equal(window.body.complete.payments, false);
    assert.equal(window.body.complete.records, true);
    const keys = [`record:${checkout.id}`, 'payment:payment-fixture'];
    const targeted = await targetReport(keys);
    assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
    assert.deepEqual(targeted.body.checks.map(check => check.state), ['unresolved', 'unresolved']);
    assert.ok(targeted.body.items.every(item => item.reason === 'owner_review_unknown'));
    assert.equal((await requestFlow('reconcile')).body.summary.scanned, 0);
    await commerce.patch(checkout.id).set({ reconciliationRecoveryTerminal: false, nextRecoveryAt: '' }).commit();
    assert.equal((await requestFlow('reconcile')).status, 200);
    const repaired = (await row(checkout.id)).payload;
    assert.ok(repaired.bookingId, JSON.stringify(repaired));
    const recovered = await targetReport(keys);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.deepEqual(recovered.body.checks.map(check => check.state), ['recovered', 'recovered']);
    return { attempts, exhausted, window, targeted, repaired, recovered,
      repairStandIn: 'Fixture operator clears terminal after the actual database failure is removed; cron commits the booking.' };
  });
  for (const variant of ['blank-referral', 'unknown-referral', 'referral']) for (const via of ['webhook', 'cron']) {
    await run(`recovery-reschedule-${variant}-${via}`, async () => {
      const checkout = await a1Start('dodo', variant);
      const expectedCode = variant === 'blank-referral' ? '' : variant === 'referral' ? 'fixture' : 'not-a-creator';
      const started = (await row(checkout.id)).payload;
      assert.equal(started.bookingPayload.referralCode, String(checkout.input.bookingPayload.referralCode).trim());
      assert.equal(started.pricingSnapshot.effectiveReferralCode, expectedCode);
      assert.equal(started.pricingSnapshot.effectiveReferralId, variant === 'referral' ? 'referral.a1' : '');
      await commerce.patch(checkout.id).ifRevisionId(started._rev).set({
        status: 'abandoned', providerPaymentId: dodoPayment.payment_id,
        lateCaptureWatchUntil: new Date(originalNow() + 3600000).toISOString(),
        nextRecoveryAt: '',
      }).commit();
      const recovered = via === 'webhook' ? await a1Hook('dodo') : await requestFlow('reconcile');
      assert.equal(recovered.status, 200, JSON.stringify(recovered));
      const saved = (await row(checkout.id)).payload;
      const booking = (await row(saved.bookingId)).payload;
      assert.equal(saved.status, 'booked', JSON.stringify(saved));
      assert.equal(booking.requiresReschedule, true);
      assert.equal(booking.referralCode, expectedCode);
      assert.equal(booking.referral?._ref || '', started.pricingSnapshot.effectiveReferralId);
      assert.equal(booking.commissionAmount, started.pricingSnapshot.commissionAmount);
      assert.equal(booking.commissionPercent, started.pricingSnapshot.commissionPercent);
      assert.equal(saved.referralAccountingApplied, variant === 'referral');
      dodoPayment.created_at = new Date(originalNow() - 3600000).toISOString();
      dodoList = [dodoSummary()];
      const window = await authorizedReport('GET', true);
      const keys = ['payment:payment-fixture', `record:${saved._id}`, `booking:${booking._id}`];
      const targeted = await targetReport(keys);
      const reasons = variant === 'unknown-referral' ? ['frozen_pricing_unavailable'] : [];
      assert.equal(window.status, 200, JSON.stringify(window.body));
      assert.deepEqual(reportReasons(window.body), reasons, JSON.stringify(window.body));
      assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
      assert.deepEqual(reportReasons(targeted.body), reasons);
      assert.deepEqual(targeted.body.checks.map(check => check.state), keys.map(() => reasons.length ? 'unresolved' : 'recovered'));
      const earnings = await commerce.referralEarnings({ referralId: 'referral.a1', referralCode: 'fixture' });
      assert.equal(earnings.total, variant === 'referral' ? started.pricingSnapshot.commissionAmount : 0);
      assert.equal((await a1Hook('dodo')).status, 200);
      const afterHook = await snapshot({ receipts: true });
      assert.equal((await requestFlow('reconcile')).status, 200);
      assert.deepEqual(await snapshot({ receipts: true }), afterHook);
      assert.deepEqual((await row(saved.bookingId)).payload, booking);
      assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count, 1);
      assert.deepEqual(await commerce.referralEarnings({ referralId: 'referral.a1', referralCode: 'fixture' }), earnings);
      return { variant, via, started, recovered, saved, booking, window, targeted, earnings,
        afterHook, bookingAndCreditUnchangedOnRetry: true };
    });
  }
  for (const mode of ['complete', 'partial', 'missing-details']) await run(`recovery-reschedule-created-${mode}`, async () => {
    const checkout = await a1Start();
    const missing = mode === 'missing-details';
    await commerce.patch(checkout.id).set({
      status: 'abandoned', verificationState: 'server_verified',
      recoveryAttemptCount: 11, recoveryFailureCount: 11, reconciliationRecoveryTerminal: true,
      providerRefundDetailsMissing: missing, nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    }).commit();
    emailFailure = mode === 'partial';
    const result = await a1Hook('paypal');
    const saved = (await row(checkout.id)).payload;
    assert.equal(saved.requiresReschedule, true, JSON.stringify({ result, saved }));
    assert.ok(saved.bookingId);
    assert.equal(saved.status, mode === 'partial' ? 'email_partial' : 'booked');
    assert.equal(saved.recoveryFailureCount, 0);
    assert.equal(saved.reconciliationRecoveryTerminal, missing);
    return { mode, result, saved, actualRescheduleBookingAndEmail: true };
  });
  for (const kind of ['reschedule', 'dodo-email', 'normalized-email']) for (const missing of [false, true]) {
    await run(`recovery-completed-${kind}-${missing ? 'missing-details' : 'clear'}`, async () => {
      const reschedule = kind === 'reschedule';
      const normalized = kind === 'normalized-email';
      await seed(kind === 'dodo-email' ? 'dodo' : 'paypal', normalized ? 'booked' : 'email_partial', {
        booking: {
          paymentRecordId: recordId,
          recoveryClientNotifiedAt: '2026-01-01T00:00:00.000Z', recoveryOwnerNotifiedAt: '2026-01-01T00:00:00.000Z',
          emailDispatchClientSentAt: '2026-01-01T00:00:00.000Z', emailDispatchOwnerSentAt: '2026-01-01T00:00:00.000Z',
        },
        record: {
          requiresReschedule: reschedule, recoveryNotificationRequired: reschedule,
          emailDispatchRequired: !reschedule, emailDispatch: { allSent: normalized },
          recoveryAttemptCount: 11, recoveryFailureCount: 11, reconciliationRecoveryTerminal: false,
          providerRefundDetailsMissing: missing, nextRecoveryAt: '',
        },
      });
      const result = await requestFlow('reconcile');
      const saved = await record();
      assert.equal(saved.status, 'booked', JSON.stringify({ result, saved }));
      assert.equal(saved.recoveryFailureCount, 0);
      assert.equal(saved.reconciliationRecoveryTerminal, missing);
      let failedRefund;
      if (reschedule && !missing) {
        await commerce.patch(recordId).set({ status: 'refunded', refundState: 'full', refundRequiresBookingSync: true,
          refundProcessedAmountInSubunits: 999, refundCurrency: 'USD', nextRecoveryAt: '' }).commit();
        await sql.unsafe(`create or replace function public.payment_notification_failure_fixture() returns trigger language plpgsql as $$
          begin
            if new.legacy_sanity_id = 'booking.fixture' then raise exception 'Synthetic refund storage failure'; end if;
            return new;
          end $$;
          create trigger payment_notification_failure_fixture before update on migration.source_documents
          for each row execute function public.payment_notification_failure_fixture();`);
        try {
          await requestFlow('reconcile');
          failedRefund = await record();
          assert.equal(failedRefund.recoveryFailureCount, 1);
          assert.equal(failedRefund.reconciliationRecoveryTerminal, false);
        } finally {
          await sql.unsafe('drop trigger payment_notification_failure_fixture on migration.source_documents');
        }
        const when = new originalDate(failedRefund.nextRecoveryAt).getTime() + 1;
        globalThis.Date = class extends originalDate {
          constructor(...args) { super(...(args.length ? args : [when])); }
          static now() { return when; }
        };
        const recovered = await requestFlow('reconcile');
        assert.equal(recovered.body.summary.refundsSynced, 1);
        assert.equal((await record()).refundRequiresBookingSync, false);
        assert.equal((await row(bookingId)).payload.status, 'refunded');
      }
      return { kind, missing, result, saved, failedRefund, actualNotificationModules: true };
    });
  }
  await run('recovery-failed-reschedule-notification-retains-streak', async () => {
    await seed('paypal', 'email_partial', { record: {
      requiresReschedule: true, recoveryNotificationRequired: true, emailDispatchRequired: false,
      recoveryAttemptCount: 11, recoveryFailureCount: 11, nextRecoveryAt: '',
    } });
    await removeRevision(bookingId, 'absent');
    const result = await requestFlow('reconcile');
    const saved = await record();
    assert.equal(saved.status, 'email_partial');
    assert.equal(saved.recoveryFailureCount, 11);
    return { result, saved, actualMissingRevisionNotificationFailure: true };
  });
  for (const scenario of ['paypal', 'razorpay', 'dodo', 'dodo-won', 'dodo-cancelled']) await run(`recovery-new-capture-after-exhaustion-${scenario}`, async () => {
    const provider = scenario.split('-')[0];
    const resolvedDispute = scenario.includes('-');
    const checkout = await a1Start(provider);
    await commerce.patch(checkout.id).set({
      recoveryAttemptCount: 12, recoveryFailureCount: 12, reconciliationRecoveryTerminal: true,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
      ...(resolvedDispute ? { dodoDisputeActive: true, verificationState: 'disputed' } : {}),
    }).commit();
    if (resolvedDispute) dodoPayment.disputes = [{
      amount: '9.99', business_id: 'business-fixture', created_at: '2026-01-01T00:00:00.000Z',
      currency: 'USD', dispute_id: 'dispute-fixture', dispute_stage: 'dispute',
      dispute_status: scenario.endsWith('won') ? 'dispute_won' : 'dispute_cancelled', payment_id: 'payment-fixture',
    }];
    await sql.unsafe(`create or replace function public.payment_capture_failure_fixture() returns trigger language plpgsql as $$
      begin
        if new.document_type = 'booking' then raise exception 'Synthetic booking storage failure'; end if;
        return new;
      end $$;
      create trigger payment_capture_failure_fixture before insert or update on migration.source_documents
      for each row execute function public.payment_capture_failure_fixture();`);
    let first, pending, duplicate;
    try {
      first = await a1Hook(provider);
      pending = (await row(checkout.id)).payload;
      assert.equal(pending.verificationState, 'server_verified');
      assert.equal(pending.bookingId, '');
      assert.equal(pending.recoveryFailureCount, 1);
      assert.equal(pending.reconciliationRecoveryTerminal, false);
      assert.ok(new originalDate(pending.nextRecoveryAt).getTime() < Date.UTC(9999, 0, 1));
      if (provider === 'paypal') {
        await requestFlow('paypal', { req: paypalReq('PAYMENT.CAPTURE.COMPLETED', {
          id: 'capture-fixture', supplementary_data: { related_ids: { order_id: 'order-fixture' } },
        }, 'duplicate-capture-event') });
        duplicate = (await row(checkout.id)).payload;
        assert.equal(duplicate.recoveryFailureCount, 2);
      }
      if (resolvedDispute) {
        await requestFlow('finalize', { paymentAccessToken: tokenFor(pending), body: {} });
        duplicate = (await row(checkout.id)).payload;
        assert.equal(duplicate.recoveryFailureCount, 2);
      }
    } finally {
      await sql.unsafe('drop trigger payment_capture_failure_fixture on migration.source_documents');
    }
    const when = new originalDate((duplicate || pending).nextRecoveryAt).getTime() + 1;
    globalThis.Date = class extends originalDate {
      constructor(...args) { super(...(args.length ? args : [when])); }
      static now() { return when; }
    };
    const recovered = await requestFlow('reconcile');
    const saved = (await row(checkout.id)).payload;
    assert.ok(['booked', 'email_partial'].includes(saved.status), JSON.stringify({ recovered, saved }));
    assert.ok(saved.bookingId);
    assert.equal((await row(saved.bookingId)).payload.paymentRecordId, checkout.id);
    assert.equal(saved.reconciliationRecoveryTerminal, false);
    return { scenario, provider, first, pending, duplicate, recovered, saved, realPostgresFailure: true };
  });
  for (const committed of [false, true]) await run(`gate-dodo-prebooking-partial-cron-${committed ? 'committed-refund' : 'fresh-observation'}`, async () => {
    const checkout = await a1Start('dodo', 'referral');
    const initial = (await row(checkout.id)).payload;
    await commerce.patch(initial._id).ifRevisionId(initial._rev).set({ createdAt: new Date(originalNow() - 600000).toISOString(), updatedAt: new Date(originalNow() - 600000).toISOString(), nextRecoveryAt: '' }).commit();
    dodoPayment.refunds = [{ refund_id: 'refund-gate', payment_id: dodoPayment.payment_id, status: 'succeeded', amount: 499, currency: 'USD' }];
    if (committed) {
      const { inspectDodoCheckout } = await import('../src/server/api/payment/dodoProvider.js');
      const current = (await row(checkout.id)).payload;
      const inspection = await inspectDodoCheckout({ record: current });
      assert.equal(inspection.state, 'captured');
      const observed = await flow.refreshDodoPayment({ client: commerce, record: current, payment: inspection.payment, source: 'reconcile', deferFinalization: true });
      assert.equal(observed.httpStatus, 200);
      const saved = (await row(checkout.id)).payload;
      assert.equal(saved.bookingId, '');
      assert.equal(saved.refundRequiresBookingSync, true);
      assert.equal(saved.refundProcessedAmountInSubunits, 499);
      const scheduledAt = new originalDate(saved.nextRecoveryAt || originalNow()).getTime();
      assert.ok(Number.isFinite(scheduledAt));
      const logicalNow = Math.max(originalNow() + 61000, scheduledAt + 1000);
      globalThis.Date = class extends originalDate { constructor(...args) { super(...(args.length ? args : [logicalNow])); } static now() { return logicalNow; } };
    }
    const responses = [];
    for (let pass = 0; pass < 3; pass++) {
      const response = await requestFlow('reconcile');
      assert.equal(response.status, 200, JSON.stringify(response));
      responses.push(response);
      const saved = (await row(checkout.id)).payload;
      assert.equal(saved.status, 'booked');
      assert.equal(saved.refundState, 'partial');
      assert.equal(saved.refundProcessedAmountInSubunits, 499);
      assert.equal(saved.refundRequiresBookingSync, false);
      const booking = (await row(saved.bookingId)).payload;
      assert.equal(booking.status, 'captured');
      assert.equal(booking.refundStatus, 'partial');
      assert.equal(booking.refundedAmount, 4.99);
      assert.equal(booking.netAmount, 9.99);
      assert.equal(booking.commissionAmount, 0.5);
      assert.equal(saved.refunds.length, 1);
      assert.equal(saved.refunds[0].providerRefundId, 'refund-gate');
      assert.equal(saved.refunds[0].amountInSubunits, 499);
      assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count, 1);
      const [refund] = await sql`select amount_subunits,currency,status from commerce.refunds`;
      assert.equal(Number(refund.amount_subunits), 499);
      assert.equal(refund.currency, 'USD');
      assert.equal(refund.status, 'completed');
    }
    assert.equal(providerRequests.filter(request => request.path === '/emails').length, 2);
    globalThis.Date = originalDate;
    return { responses, committedRefundBeforeCron: committed, initialAmountSubunits: 999, partialRefundSubunits: 499, nativeThreeCronCalls: true };
  });
  const a2PartialProof=async(id=recordId,cents=499,currency='USD',refundId='refund-fixture')=>{
    const saved=(await row(id)).payload,booking=(await row(saved.bookingId)).payload;
    const major=cents/providers.toSubunits(1,currency);
    assert.equal(saved.refundState,'partial');assert.equal(saved.refundProcessedAmountInSubunits,cents);assert.equal(saved.refundRequiresBookingSync,false);
    assert.equal(booking.refundStatus,'partial');assert.equal(booking.refundedAmount,major);assert.ok(booking.processedRefundIds.includes(refundId));assert.equal(booking.lastRefundId,refundId);
    assert.equal(booking.status,'captured');
    const [ledger]=await sql`select count(*)::integer as count,sum(amount_subunits)::integer as amount from commerce.refunds where status='completed'`;
    assert.equal(ledger.count,1);assert.equal(ledger.amount,cents);
    const [typed]=await sql`select booking_payload,source_revision from commerce.bookings where legacy_sanity_id=${saved.bookingId}`;assert.deepEqual(typed.booking_payload,booking);assert.equal(typed.source_revision,booking._rev);
    return{saved,booking,ledger,typed};
  };
  for(const provider of ['razorpay','paypal'])for(const via of ['client','cron','unrefunded-control','full-refused-control'])await run(`a2-f1-${provider}-${via}`,async()=>{
    const checkout=await a1Start(provider),full=via==='full-refused-control',amount=full?999:499;
    const partial=via!=='unrefunded-control';
    if(provider==='razorpay'&&partial){razorpayPayment.amount_refunded=amount;razorpayPayment.refund_status=full?'full':'partial';if(full)razorpayPayment.status='refunded';razorpayRefunds=[{id:'refund-fixture',payment_id:'payment-fixture',amount,currency:'USD',status:'processed'}];}
    if(provider==='paypal'&&partial){paypalOrder.purchase_units[0].payments.captures[0].status=full?'REFUNDED':'PARTIALLY_REFUNDED';paypalOrder.purchase_units[0].payments.refunds=[{id:'refund-fixture',amount:{value:(amount/100).toFixed(2),currency_code:'USD'},status:'COMPLETED'}];}
    if(via==='cron'){const before=(await row(checkout.id)).payload;await commerce.patch(before._id).ifRevisionId(before._rev).set({lastAttemptAt:new Date(originalNow()-120000).toISOString(),updatedAt:new Date(originalNow()-120000).toISOString()}).commit();}
    const response=via==='cron'?await requestFlow('reconcile'):await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof});
    const saved=(await row(checkout.id)).payload;
    if(full){assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count,0);assert.notEqual(saved.verificationState,'server_verified');return{response,saved,fullyRefundedGrantRefused:true};}
    assert.equal(response.status,200,JSON.stringify(response));assert.ok(saved.bookingId);assert.equal(saved.verificationState,'server_verified');
    if(!partial){assert.ok(!saved.refundState);return{response,saved,noRefundControl:true};}
    const proof=await a2PartialProof(checkout.id);assert.ok(saved.events.some(e=>e.reason==='provider_partial_refund_observed'));
    const bookingBefore=proof.booking,stable=await snapshot();assert.equal((await a1Hook(provider)).status,200);assert.equal((await row(saved.bookingId)).payload.refundedAmount,4.99);assert.deepEqual((await row(saved.bookingId)).payload.processedRefundIds,bookingBefore.processedRefundIds);
    const beforeReplay=await snapshot();assert.equal((await a1Hook(provider)).status,200);assert.deepEqual(await snapshot(),beforeReplay);return{response,proof,stable,idempotentProviderCaptureReplay:true};
  });
  for(const state of ['partial','full'])await run(`a2-f1-paypal-completed-capture-with-${state}-refunds`,async()=>{
    const checkout=await a1Start('paypal'),cents=state==='full'?999:499;paypalOrder.purchase_units[0].payments.refunds=[{id:'refund-fixture',amount:{value:(cents/100).toFixed(2),currency_code:'USD'},status:'COMPLETED'}];assert.equal(paypalOrder.purchase_units[0].payments.captures[0].status,'COMPLETED');
    const response=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof}),saved=(await row(checkout.id)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.equal(saved.refundState,state);assert.equal(saved.refundProcessedAmountInSubunits,cents);assert.equal(saved.refundRequiresBookingSync,false);let proof;
    if(state==='full'){assert.equal(saved.status,'refunded');assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count,0);assert.equal((await sql`select count(*)::integer as count from commerce.payment_proof_claims`)[0].count,0);}else proof=await a2PartialProof(checkout.id);
    return{response,saved,proof,financialListUsedDespiteStaleCaptureStatus:true};
  });
  for(const cents of [999,699])await run(`a2-f1-paypal-reported-refund-total-${cents}`,async()=>{
    const checkout=await a1Start('paypal');paypalOrder.purchase_units[0].payments.captures[0].status='PARTIALLY_REFUNDED';paypalOrder.purchase_units[0].payments.refunds=[{id:'refund-fixture',amount:{value:'4.99',currency_code:'USD'},status:'COMPLETED',seller_payable_breakdown:{total_refunded_amount:{value:(cents/100).toFixed(2),currency_code:'USD'}}}];
    const response=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof}),saved=(await row(checkout.id)).payload;assert.equal(response.status,200,JSON.stringify(response));
    if(cents===999){assert.equal(saved.status,'refunded');assert.equal(saved.refundState,'full');assert.equal(saved.refundProcessedAmountInSubunits,999);assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count,0);assert.equal((await sql`select count(*)::integer as count from commerce.payment_proof_claims`)[0].count,0);}else{const booking=(await row(saved.bookingId)).payload;assert.equal(saved.refundProcessedAmountInSubunits,499);assert.equal(booking.refundedAmount,4.99);assert.equal(saved.providerRefundObservedAmountInSubunits,699);assert.equal(saved.providerRefundDetailsMissing,true);assert.equal(saved.refundRequiresBookingSync,true);assert.equal(saved.reconciliationRecoveryTerminal,true);assert.equal(saved.recoveryReason,'provider_partial_refund_details_missing_owner_review');assert.equal(saved.refunds.length,1);}
    const stable=await snapshot();assert.equal((await requestFlow('reconcile')).status,200);assert.deepEqual(await snapshot(),stable);return{response,saved,documentedReportedAggregateUsed:true,incompleteIdentitiesRetainedWithoutFabrication:cents===699};
  });
  for(const amount of [499,999])await run(`a2-f1-razorpay-captured-amount-${amount}`,async()=>{
    const checkout=await a1Start('razorpay');razorpayPayment.amount_captured=amount;const verification=await providers.verifyRazorpayPayment({orderId:'order-fixture',paymentId:'payment-fixture',expectedAmount:9.99,expectedCurrency:'USD'});
    const response=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof}),saved=(await row(checkout.id)).payload;
    if(amount===499){assert.equal(verification.ok,false);assert.equal(verification.reason,'razorpay_amount_mismatch');assert.ok(!saved.bookingId);assert.notEqual(saved.verificationState,'server_verified');assert.equal((await sql`select count(*)::integer as count from commerce.payment_proof_claims`)[0].count,0);}else{assert.equal(verification.ok,true);assert.equal(response.status,200);assert.ok(saved.bookingId);assert.equal(saved.verificationState,'server_verified');}
    return{verification,response,saved,reportedCapturedAmount:amount,grantRefusedUntilFullQuoteCaptured:amount===499};
  });
  for(const provider of ['razorpay','paypal'])for(const mode of ['webhook','booking-sync-failure','kwd'])await run(`a2-f2-${provider}-${mode}`,async()=>{
    const currency=mode==='kwd'?'KWD':'USD',cents=mode==='kwd'?4990:499,total=mode==='kwd'?9990:999;
    await seed(provider,'booked',{booking:{currency},record:{pricingSnapshot:{netAmount:9.99,currency},providerPublicData:{currency,totalAmount:total}}});
    const beforeBooking=(await row(bookingId)).payload;
    const refund=provider==='razorpay'?{id:'refund-fixture',payment_id:'payment-fixture',amount:cents,currency,status:'processed'}:{id:'refund-fixture',status:'COMPLETED',amount:{value:'4.99',currency_code:currency},links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/capture-fixture'}]};
    const req=provider==='razorpay'?razorReq('refund.processed',{refund:{entity:refund}}):paypalReq('PAYMENT.CAPTURE.REFUNDED',refund);
    let blocked=false;
    if(mode==='booking-sync-failure')fixture.setRequestHook(async(phase,request)=>{if(phase==='before'&&request.body?.p_mutations?.some(m=>m.document?._id===bookingId&&m.document.refundStatus==='partial')){blocked=true;throw new Error('Exact synthetic failure after payment refund persists before booking partial commit');}});
    const response=await requestFlow(provider,{req});
    if(mode==='booking-sync-failure'){assert.equal(blocked,true);assert.equal((await record()).refundRequiresBookingSync,true);assert.deepEqual((await row(bookingId)).payload,beforeBooking);fixture.setRequestHook(null);const recovery=await requestFlow('reconcile');assert.equal(recovery.status,200,JSON.stringify(recovery));assert.equal(recovery.body.summary.refundsSynced,1);}
    else assert.equal(response.status,200,JSON.stringify(response));
    const proof=await a2PartialProof(recordId,cents,currency);assert.equal(proof.booking.commissionAmount,beforeBooking.commissionAmount);
    const stable=await snapshot();assert.equal((await requestFlow(provider,{req})).status,200);assert.deepEqual(await snapshot(),stable);
    return{response,proof,blocked,idempotentReplay:true,commissionUnchanged:true};
  });
  for(const provider of ['paypal','razorpay'])for(const variant of ['normal','coupon'])await run(`a2-f3-${provider}-full-refund-before-booking${variant==='coupon'?'-coupon-control':''}`,async()=>{
    const checkout=await a1Start(provider,variant),saved=(await row(checkout.id)).payload,total=providers.toSubunits(saved.pricingSnapshot.netAmount,'USD');
    if(provider==='razorpay')Object.assign(razorpayPayment,{status:'refunded',amount_refunded:total,refund_status:'full'});
    else paypalOrder.purchase_units[0].payments.captures[0].status='REFUNDED';
    const expired=new Date(originalNow()-3600000).toISOString();await commerce.patch(saved._id).ifRevisionId(saved._rev).set({createdAt:expired,updatedAt:expired,lastAttemptAt:expired,sessionExpiresAt:expired,nextRecoveryAt:''}).commit();
    const inspection=provider==='razorpay'?await providers.inspectRazorpayOrder({orderId:'order-fixture'}):await providers.inspectPayPalOrder({orderId:'order-fixture'});
    const response=await requestFlow('reconcile'),after=(await row(saved._id)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.equal(inspection.state,'refunded');assert.equal(after.status,'refunded');assert.equal(after.refundState,'full');assert.equal(after.refundProcessedAmountInSubunits,total);assert.equal(after.refundRequiresBookingSync,false);assert.equal(after.nextRecoveryAt,'');assert.ok(!after.bookingId);
    assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count,0);assert.equal((await sql`select count(*)::integer as count from commerce.payment_proof_claims`)[0].count,0);
    const [hold]=await sql`select phase from commerce.slot_holds`;assert.equal(hold.phase,'released');let coupon,redemption;if(variant==='coupon'){[coupon]=await sql`select reserved_uses,consumed_uses from commerce.coupons where code=${checkout.input.bookingPayload.couponCode.toLowerCase()}`;assert.equal(coupon.reserved_uses,0);assert.equal(coupon.consumed_uses,0);[redemption]=await sql`select state from commerce.coupon_redemptions`;assert.equal(redemption.state,'released');}else assert.equal(total,999);
    const stable=await snapshot();assert.equal((await requestFlow('reconcile')).status,200);assert.deepEqual(await snapshot(),stable);return{response,inspection,after,hold,coupon,redemption,terminalReplayUnchanged:true};
  });
  for(const provider of ['paypal','razorpay'])for(const state of ['full','partial'])await run(`a2-f3-${provider}-${state}-missing-booking-payload`,async()=>{
    const checkout=await a1Start(provider),saved=(await row(checkout.id)).payload,refundAmount=state==='full'?999:499;
    if(provider==='razorpay'){Object.assign(razorpayPayment,{status:state==='full'?'refunded':'captured',amount_refunded:refundAmount,refund_status:state});razorpayRefunds=[{id:'refund-fixture',payment_id:'payment-fixture',amount:refundAmount,currency:'USD',status:'processed'}];}
    else{paypalOrder.purchase_units[0].payments.captures[0].status=state==='full'?'REFUNDED':'PARTIALLY_REFUNDED';paypalOrder.purchase_units[0].payments.refunds=[{id:'refund-fixture',status:'COMPLETED',amount:{value:(refundAmount/100).toFixed(2),currency_code:'USD'}}];}
    const expired=new Date(originalNow()-3600000).toISOString();await commerce.patch(saved._id).ifRevisionId(saved._rev).set({bookingPayload:{},createdAt:expired,updatedAt:expired,lastAttemptAt:expired,sessionExpiresAt:expired,nextRecoveryAt:''}).commit();
    const response=await requestFlow('reconcile'),after=(await row(saved._id)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.equal(after.refundState,state);assert.equal(after.refundProcessedAmountInSubunits,refundAmount);assert.equal(after.refundRequiresBookingSync,false);
    if(state==='full'){assert.equal(after.status,'refunded');assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count,0);assert.equal(after.nextRecoveryAt,'');}
    else{assert.ok(after.bookingId);const booking=(await row(after.bookingId)).payload;assert.equal(booking.refundedAmount,4.99);assert.equal(booking.refundStatus,'partial');assert.ok(booking.processedRefundIds.includes('refund-fixture'));assert.equal(after.requiresReschedule,true);}
    return{response,after,noFullRefundRecoveryGrant:state==='full',partialRefundRecovered:state==='partial'};
  });
  for(const status of ['failed','cancelled'])for(const cart of ['null','omitted'])await run(`a2-f4-dodo-${status}-cart-${cart}`,async()=>{
    await seed('dodo','started',{record:{bookingId:'',emailDispatchRequired:false}});dodoPayment.status=status;if(cart==='null')dodoPayment.product_cart=null;else delete dodoPayment.product_cart;
    const response=await requestFlow('dodo',{req:dodoReq(dodoPayment,`payment.${status}`)}),saved=await record();assert.equal(response.status,200,JSON.stringify(response));assert.equal(saved.providerPaymentState,status);assert.equal(saved.status,status==='failed'?'failed':'abandoned');assert.ok(saved.events.some(e=>e.reason===`dodo_payment_${status}`));assert.notEqual(saved.verificationState,'server_verified');return{response,saved,documentedNullableCart:true};
  });
  for(const status of ['processing','requires_customer_action'])for(const cart of ['null','omitted'])await run(`a2-f4-dodo-${status}-cart-${cart}`,async()=>{
    await seed('dodo','started',{record:{bookingId:'',emailDispatchRequired:false}});dodoPayment.status=status;if(cart==='null')dodoPayment.product_cart=null;else delete dodoPayment.product_cart;const before=await snapshot();
    const response=await requestFlow('dodo',{req:dodoReq(dodoPayment,'payment.processing')}),saved=await record();assert.equal(response.status,503,JSON.stringify(response));assert.equal(response.body.providerPaymentState,status);assert.equal(saved.status,'started');assert.notEqual(saved.providerRecoveryTerminal,true);assert.deepEqual(await snapshot(),before);return{response,saved,documentedPendingNullableCart:true,noFinancialOrGrantMutation:true,existingPendingWebhookRetrySemantics:true};
  });
  for(const outcome of ['failed-lost','cancelled-full-refund'])await run(`a2-f4-dodo-${outcome}-financial-facts`,async()=>{
    await seed('dodo');dodoPayment.status=outcome==='failed-lost'?'failed':'cancelled';dodoPayment.product_cart=null;
    if(outcome==='failed-lost')dodoPayment.disputes=[{amount:'9.99',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',currency:'USD',dispute_id:'dispute-fixture',dispute_stage:'dispute',dispute_status:'dispute_lost',payment_id:'payment-fixture'}];else{dodoPayment.refund_status='full';dodoPayment.refunds=[dodoRefund];}
    const response=await requestFlow('dodo',{req:dodoReq(dodoPayment,`payment.${dodoPayment.status}`)}),saved=await record(),booking=(await row(bookingId)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.equal(saved.providerPaymentState,dodoPayment.status);
    if(outcome==='failed-lost'){assert.equal(booking.commissionAmount,0);assert.equal(booking.status,'pending');assert.equal(saved.dodoDisputes[0].status,'dispute_lost');assert.equal(saved.providerRecoveryTerminalReason,'dodo_dispute_lost_owner_review');}else{assert.equal(booking.status,'refunded');assert.ok(booking.refundAccountingAppliedAt);assert.equal(booking.commissionAmount,1);assert.equal(saved.status,'refunded');assert.equal(saved.refundProcessedAmountInSubunits,999);}return{response,saved,booking,independentFinancialFactsSurviveProviderTerminalOutcome:true};
  });
  await run('a2-f4-dodo-succeeded-wrong-cart-control',async()=>{await seed('dodo','started',{record:{bookingId:''}});dodoPayment.product_cart=[{product_id:'wrong-product',quantity:1}];const before=await snapshot(),response=await requestFlow('dodo',{req:dodoReq()});assert.equal(response.status,409);assert.equal(response.body.code,'dodo_product_mismatch');assert.deepEqual(await snapshot(),before);return{response,allBusinessPersistenceUnchanged:true};});
  for(const status of ['failed','pending','review'])await run(`a2-f5-dodo-refund-${status}-then-succeeded`,async()=>{
    await seed('dodo');const initial=(await row(bookingId)).payload;Object.assign(dodoRefund,{status,amount:499,is_partial:true});dodoPayment.refunds=[dodoRefund];
    const req=dodoReq({...dodoRefund,payload_type:'Refund'},status==='failed'?'refund.failed':'refund.succeeded');const response=await requestFlow('dodo',{req}),saved=await record();assert.equal(response.status,200,JSON.stringify(response));assert.equal(saved.refunds.length,1);assert.equal(saved.refunds[0].providerRefundId,'refund-fixture');assert.equal(saved.refunds[0].status,status);assert.equal(saved.refunds[0].amountInSubunits,499);assert.equal(saved.refunds[0].currency,'USD');assert.equal(saved.refundProcessedAmountInSubunits,0);assert.deepEqual((await row(bookingId)).payload,initial);
    const stable=await snapshot();assert.equal((await requestFlow('dodo',{req})).status,200);assert.deepEqual(await snapshot(),stable);
    dodoRefund.status='succeeded';dodoPayment.refund_status='partial';const later=dodoReq({...dodoRefund,payload_type:'Refund'},'refund.succeeded');later.headers['webhook-id']+='-success';const ts=later.headers['webhook-timestamp'];later.headers['webhook-signature']='v1,'+crypto.createHmac('sha256',Buffer.from('fixture-dodo-secret')).update(`${later.headers['webhook-id']}.${ts}.${later.rawBody}`).digest('base64');
    const success=await requestFlow('dodo',{req:later});assert.equal(success.status,200,JSON.stringify(success));const after=await record(),booking=(await row(bookingId)).payload;assert.equal(after.refunds.length,1);assert.equal(after.refunds[0].status,'processed');assert.equal(after.refundProcessedAmountInSubunits,499);assert.equal(booking.refundedAmount,4.99);
    const successStable=await snapshot();assert.equal((await requestFlow('dodo',{req:later})).status,200);assert.deepEqual(await snapshot(),successStable);return{response,saved,success,after,booking,noAccountingBeforeSuccess:true,accountingExactlyOnce:true};
  });
  for(const status of ['failed','pending','review'])await run(`a2-f5-dodo-null-${status}-no-accounting`,async()=>{
    await seed('dodo');dodoPayment.refunds=[{...dodoRefund,status,amount:null,currency:null,is_partial:true}];const before=(await row(bookingId)).payload;
    const response=await requestFlow('dodo',{req:dodoReq(dodoPayment.refunds[0],'refund.failed')}),saved=await record();assert.equal(response.status,200,JSON.stringify(response));assert.equal(saved.refunds[0].status,status);assert.equal(saved.refunds[0].amountInSubunits,null);assert.equal(saved.refunds[0].currency,null);assert.equal(saved.refundProcessedAmountInSubunits,0);assert.deepEqual((await row(bookingId)).payload,before);assert.equal(providerRequests.filter(r=>r.path.startsWith('/refunds/')).length,0);return{response,saved,noAccountingOrFabricatedMoney:true};
  });
  await run('a2-f5-dodo-stale-failure-after-success-preserves-accounting',async()=>{
    await seed('dodo');Object.assign(dodoRefund,{amount:499,is_partial:true});dodoPayment.refund_status='partial';dodoPayment.refunds=[dodoRefund];assert.equal((await requestFlow('dodo',{req:dodoReq()})).status,200);const before=await snapshot();dodoRefund.status='failed';dodoPayment.refund_status=null;
    const response=await flow.refreshDodoPayment({client:commerce,record:await record(),payment:dodoPayment,source:'webhook'});assert.equal(response.httpStatus,200);assert.deepEqual(await snapshot(),before);return{response,successNotDowngraded:true};
  });
  await run('a2-f1-paypal-optional-refunds-owner-review',async()=>{
    const checkout=await a1Start('paypal');paypalOrder.purchase_units[0].payments.captures[0].status='PARTIALLY_REFUNDED';delete paypalOrder.purchase_units[0].payments.refunds;
    const response=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof}),saved=(await row(checkout.id)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.ok(saved.bookingId);assert.equal(saved.refundState,'partial');assert.equal(saved.providerRefundDetailsMissing,true);assert.equal(saved.reconciliationRecoveryTerminal,true);assert.equal(saved.recoveryReason,'provider_partial_refund_details_missing_owner_review');assert.ok(saved.events.some(e=>e.reason==='provider_partial_refund_observed'));
    const before=await snapshot();const recovery=await requestFlow('reconcile');assert.equal(recovery.status,200);assert.deepEqual(await snapshot(),before);return{response,saved,existingPartialGrantRetained:true,missingOptionalMoneyNotFabricated:true,automaticRecoveryBounded:true};
  });
  await run('a2-f1-paypal-missing-refund-details-then-known-full',async()=>{
    const checkout=await a1Start('paypal');paypalOrder.purchase_units[0].payments.captures[0].status='PARTIALLY_REFUNDED';delete paypalOrder.purchase_units[0].payments.refunds;assert.equal((await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof})).status,200);assert.equal((await row(checkout.id)).payload.providerRefundDetailsMissing,true);
    for(const cents of [499,500]){const req=paypalReq('PAYMENT.CAPTURE.REFUNDED',{id:`refund-${cents}`,status:'COMPLETED',amount:{value:(cents/100).toFixed(2),currency_code:'USD'},links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/capture-fixture'}]},`event-detail-${cents}-${scenarioNumber}`);assert.equal((await requestFlow('paypal',{req})).status,200);}
    const saved=(await row(checkout.id)).payload,booking=(await row(saved.bookingId)).payload;assert.equal(saved.status,'refunded');assert.equal(saved.refundProcessedAmountInSubunits,999);assert.equal(saved.refundRequiresBookingSync,false);assert.equal(saved.providerRefundDetailsMissing,false);assert.equal(saved.providerRecoveryTerminal,false);assert.equal(saved.providerRecoveryTerminalReason,'');assert.equal(saved.recoveryReason,'');assert.equal(booking.status,'refunded');assert.equal(booking.refundedAmount,9.99);const stable=await snapshot();assert.equal((await requestFlow('reconcile')).status,200);assert.deepEqual(await snapshot(),stable);return{saved,booking,obsoletePartialDetailReviewClearedByKnownFullProof:true};
  });
  await run('a2-n12-paypal-kwd-three-fractional-digits',async()=>{
    await seed('paypal','booked',{booking:{currency:'KWD'},record:{pricingSnapshot:{netAmount:9.99,currency:'KWD'},providerPublicData:{currency:'KWD',totalAmount:9990}}});
    const response=await requestFlow('paypal',{req:paypalReq('PAYMENT.CAPTURE.REFUNDED',{id:'refund-fixture',status:'COMPLETED',amount:{value:'4.999',currency_code:'KWD'},links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/capture-fixture'}]})});assert.equal(response.status,200,JSON.stringify(response));assert.equal((await record()).refundProcessedAmountInSubunits,4999);const proof=await a2PartialProof(recordId,4999,'KWD');return{response,proof};
  });
  for(const provider of ['paypal','razorpay'])await run(`a2-f2-${provider}-two-partials-concurrent-full`,async()=>{
    await seed(provider);const send=amount=>requestFlow(provider,{req:provider==='razorpay'?razorReq('refund.processed',{refund:{entity:{id:`refund-${amount}`,payment_id:'payment-fixture',amount,currency:'USD',status:'processed'}}}):paypalReq('PAYMENT.CAPTURE.REFUNDED',{id:`refund-${amount}`,status:'COMPLETED',amount:{value:(amount/100).toFixed(2),currency_code:'USD'},links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/capture-fixture'}]},`event-refund-${amount}-${scenarioNumber}`)});
    const responses=await Promise.all([send(499),send(500)]);assert.ok(responses.every(r=>[200,202,503].includes(r.status)),JSON.stringify(responses));await requestFlow('reconcile');const saved=await record(),booking=(await row(bookingId)).payload;assert.equal(saved.refunds.length,2);assert.equal(saved.refundProcessedAmountInSubunits,999);assert.equal(saved.refundRequiresBookingSync,false);assert.equal(booking.refundedAmount,9.99);assert.equal(booking.status,'refunded');assert.equal(booking.refundStatus,'full');
    const before=await snapshot();assert.equal((await send(499)).status,200);assert.equal((await send(500)).status,200);assert.deepEqual(await snapshot(),before);return{responses,saved,booking,concurrentDistinctIdsAndDuplicates:true};
  });
  for(const [provider,variant] of [['paypal','partial'],['razorpay','partial'],['paypal','no-refund'],['razorpay','no-refund'],['paypal','sync-failure'],['razorpay','sync-failure'],['paypal','missing-details'],['paypal','reported-total'],['paypal','pending-refund'],['razorpay','pending-refund'],['paypal','payment-sync-failure'],['razorpay','payment-sync-failure'],['paypal','create-conflict'],['razorpay','create-conflict'],['paypal','revision-conflict'],['razorpay','revision-conflict'],['paypal','later-full'],['razorpay','later-full']])await run(variant==='partial'?`a2-outside-ownership-${provider}-legacy-direct-partial-proof`:`fix-c-legacy-${provider}-${variant}`,async()=>{
    const input=await startInput(),proof=provider==='paypal'?{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}:{razorpayOrderId:'order-fixture',razorpayPaymentId:'payment-fixture',razorpaySignature:crypto.createHmac('sha256','fixture-secret').update('order-fixture|payment-fixture').digest('hex')};
    const hold=(await row(input.bookingPayload.slotHoldId)).payload;await commerce.patch(hold._id).ifRevisionId(hold._rev).set({phase:'active'}).commit();await sql`update migration.source_documents set payload=jsonb_set(payload,'{backendOwner}','"sanity"'::jsonb) where legacy_sanity_id=${hold._id}`;await sql`update commerce.slot_holds set backend_owner='sanity' where legacy_sanity_id=${hold._id}`;const {issueHoldToken}=await import('../src/server/booking/holdToken.js');input.bookingPayload.slotHoldToken=issueHoldToken({holdId:hold._id,startTimeUTC:hold.startTimeUTC,expiresAt:hold.expiresAt,holdNonce:hold.holdNonce,backend:'sanity',cutoverGeneration:0});
    if(variant!=='no-refund'&&provider==='razorpay'){Object.assign(razorpayPayment,{amount_refunded:499,refund_status:'partial'});razorpayRefunds=[{id:'refund-fixture',payment_id:'payment-fixture',amount:499,currency:'USD',status:'processed'}];}
    else if(variant!=='no-refund'){paypalOrder.purchase_units[0].payments.captures[0].status='PARTIALLY_REFUNDED';paypalOrder.purchase_units[0].payments.refunds=[{id:'refund-fixture',status:'COMPLETED',amount:{value:'4.99',currency_code:'USD'}}];}
    if(variant==='missing-details')delete paypalOrder.purchase_units[0].payments.refunds;
    if(variant==='reported-total')paypalOrder.purchase_units[0].payments.refunds[0].seller_payable_breakdown={total_refunded_amount:{value:'6.99',currency_code:'USD'}};
    if(variant==='pending-refund')await commerce.create({_id:recordId,_type:'paymentRecord',provider,providerOrderId:'order-fixture',providerPaymentId:provider==='paypal'?'capture-fixture':'payment-fixture',status:'started',pricingSnapshot:{netAmount:9.99,currency:'USD'},providerPublicData:{currency:'USD'},refunds:[{_key:'pending-fixture',providerRefundId:'refund-fixture',providerPaymentId:provider==='paypal'?'capture-fixture':'payment-fixture',status:'pending',amount:4.99,amountInSubunits:499,currency:'USD'}]});
    let faulted=false;if(['sync-failure','payment-sync-failure'].includes(variant))fixture.setRequestHook(async(phase,request)=>{if(phase==='before'&&request.body?.p_mutations?.some(m=>variant==='payment-sync-failure'?m.document?._type==='paymentRecord':m.document?._type==='booking'&&m.document.refundedAmount===4.99)){faulted=true;throw new Error('Exact legacy committed booking -> partial-refund booking synchronization fault');}});
    if(variant==='revision-conflict')await commerce.create({_id:recordId,_type:'paymentRecord',provider,providerOrderId:'order-fixture',providerPaymentId:provider==='paypal'?'capture-fixture':'payment-fixture',status:'started',pricingSnapshot:{netAmount:9.99,currency:'USD'},providerPublicData:{currency:'USD'},refunds:[]});
    let concurrentRecord=null;if(['create-conflict','revision-conflict'].includes(variant))fixture.setRequestHook(async(phase,request)=>{const create=request.body?.p_mutations?.find(m=>m.operation===(variant==='create-conflict'?'create':'replace')&&m.document?._type==='paymentRecord');if(phase!=='before'||!create||concurrentRecord)return;fixture.setRequestHook(null);const doc=create.document;const incoming={...doc,refunds:[{_key:'concurrent-refund',providerRefundId:'refund-concurrent',providerPaymentId:provider==='paypal'?'capture-fixture':'payment-fixture',status:'processed',amount:1,amountInSubunits:100,currency:'USD'}],refundProcessedAmountInSubunits:100,refundRequiresBookingSync:true};if(variant==='create-conflict')await commerce.create(incoming);else{const current=(await row(doc._id)).payload;const values={...incoming};delete values._id;delete values._type;delete values._rev;await commerce.patch(doc._id).ifRevisionId(current._rev).set(values).commit();}concurrentRecord=(await row(doc._id)).payload;});
    const body={...input.bookingPayload,...proof,paymentProvider:provider,status:'captured'};const response=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})}),result={status:response.status,body:await response.json()};
    if(['create-conflict','revision-conflict'].includes(variant)){assert.ok(concurrentRecord,`Native interleaved write must happen: ${JSON.stringify(result)}`);assert.equal(result.status,409,JSON.stringify(result));const retained=(await row(concurrentRecord._id)).payload;assert.deepEqual(retained,concurrentRecord);const retry=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});const recovered={status:retry.status,body:await retry.json()};assert.equal(recovered.status,200,JSON.stringify(recovered));const booking=(await row(recovered.body.bookingId)).payload,saved=(await row(concurrentRecord._id)).payload;assert.equal(booking.status,'captured');assert.equal(booking.refundedAmount,5.99);assert.equal(saved.refundProcessedAmountInSubunits,599);assert.deepEqual(new Set(booking.processedRefundIds),new Set(['refund-concurrent','refund-fixture']));const [ledger]=await sql`select count(*)::int count,sum(amount_subunits)::int amount from commerce.refunds`;assert.equal(ledger.count,2);assert.equal(ledger.amount,599);return{result,concurrentRecord,retained,recovered,booking,saved,ledger,nativeNewerWriterPreserved:true};}
    let recovered=null,committedBeforeRecovery=null;
    if(['sync-failure','payment-sync-failure'].includes(variant)){assert.equal(faulted,true);assert.equal(result.status,500,JSON.stringify(result));committedBeforeRecovery=await snapshot();assert.equal(committedBeforeRecovery.tables.bookings.length,1);const pending=committedBeforeRecovery.source.find(r=>r.document_type==='paymentRecord'||r.payload._type==='paymentRecord')?.payload;if(variant==='payment-sync-failure'){assert.equal(pending,undefined);assert.equal(committedBeforeRecovery.tables.bookings[0].row.booking_payload.paymentRefundVerification.refunds[0].id,'refund-fixture');}else{assert.equal(pending.refundRequiresBookingSync,true);assert.equal(pending.refundProcessedAmountInSubunits,499);}fixture.setRequestHook(null);const retry=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});recovered={status:retry.status,body:await retry.json()};assert.equal(recovered.status,200,JSON.stringify(recovered));}
    else assert.equal(result.status,200,JSON.stringify(result));
    const booking=(await row((recovered||result).body.bookingId)).payload,saved=(await sql`select payload from migration.source_documents where document_type='paymentRecord' and payload->>'bookingId'=${booking._id}`)[0]?.payload;
    assert.equal(booking.status,'captured');assert.equal(saved.bookingId,booking._id);assert.equal(booking.netAmount,9.99);const commission=booking.commissionAmount;
    const [ledger]=await sql`select count(*)::int count,coalesce(sum(amount_subunits),0)::int amount from commerce.refunds where payment_record_id=(select id from commerce.payment_records where legacy_sanity_id=${saved._id})`;
    if(variant==='no-refund'){assert.equal(booking.refundedAmount,undefined);assert.equal(saved.refundState,undefined);assert.equal(ledger.count,0);}
    else if(variant==='missing-details'){assert.equal(booking.refundedAmount,undefined);assert.equal(saved.refundState,'partial');assert.equal(saved.providerRefundDetailsMissing,true);assert.equal(saved.providerRecoveryTerminalReason,'provider_partial_refund_details_missing_owner_review');assert.equal(ledger.count,0);}
    else{assert.equal(booking.refundedAmount,4.99);assert.equal(booking.refundStatus,'partial');assert.deepEqual(booking.processedRefundIds,['refund-fixture']);assert.equal(saved.refundState,'partial');assert.ok(saved.events.some(event=>event.reason==='provider_partial_refund_observed'));assert.equal(saved.refundProcessedAmountInSubunits,499);assert.equal(ledger.count,1);assert.equal(ledger.amount,499);assert.equal(saved.refundRequiresBookingSync,variant==='reported-total');if(variant==='reported-total'){assert.equal(saved.providerRefundObservedAmountInSubunits,699);assert.equal(saved.providerRefundDetailsMissing,true);assert.equal(saved.providerRecoveryTerminalReason,'provider_partial_refund_details_missing_owner_review');}}
    const duplicate=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});const replay={status:duplicate.status,body:await duplicate.json()};assert.equal(replay.status,200,JSON.stringify(replay));const repeated=(await row(booking._id)).payload;assert.equal(repeated.refundedAmount,booking.refundedAmount);assert.deepEqual(repeated.processedRefundIds,booking.processedRefundIds);assert.equal(repeated.commissionAmount,commission);const [duplicateLedger]=await sql`select count(*)::int count,coalesce(sum(amount_subunits),0)::int amount from commerce.refunds where payment_record_id=(select id from commerce.payment_records where legacy_sanity_id=${saved._id})`;assert.deepEqual(duplicateLedger,ledger);
    let fullProof=null;if(variant==='later-full'){const refunded=provider==='paypal'?await requestFlow('paypal',{req:paypalReq('PAYMENT.CAPTURE.REFUNDED',{id:'refund-final',status:'COMPLETED',supplementary_data:{related_ids:{order_id:'order-fixture',capture_id:'capture-fixture'}},amount:{value:'5.00',currency_code:'USD'}})}):await requestFlow('razorpay',{req:razorReq('refund.processed',{refund:{entity:{id:'refund-final',payment_id:'payment-fixture',status:'processed',amount:500,currency:'USD'}}})});assert.equal(refunded.status,200,JSON.stringify(refunded));const terminalPayment=(await row(saved._id)).payload,terminalBooking=(await row(booking._id)).payload;assert.equal(terminalPayment.refundState,'full');assert.equal(terminalPayment.refundProcessedAmountInSubunits,999);assert.equal(terminalBooking.status,'refunded');assert.equal(terminalBooking.refundedAmount,9.99);const oldRetry=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});const oldReplay={status:oldRetry.status,body:await oldRetry.json()};assert.equal(oldReplay.status,200,JSON.stringify(oldReplay));assert.deepEqual((await row(saved._id)).payload,terminalPayment);const repeatedBooking=(await row(booking._id)).payload;const emailBookkeeping=['_rev','_updatedAt','emailDispatchAttemptCount','emailDispatchLastAttemptAt'];const stable=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!emailBookkeeping.includes(key)));assert.deepEqual(stable(repeatedBooking),stable(terminalBooking));assert.equal(repeatedBooking.emailDispatchAttemptCount,terminalBooking.emailDispatchAttemptCount+1);fullProof={refunded,terminalPayment,terminalBooking,repeatedBooking,oldReplay,emailBookkeeping,staleLegacyPartialSnapshotCannotDowngradeFull:true};}
    return{fullProof,result,recovered,committedBeforeRecovery,booking,saved,ledger,replay,partialGrantAndCommissionPolicyPreserved:true,duplicateRefundAccountingUnchanged:true,standIn:'Imported active sanity-owned hold in native store; no live legacy incidence or Sanity engine claimed'};
  });
  await run('a2-f6-lost-with-partial-refund-completion-failure',async()=>{
    await seed('dodo');Object.assign(dodoRefund,{amount:499,is_partial:true});dodoPayment.refund_status='partial';dodoPayment.refunds=[dodoRefund];dodoPayment.disputes=[{amount:'9.99',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',currency:'USD',dispute_id:'dispute-fixture',dispute_stage:'dispute',dispute_status:'dispute_lost',payment_id:'payment-fixture'}];let failed=false;
    fixture.setRequestHook(async(phase,request)=>{if(phase==='before'&&request.body?.p_mutations?.some(m=>m.document?._id===recordId&&m.document.refundState==='partial'&&m.document.refundRequiresBookingSync===false)){failed=true;throw new Error('Exact fault after successful partial booking sync before refund completion');}});
    const response=await requestFlow('dodo',{req:dodoReq()}),saved=await record(),booking=(await row(bookingId)).payload;assert.equal(failed,true);assert.equal(response.status,503);assert.equal(booking.status,'pending');assert.equal(booking.commissionAmount,0);assert.equal(booking.refundedAmount,4.99);assert.equal(saved.providerRecoveryTerminal,true);assert.equal(saved.refundRequiresBookingSync,true);fixture.setRequestHook(null);
    const recovered=await requestFlow('reconcile');assert.equal(recovered.status,200);assert.equal((await row(bookingId)).payload.commissionAmount,0);assert.equal((await record()).refundRequiresBookingSync,false);assert.equal((await record()).recoveryReason,'dodo_dispute_lost_owner_review');return{response,saved,booking,recovered,terminalWithholdingSurvivesCommittedPartialRefundAndCompletionFailure:true};
  });
  await run('a2-f6-lost-with-null-succeeded-refund-details',async()=>{
    await seed('dodo');Object.assign(dodoRefund,{amount:null,currency:null,is_partial:true});dodoPayment.refund_status='partial';dodoPayment.refunds=[dodoRefund];dodoPayment.disputes=[{amount:'9.99',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',currency:'USD',dispute_id:'dispute-fixture',dispute_stage:'dispute',dispute_status:'dispute_lost',payment_id:'payment-fixture'}];
    const response=await requestFlow('dodo',{req:dodoReq()}),saved=await record(),booking=(await row(bookingId)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.equal(booking.status,'pending');assert.equal(booking.commissionAmount,0);assert.equal(saved.dodoDisputes[0].status,'dispute_lost');assert.equal(saved.dodoDisputes[0].stage,'dispute');assert.equal(saved.providerRecoveryTerminal,true);assert.equal(saved.nextRecoveryAt,'');assert.equal(saved.refundProcessedAmountInSubunits||0,0);return{response,saved,booking,independentKnownDisputeWithheldBeforeMissingRefundReview:true};
  });
  for(const status of ['dispute_lost','dispute_accepted','dispute_expired','dispute_opened','dispute_challenged','dispute_won','dispute_cancelled'])await run(`a2-f6-dodo-${status}`,async()=>{
    await seed('dodo');const adverse=['dispute_lost','dispute_accepted','dispute_expired'].includes(status),active=!['dispute_won','dispute_cancelled'].includes(status);
    dodoPayment.disputes=[{amount:'9.99',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',currency:'USD',dispute_id:'dispute-fixture',dispute_stage:'dispute',dispute_status:status,payment_id:'payment-fixture'}];
    const response=await requestFlow('dodo',{req:dodoReq()}),saved=await record(),booking=(await row(bookingId)).payload;assert.equal(response.status,200,JSON.stringify(response));assert.equal(saved.dodoDisputes[0].disputeId,'dispute-fixture');assert.equal(saved.dodoDisputes[0].status,status);assert.equal(saved.dodoDisputes[0].stage,'dispute');assert.equal(booking.commissionAmount,active?0:1);assert.equal(booking.status,active?'pending':'captured');
    if(adverse){assert.equal(saved.providerRecoveryTerminal,true);assert.equal(saved.providerRecoveryTerminalReason,`dodo_${status}_owner_review`);assert.equal(saved.nextRecoveryAt,'');const stable=await snapshot();assert.equal((await requestFlow('reconcile')).status,200);assert.deepEqual(await snapshot(),stable);}
    else if(active){assert.ok(saved.nextRecoveryAt);assert.equal(saved.providerRecoveryTerminal,false);}
    return{response,saved,booking,adverse,active};
  });
  for(const status of ['dispute_won','dispute_cancelled'])await run(`a2-f6-dodo-active-then-${status}`,async()=>{
    await seed('dodo');dodoPayment.disputes=[{amount:'9.99',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',currency:'USD',dispute_id:'dispute-fixture',dispute_stage:'pre_dispute',dispute_status:'dispute_opened',payment_id:'payment-fixture'}];assert.equal((await flow.refreshDodoPayment({client:commerce,record:await record(),payment:dodoPayment,source:'webhook'})).httpStatus,200);assert.equal((await row(bookingId)).payload.commissionAmount,0);
    dodoPayment.disputes[0].dispute_status=status;dodoPayment.disputes[0].dispute_stage='pre_arbitration';const response=await flow.refreshDodoPayment({client:commerce,record:await record(),payment:dodoPayment,source:'webhook'}),saved=await record(),booking=(await row(bookingId)).payload;assert.equal(response.httpStatus,200);assert.equal(booking.status,'captured');assert.equal(booking.commissionAmount,1);assert.equal(saved.providerRecoveryTerminal,false);assert.equal(saved.dodoDisputes[0].stage,'pre_arbitration');const stable=await snapshot();assert.equal((await flow.refreshDodoPayment({client:commerce,record:await record(),payment:dodoPayment,source:'webhook'})).httpStatus,200);assert.deepEqual(await snapshot(),stable);return{response,saved,booking,existingRestorationAndStageTransition:true,duplicateUnchanged:true};
  });
  await run('a2-n12-exact-iso-exponents',async()=>{
    const zero='BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'.split(' '),three='BHD IQD JOD KWD LYD OMR TND'.split(' '),results=[];
    for(const [codes,factor] of [[zero,1],[three,1000],[['USD','EUR','INR','ABC'],100]])for(const currency of codes)results.push({currency,expected:factor,actual:providers.toSubunits(1,currency)});
    fs.writeFileSync(`${artifact}.iso-exponents.json`,JSON.stringify(results,null,2));assert.ok(results.every(r=>r.actual===r.expected),JSON.stringify(results.filter(r=>r.actual!==r.expected)));return{results};
  });
  for(const currency of ['CLP','JOD','INR'])await run(`a2-n12-native-${currency.toLowerCase()}-partial`,async()=>{
    const factor=currency==='CLP'?1:currency==='JOD'?1000:100,cents=4*factor,total=10*factor;
    await seed('razorpay','booked',{booking:{currency,netAmount:10},record:{pricingSnapshot:{netAmount:10,currency},providerPublicData:{currency,totalAmount:total}}});
    const response=await requestFlow('razorpay',{req:razorReq('refund.processed',{refund:{entity:{id:'refund-fixture',payment_id:'payment-fixture',amount:cents,currency,status:'processed'}}})});assert.equal(response.status,200,JSON.stringify(response));const proof=await a2PartialProof(recordId,cents,currency);assert.equal(proof.booking.refundedAmount,4);return{response,proof};
  });
  for(const [provider,variant,via] of [['paypal','normal','cron'],['razorpay','normal','cron'],['paypal','coupon','cron'],['free','normal','cron'],['dodo','normal','cron'],['paypal','normal','webhook'],['razorpay','normal','webhook'],['paypal','referral','cron'],['paypal','referral','webhook'],['paypal','truncated','cron'],['paypal','truncated','webhook']])await run(`a1-${provider}-${variant}-client-${via}`,async()=>{
    const checkout=await a1Start(provider,variant),before=await snapshot({receipts:true});
    const finalized=provider==='free'?checkout.started:await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof});
    assert.equal(finalized.status,200,JSON.stringify(finalized));let saved=(await row(checkout.id)).payload;
    const afterClient=await snapshot({receipts:true});
    if(variant==='truncated'){
      const payload={...saved.bookingPayload};for(const field of ['discord','specs','mainGame','message','referralId'])delete payload[field];await commerce.patch(saved._id).ifRevisionId(saved._rev).set({bookingPayload:payload}).commit();
    }
    const recovered=via==='webhook'?await a1Hook(provider):await requestFlow('reconcile');saved=(await row(checkout.id)).payload;
    const proofPath=`${artifact}.${provider}-${variant}-${via}.json`;
    fs.writeFileSync(proofPath,JSON.stringify({before,finalized,afterClient,recovered,afterRecovery:await snapshot({receipts:true})},null,2));
    assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(saved.status,'booked');assert.equal(saved.verificationState,provider==='free'?'':'server_verified');assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.emailDispatch.allSent,true);assert.equal(saved.recoveryAttemptCount,0);assert.equal(saved.nextRecoveryAt,'');assert.ok(finalized.body.analyticsReceipt);assert.ok(saved.events.some(e=>e.status==='booked'&&e.source===(via==='webhook'?'webhook':provider==='free'?'start':'reconcile')));
    if(variant!=='truncated'){for(const field of ['discord','specs','mainGame','message'])assert.equal(saved.bookingPayload[field],checkout.input.bookingPayload[field]);}
    const holds=await sql`select phase from commerce.slot_holds`,slots=await sql`select claim_type from commerce.slot_claims`,proofs=await sql`select provider,booking_id,payment_record_id from commerce.payment_proof_claims`;assert.equal(holds.length,1);assert.equal(holds[0].phase,'consumed');assert.equal(slots.length,1);assert.equal(slots[0].claim_type,'booking');assert.equal(proofs.length,1);assert.equal(proofs[0].provider,provider);
    if(variant==='coupon'||provider==='free'){const [coupon]=await sql`select consumed_uses,reserved_uses from commerce.coupons where code=${checkout.input.bookingPayload.couponCode.toLowerCase()}`,redemptions=await sql`select state from commerce.coupon_redemptions`;assert.equal(coupon.consumed_uses,1);assert.equal(coupon.reserved_uses,0);assert.equal(redemptions.length,1);assert.equal(redemptions[0].state,'consumed');}
    const bookings=await sql`select * from commerce.bookings`;assert.equal(bookings.length,1);assert.equal(bookings[0].source_revision,(await row(saved.bookingId)).payload._rev);
    const money=async()=>({payment:await sql`select status,currency,amount_subunits,email_dispatch_required from commerce.payment_records where legacy_sanity_id=${saved._id}`,booking:await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${saved.bookingId}`,email:await sql`select dispatch_kind,recipient_type,status,sent_at,next_attempt_at from commerce.email_dispatches order by dispatch_kind,recipient_type`});
    const incremental=await money();assert.equal(incremental.payment[0].email_dispatch_required,false);
    for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){assert.equal((await fixture.client.rpc(rpc)).error,null);assert.deepEqual(await money(),incremental);}
    const stable=await snapshot({receipts:true});assert.equal((await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof})).status,200);assert.deepEqual(await snapshot({receipts:true}),stable);
    fs.writeFileSync(proofPath,JSON.stringify({before,finalized,afterClient,recovered,afterRecovery:stable,incremental,allProjectorsAgree:true,duplicateUnchanged:true},null,2));
    return{proofPath,provider,variant,via,analyticsReceipt:finalized.body.analyticsReceipt,incremental,duplicateUnchanged:true,realStartAndClientFinalize:true};
  });
  for(const via of ['cron','webhook'])await run(`a1-paypal-uppercase-referral-preserved-payload-${via}`,async()=>{
    const checkout=await a1Start('paypal','referral'),finalized=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof});assert.equal(finalized.status,200,JSON.stringify(finalized));let saved=(await row(checkout.id)).payload;
    const payload={...checkout.input.bookingPayload,...saved.bookingPayload};for(const field of ['discord','specs','mainGame','message','referralId','referralCode'])payload[field]=checkout.input.bookingPayload[field];await commerce.patch(saved._id).ifRevisionId(saved._rev).set({bookingPayload:payload}).commit();
    const before=await snapshot({receipts:true}),booking=(await row(saved.bookingId)).payload;assert.equal(payload.referralCode,'FIXTURE');assert.equal(booking.referralCode,'fixture');const result=via==='cron'?await requestFlow('reconcile'):await a1Hook('paypal');saved=(await row(checkout.id)).payload;
    const proofPath=`${artifact}.uppercase-referral-${via}.json`;fs.writeFileSync(proofPath,JSON.stringify({payload,booking,before,result,saved,persisted:await snapshot({receipts:true})},null,2));assert.equal(result.status,200,JSON.stringify(result));assert.equal(saved.status,'booked');assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.verificationState,'server_verified');assert.ok(finalized.body.analyticsReceipt);assert.equal((await sql`select count(*)::integer as count from commerce.bookings`)[0].count,1);return{proofPath,rawReferral:'FIXTURE',storedReferral:'fixture',result,unchangedImmutableIntent:true};
  });
  for(const provider of ['paypal','razorpay','free','dodo'])await run(`a1-${provider}-email-failure-completion-and-retry`,async()=>{
    const checkout=await a1Start(provider,'email-failure');const first=provider==='free'?checkout.started:provider==='dodo'?await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof}):await a1Hook(provider);
    const pending=(await row(checkout.id)).payload,proofPath=`${artifact}.${provider}-email-failure.json`;fs.writeFileSync(proofPath,JSON.stringify({first,pending,persisted:await snapshot({receipts:true}),providerRequests},null,2));
    assert.equal(first.status,200,JSON.stringify(first));assert.equal(pending.status,'email_partial');assert.equal(pending.emailDispatchRequired,true);assert.equal(pending.emailDispatch.allSent,false);assert.equal(pending.verificationState,provider==='free'?'':'server_verified');assert.ok(first.body.analyticsReceipt);assert.equal(pending.recoveryAttemptCount,0);
    const booking=(await row(pending.bookingId)).payload;emailFailure=false;await commerce.patch(booking._id).ifRevisionId(booking._rev).set({emailDispatchNextAttemptAt:new Date(originalNow()-1000).toISOString()}).commit();
    const recovered=await requestFlow('reconcile'),saved=(await row(checkout.id)).payload;assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(saved.status,'booked');assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.emailDispatch.allSent,true);assert.equal(saved.verificationState,provider==='free'?'':'server_verified');assert.equal(saved.recoveryAttemptCount,0);
    fs.writeFileSync(proofPath,JSON.stringify({first,pending,recovered,saved,persisted:await snapshot({receipts:true}),providerRequests,clockStandIn:'Only synthetic source next-attempt timestamp made due after explicit HTTP 503; PostgreSQL/SDK recovery is actual'},null,2));return{proofPath,first,recovered,verifiedMetadataSurvivesDeliveryFailure:true,actualSdk503:true};
  });
  for(const recovery of [false,true])await run(`a1-terminal-${recovery?'reschedule':'confirmation'}-source-future-schedule-cleared`,async()=>{
    const {sendBookingEmailsForBooking,dispatchRescheduleNotifications}=await import('../src/server/api/ref/bookingEmails.js'),prior=new Date(originalNow()-25*3600000).toISOString(),future=new Date(originalNow()+1800000).toISOString(),prefix=recovery?'recoveryNotification':'emailDispatch';
    const booking={_id:bookingId,_type:'booking',backendOwner:'supabase',cutoverGeneration:0,status:'captured',netAmount:9.99,email:'customer@example.invalid',packageTitle:'Synthetic',...(recovery?{requiresReschedule:true,recoveryOwnerNotifiedAt:new Date().toISOString(),recoveryClientFirstAttemptAt:prior}:{emailDispatchOwnerSentAt:new Date().toISOString(),emailDispatchClientFirstAttemptAt:prior}),[`${prefix}Status`]:'delivery_unknown',[`${prefix}LastAttemptAt`]:prior,[`${prefix}AttemptCount`]:1,[`${prefix}NextAttemptAt`]:future,[`${prefix}LeaseId`]:'stale-owner',[`${prefix}LeaseExpiresAt`]:future};await commerce.create(booking);
    const calls=[];for(let i=0;i<3;i++)calls.push(recovery?await dispatchRescheduleNotifications({bookingId,client:commerce}):await sendBookingEmailsForBooking({bookingId,client:commerce}));const saved=(await row(bookingId)).payload;
    assert.equal(saved[`${prefix}Status`],'delivery_unknown');assert.equal(saved[`${prefix}AttemptCount`],1);assert.equal(saved[`${prefix}NextAttemptAt`],'');assert.equal(saved[`${prefix}LeaseId`],'');assert.equal(saved[`${prefix}LeaseExpiresAt`],'');assert.ok(calls.every(r=>(r.body||r).deliveryUnknown===true&&(r.body||r).retryable===false));assert.equal(providerRequests.filter(r=>r.path==='/emails').length,0);return{booking,calls,saved,actualNativeRevisionGuard:true};
  });
  for(const recovery of [false,true])await run(`a1-terminal-${recovery?'reschedule-':''}ledger-unknown-delivery-disabled`,async()=>{
    const {sendBookingEmailsForBooking,dispatchRescheduleNotifications}=await import('../src/server/api/ref/bookingEmails.js'),prior=new Date(originalNow()-25*3600000).toISOString(),prefix=recovery?'recoveryNotification':'emailDispatch';
    const changes=recovery?{requiresReschedule:true,recoveryNotificationStatus:'delivery_unknown',recoveryNotificationLastError:'email_delivery_unknown',recoveryNotificationLastAttemptAt:prior,recoveryNotificationAttemptCount:1,recoveryClientFirstAttemptAt:prior,recoveryOwnerNotifiedAt:new Date().toISOString()}:{emailDispatchStatus:'delivery_unknown',emailDispatchLastError:'email_delivery_unknown',emailDispatchLastAttemptAt:prior,emailDispatchAttemptCount:1,emailDispatchClientFirstAttemptAt:prior,emailDispatchOwnerSentAt:new Date().toISOString()};
    await seed('dodo','email_partial',{booking:changes});let booking=(await row(bookingId)).payload;await commerce.patch(bookingId).ifRevisionId(booking._rev).set({[`${prefix}Status`]:'partial'}).commit();const previous=process.env.FROM_EMAIL,calls=[];process.env.FROM_EMAIL='';
    try{for(let i=0;i<3;i++)calls.push(recovery?await dispatchRescheduleNotifications({bookingId,client:commerce}):await sendBookingEmailsForBooking({bookingId,client:commerce}));}finally{process.env.FROM_EMAIL=previous;}
    booking=(await row(bookingId)).payload;assert.equal(booking[`${prefix}Status`],'delivery_unknown');assert.equal(booking[`${prefix}NextAttemptAt`],'');assert.equal(booking[`${prefix}AttemptCount`],2);assert.ok(calls.every(r=>(r.body||r).retryable===false&&(r.body||r).deliveryUnknown===true));assert.equal(providerRequests.filter(r=>r.path==='/emails').length,0);
    for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow'])assert.equal((await fixture.client.rpc(rpc)).error,null);return{calls,booking,ledger:await sql`select recipient_type,status,next_attempt_at,lease_id from commerce.email_dispatches`,noProviderAttempt:true};
  });
  await run('a1-completion-backend-ownership-transfer-preserved',async()=>{
    const checkout=await a1Start();let raced=false,transferred;
    fixture.setRequestHook(async(phase,request)=>{
      if(raced||phase!=='before'||!request.body?.p_mutations?.some(m=>m.document?._id===checkout.id&&m.document.emailDispatch?.allSent===true&&m.document.verificationState==='server_verified'))return;
      raced=true;fixture.setRequestHook(null);const current=(await row(checkout.id)).payload;const imported={...current,backendOwner:'sanity',cutoverGeneration:1,_rev:crypto.randomUUID(),fixtureConcurrent:'ownership transferred'};await sql`update migration.source_documents set payload=${sql.json(imported)},source_revision=${imported._rev} where legacy_sanity_id=${current._id}`;assert.equal((await fixture.client.rpc('roo_project_operational_shadow')).error,null);transferred=(await row(current._id)).payload;assert.equal(transferred.backendOwner,'sanity');assert.equal(transferred.cutoverGeneration,1);
    });
    const result=await a1Hook('paypal'),saved=(await row(checkout.id)).payload;assert.equal(raced,true);assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(saved,transferred);return{result,saved,transferred,noCompletionWriteAfterTransfer:true,nativeCompletionRevisionConflict:true,transferStandIn:'Constructed import directly changes the synthetic native source row and runs the actual projector; normal commerce adapter stamps its own authority'};
  });
  await run('a1-completion-newer-email-success-preserved',async()=>{
    const checkout=await a1Start();let raced=false,newer;
    fixture.setRequestHook(async(phase,request)=>{
      if(raced||phase!=='before'||!request.body?.p_mutations?.some(m=>{const d=m.document,last=d?.events?.at(-1);return d?._id===checkout.id&&d.emailDispatch?.allSent===false&&last?.source==='client'&&last?.status==='email_partial';}))return;
      raced=true;fixture.setRequestHook(null);const result=await requestFlow('reconcile');assert.equal(result.status,200,JSON.stringify(result));newer=(await row(checkout.id)).payload;assert.equal(newer.emailDispatch.allSent,true);assert.equal(newer.emailDispatchRequired,false);
    });
    const result=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof}),saved=(await row(checkout.id)).payload;assert.equal(raced,true);assert.equal(result.status,200,JSON.stringify(result));assert.equal(saved.status,'booked');assert.equal(saved.emailDispatchRequired,false);assert.deepEqual(saved.emailDispatch,newer.emailDispatch);assert.equal(result.body.emailDispatch.allSent,true);assert.equal(providerRequests.filter(r=>r.path==='/emails').length,2);assert.equal((await requestFlow('reconcile')).body.summary.scanned,0);return{result,saved,newer,actualConcurrentCronDelivery:true,noNewAutomaticRecovery:true};
  });
  await run('a1-completion-native-revision-retry',async()=>{
    const checkout=await a1Start();let raced=false;
    fixture.setRequestHook(async(phase,request)=>{
      if(raced||phase!=='before'||!request.body?.p_mutations?.some(m=>m.document?._id===checkout.id&&m.document.emailDispatch?.allSent===true&&m.document.verificationState==='server_verified'))return;
      raced=true;fixture.setRequestHook(null);const current=(await row(checkout.id)).payload;await commerce.patch(current._id).ifRevisionId(current._rev).set({fixtureConcurrent:'completion metadata retained'}).commit();
    });
    const result=await a1Hook('paypal'),saved=(await row(checkout.id)).payload;assert.equal(raced,true);assert.equal(result.status,200,JSON.stringify(result));assert.equal(saved.verificationState,'server_verified');assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.fixtureConcurrent,'completion metadata retained');assert.ok(result.body.analyticsReceipt);return{result,saved,nativeCompletionRevisionConflictRetried:true};
  });
  await run('a1-paypal-stale-capture-ui',async()=>{
    const checkout=await a1Start();a1Ui={session:checkout.started.body,done:deferred()};
    process.stdout.write(`A1_UI_URL ${origin}/a1-paypal-stale-capture\n`);
    const timeout=new Promise((_,reject)=>{a1Ui.timer=setTimeout(()=>reject(new Error('Collaborative browser did not run the retained UI scenario within 180 seconds')),180000);});
    let browser;try{browser=await Promise.race([a1Ui.done.promise,timeout]);}finally{clearTimeout(a1Ui.timer);}
    const saved=(await row(checkout.id)).payload,proofPath=`${artifact}.browser.json`;
    fs.writeFileSync(proofPath,JSON.stringify({browser,saved,providerRequests,persisted:await snapshot({receipts:true}),sourceSha256:crypto.createHash('sha256').update(sourceText('src/components/Payment.jsx')).digest('hex')},null,2));
    assert.equal(browser.stale,true);assert.deepEqual(browser.updatesAfterClose,[]);assert.equal(saved.status,'email_partial');assert.equal(saved.verificationState,'server_verified');assert.ok(saved.bookingId);return{proofPath,browser,actualServerFinalizeAfterStaleCapture:true,scope:'Actual Payment.jsx approval and finalization function bodies in a minimal rendered browser fixture; surrounding hooks/router/provider widgets are stand-ins'};
  });
  for(const provider of ['paypal','razorpay'])await run(`a1-${provider}-webhook-first-baseline-control`,async()=>{
    const checkout=await a1Start(provider);const finalized=await a1Hook(provider),saved=(await row(checkout.id)).payload;
    const proofPath=`${artifact}.${provider}-webhook-first.json`;fs.writeFileSync(proofPath,JSON.stringify({finalized,saved},null,2));
    assert.equal(finalized.status,200,JSON.stringify(finalized));assert.equal(saved.status,'booked');assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.verificationState,'server_verified');assert.equal(saved.recoveryAttemptCount,0);assert.equal(saved.emailDispatch.allSent,true);assert.ok(saved.events.some(e=>e.status==='booked'&&e.source==='webhook'));assert.ok(finalized.body.analyticsReceipt);return{proofPath,finalized,saved};
  });
  for(const field of ['unchanged','paypalOrderId','razorpayPaymentId','packageTitle','startTimeUTC','couponCode','packagePrice','email'])await run(`a1-replay-changed-${field}`,async()=>{
    const provider=field==='razorpayPaymentId'?'razorpay':'paypal',checkout=await a1Start(provider);const fin=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof});assert.equal(fin.status,200,JSON.stringify(fin));const saved=(await row(checkout.id)).payload;
    const storedBooking=(await row(saved.bookingId)).payload;const body={...checkout.input.bookingPayload,...storedBooking,paymentProvider:provider,status:'captured',paymentRecordId:saved._id,...checkout.proof};
    const values={paypalOrderId:'other-order',razorpayPaymentId:'other-payment',packageTitle:'Changed Package',startTimeUTC:'2099-01-01T11:00:00.000Z',couponCode:'CHANGED',packagePrice:'$99.99',email:'other@example.invalid'};if(field!=='unchanged')body[field]=values[field];
    const before=await snapshot({receipts:true}),response=await fetch(`${origin}/booking`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body,internal:true})});const result={status:response.status,body:await response.json()};
    if(field==='unchanged'){assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.bookingId,saved.bookingId);assert.equal((await row(saved._id)).payload.verificationState,'server_verified');return{field,result,unchangedImmutableIntentAccepted:true};}
    assert.equal(result.status,409,JSON.stringify(result));assert.ok(!result.body.fixtureError);assert.deepEqual(await snapshot({receipts:true}),before);return{field,value:values[field],result,allPersistenceUnchanged:true};
  });
  for(const state of ['explicit-false','string-false'])await run(`a1-incomplete-email-${state}-not-normalized`,async()=>{
    await seed('paypal','booked',{record:{emailDispatchRequired:true,emailDispatch:{allSent:true,client:{sent:true},owner:{sent:state==='string-false'?'false':false}},pricingSnapshot:{grossAmount:9.99,netAmount:9.99,currency:'USD'}}});
    providerHook=async(request,req,res)=>{if(request.path!=='/v2/checkout/orders/order-fixture')return false;res.writeHead(500,{'content-type':'application/json'});res.end('{}');return true;};
    const before=await snapshot({receipts:true}),result=await requestFlow('reconcile'),saved=await record();assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.summary.normalizedEmailCompletions,0);assert.equal(saved.emailDispatchRequired,true);assert.equal(providerRequests.filter(r=>r.path==='/emails').length,0);return{state,before,result,saved,completeSummaryCannotOverrideRecipientFailure:true};
  });
  for(const [required,authority] of [[true,'current'],[false,'current'],[true,'legacy-cutover'],[true,'missing-owner-cutover'],[true,'larger-dataset']])await run(`a1-stale-email-window-${authority==='current'?(required?'broken-shape':'baseline-control'):authority}`,async()=>{
    const now=originalNow(),cutover=authority.endsWith('cutover');if(authority==='larger-dataset')for(let i=0;i<600;i++)await commerce.create({_id:`paymentRecord.ignored${String(i).padStart(3,'0')}`,_type:'paymentRecord',provider:'paypal',backendOwner:'supabase',cutoverGeneration:0,status:'booked',emailDispatchRequired:false,providerOrderId:`order-ignored${i}`,providerPaymentId:`capture-ignored${i}`,updatedAt:new Date(now-90000000).toISOString(),createdAt:new Date(now-90000000).toISOString(),nextRecoveryAt:''});for(let i=0;i<50;i++)await commerce.create({_id:`paymentRecord.stuck${i}`,_type:'paymentRecord',provider:'paypal',backendOwner:'supabase',cutoverGeneration:0,status:'booked',emailDispatchRequired:required,emailDispatch:{allSent:true,client:{sent:true},owner:{sent:true}},providerOrderId:`order-stuck${i}`,providerPaymentId:`capture-stuck${i}`,bookingId:'',updatedAt:new Date(now-86400000+i*1000).toISOString(),createdAt:new Date(now-90000000).toISOString(),nextRecoveryAt:''});
    const actionable={_id:'paymentRecord.actionable',_type:'paymentRecord',provider:'paypal',backendOwner:'supabase',cutoverGeneration:0,status:'started',emailDispatchRequired:true,emailDispatch:{},providerOrderId:'order-fixture',providerPaymentId:'',bookingId:'',bookingPayload:{packageTitle:'Vertex Essentials',email:'c@example.invalid',startTimeUTC:'2099-01-01T10:00:00.000Z'},pricingSnapshot:{netAmount:9.99,currency:'USD'},providerPublicData:{currency:'USD'},holdSnapshot:{},updatedAt:new Date(now-3600000).toISOString(),createdAt:new Date(now-3600000).toISOString(),lastAttemptAt:new Date(now-3600000).toISOString(),nextRecoveryAt:''};if(!cutover)await commerce.create(actionable);
    if(cutover){await sql`update migration.source_documents set payload=case when ${authority}='legacy-cutover' then jsonb_set(payload,'{backendOwner}','"sanity"'::jsonb) else payload-'backendOwner' end where legacy_sanity_id like 'paymentRecord.stuck%'`;assert.equal((await fixture.client.rpc('roo_project_operational_shadow')).error,null);}
    const previousGeneration=process.env.COMMERCE_FAILOVER_GENERATION,previousClientGeneration=commerce.cutoverGeneration;if(cutover){process.env.COMMERCE_FAILOVER_GENERATION='1';commerce.cutoverGeneration=1;await sql`update migration.commerce_control set generation=1`;await sql`update commerce.payment_records set backend_owner='supabase'`;await commerce.create(actionable);}
    paypalOrder.status='CREATED';paypalOrder.purchase_units[0].payments={captures:[]};const before=await snapshot({receipts:true}),result=await requestFlow('reconcile').finally(async()=>{process.env.COMMERCE_FAILOVER_GENERATION=previousGeneration;commerce.cutoverGeneration=previousClientGeneration;if(cutover)await sql`update migration.commerce_control set generation=0`;}),saved=(await row('paymentRecord.actionable')).payload;
    const proofPath=`${artifact}.window-${required}-${authority}.json`;fs.writeFileSync(proofPath,JSON.stringify({before,result,saved,after:await snapshot({receipts:true})},null,2));assert.equal(result.status,200,JSON.stringify(result));assert.equal(saved.status,'abandoned');assert.equal(result.body.summary.abandoned,1);return{proofPath,result,saved,cutoverStandIn:!cutover?null:'Synthetic aligned database/application generation 1 with native typed authority Supabase and imported legacy/missing embedded source owner; actual native normalization and abandonment'};
  });
  for(const provider of ['paypal','razorpay'])await run(`a1-${provider}-terminal-email-cron-25h-three-calls-rebuild`,async()=>{
    const checkout=await a1Start(provider);const fin=await requestFlow('finalize',{paymentAccessToken:checkout.started.body.paymentAccessToken,body:checkout.proof});assert.equal(fin.status,200,JSON.stringify(fin));const payment=(await row(checkout.id)).payload,booking=(await row(payment.bookingId)).payload;
    const prior=new Date(originalNow()-25*3600000).toISOString();await commerce.patch(booking._id).ifRevisionId(booking._rev).set({emailDispatchStatus:'delivery_unknown',emailDispatchLastError:'email_delivery_unknown',emailDispatchLastAttemptAt:prior,emailDispatchAttemptCount:1,emailDispatchClientFirstAttemptAt:prior,emailDispatchOwnerSentAt:new Date().toISOString()}).commit();
    const calls=[];for(let i=0;i<3;i++)calls.push(await requestFlow('reconcile'));const saved=(await row(checkout.id)).payload,source=(await row(booking._id)).payload;
    const proofPath=`${artifact}.${provider}-terminal-cron.json`;fs.writeFileSync(proofPath,JSON.stringify({prior,calls,saved,source,persisted:await snapshot({receipts:true})},null,2));
    assert.ok(calls.every(r=>r.status===200));assert.equal(saved.status,'booked');assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.emailDeliveryReviewRequired,true);assert.equal(saved.recoveryReason,'booking_email_delivery_review_required');assert.equal(saved.nextRecoveryAt,'');assert.equal(source.emailDispatchStatus,'delivery_unknown');assert.equal(source.emailDispatchAttemptCount,1);assert.equal(calls[1].body.summary.scanned,0);assert.equal(calls[2].body.summary.scanned,0);
    for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){assert.equal((await fixture.client.rpc(rpc)).error,null);const ledger=await sql`select recipient_type,status,next_attempt_at from commerce.email_dispatches where booking_id=(select id from commerce.bookings where legacy_sanity_id=${booking._id})`;assert.equal(ledger.find(r=>r.recipient_type==='customer').status,'historical_unknown');assert.equal(ledger.find(r=>r.recipient_type==='owner').status,'sent');assert.ok(ledger.every(r=>r.next_attempt_at===null));}
    assert.equal(providerRequests.filter(r=>r.path==='/emails').length,0);return{proofPath,calls,saved,source,noProviderAttempt:true};
  });
  for(const mode of ['revision-conflict','poison-bounded','poison-negative-count','poison-nonnumeric-count'])await run(`a1-batch-${mode}`,async()=>{
    const now=originalNow(),base={_type:'paymentRecord',provider:'paypal',backendOwner:'supabase',cutoverGeneration:0,status:'started',providerOrderId:'order-fixture',providerPaymentId:'',bookingId:'',bookingPayload:{packageTitle:'Fixture Payment',email:'customer@example.invalid',startTimeUTC:'2099-01-01T10:00:00.000Z'},pricingSnapshot:{netAmount:9.99,currency:'USD'},providerPublicData:{currency:'USD'},holdSnapshot:{},updatedAt:new Date(now-3600000).toISOString(),createdAt:new Date(now-3600000).toISOString(),lastAttemptAt:new Date(now-3600000).toISOString(),nextRecoveryAt:''};
    await commerce.create({...base,_id:'paymentRecord.poison',...(mode==='poison-negative-count'?{recoveryAttemptCount:-100}:mode==='poison-nonnumeric-count'?{recoveryAttemptCount:'corrupt'}:{}),...(mode==='revision-conflict'?{provider:'dodo',providerPublicData:{currency:'USD',totalAmount:999,productId:'pdt_fixture'}}:{})});dodoPayment.metadata={paymentRecordId:'paymentRecord.poison'};dodoPayment.total_amount=1000;await commerce.create({...base,_id:'paymentRecord.after-poison',providerOrderId:'',updatedAt:new Date(now-3500000).toISOString()});
    paypalOrder.status='CREATED';paypalOrder.purchase_units[0].payments={captures:[]};let failures=0;
    const hook=async(phase,request)=>{
      const mutation=request.body?.p_mutations?.find(m=>m.document?._id==='paymentRecord.poison'&&m.document.status===(mode==='revision-conflict'?'needs_recovery':'abandoned'));
      if(phase!=='before'||!mutation)return;
      failures++;
      if(mode!=='revision-conflict')throw new Error('Synthetic per-record storage failure before terminal patch');
      fixture.setRequestHook(null);const current=(await row('paymentRecord.poison')).payload;await commerce.patch(current._id).ifRevisionId(current._rev).set({fixtureConcurrent:'owner retained'}).commit();
    };fixture.setRequestHook(hook);
    const calls=[];let logicalNow=now;
    for(let i=0;i<(mode==='revision-conflict'?1:13);i++){
      globalThis.Date=class extends originalDate{constructor(...args){super(...(args.length?args:[logicalNow]));}static now(){return logicalNow;}};
      const result=await requestFlow('reconcile'),saved=(await row('paymentRecord.poison')).payload;calls.push({result,saved,other:(await row('paymentRecord.after-poison')).payload});
      if(saved.nextRecoveryAt&&saved.reconciliationRecoveryTerminal!==true)logicalNow=new originalDate(saved.nextRecoveryAt).getTime()+1000;
    }
    const proofPath=`${artifact}.batch-${mode}.json`;fs.writeFileSync(proofPath,JSON.stringify({calls,failures,persisted:await snapshot({receipts:true})},null,2));
    assert.equal(calls[0].result.status,503);assert.equal(calls[0].result.body.summary.failed,1);assert.equal(calls[0].other.status,'abandoned');assert.equal(calls[0].saved.recoveryAttemptCount,1);assert.ok(calls[0].saved.nextRecoveryAt);assert.ok(calls[0].saved.recoveryReason);
    if(mode==='revision-conflict'){assert.equal(calls[0].saved.fixtureConcurrent,'owner retained');assert.equal(failures,1);}
    else{assert.equal(failures,12);assert.equal(calls[11].saved.reconciliationRecoveryTerminal,true);assert.equal(calls[11].saved.nextRecoveryAt,'9999-12-31T23:59:59.999Z');assert.equal(calls[12].result.status,200);assert.equal(calls[12].result.body.summary.scanned,0);assert.equal(calls[12].saved.recoveryAttemptCount,12);}
    return{proofPath,failures,independentRecordProcessed:true,nativeRevisionConflict:mode==='revision-conflict',syntheticStorageFault:mode!=='revision-conflict'};
  });
  await run('a1-batch-failure-checkpoint-ownership-transfer-preserved',async()=>{
    const base={_type:'paymentRecord',backendOwner:'supabase',cutoverGeneration:0,status:'started',providerPaymentId:'',bookingId:'',bookingPayload:{packageTitle:'Fixture Payment',email:'customer@example.invalid',startTimeUTC:'2099-01-01T10:00:00.000Z'},pricingSnapshot:{netAmount:9.99,currency:'USD'},holdSnapshot:{},updatedAt:new Date(originalNow()-3600000).toISOString(),createdAt:new Date(originalNow()-3600000).toISOString(),nextRecoveryAt:''};
    await commerce.create({...base,_id:'paymentRecord.transferred',provider:'dodo',providerOrderId:'order-fixture',providerPublicData:{currency:'USD',totalAmount:999,productId:'pdt_fixture'}});await commerce.create({...base,_id:'paymentRecord.independent',provider:'paypal',providerOrderId:''});dodoPayment.metadata={paymentRecordId:'paymentRecord.transferred'};dodoPayment.total_amount=1000;let transferred;
    fixture.setRequestHook(async(phase,request)=>{if(phase!=='before'||!request.body?.p_mutations?.some(m=>m.document?._id==='paymentRecord.transferred'&&m.document.status==='needs_recovery'))return;fixture.setRequestHook(null);const current=(await row('paymentRecord.transferred')).payload;transferred={...current,backendOwner:'sanity',cutoverGeneration:1,_rev:crypto.randomUUID()};await sql`update migration.source_documents set payload=${sql.json(transferred)},source_revision=${transferred._rev} where legacy_sanity_id=${current._id}`;assert.equal((await fixture.client.rpc('roo_project_operational_shadow')).error,null);});
    const result=await requestFlow('reconcile'),saved=(await row('paymentRecord.transferred')).payload;assert.ok(transferred);assert.equal(result.status,503,JSON.stringify(result));assert.deepEqual(saved,transferred);assert.equal((await row('paymentRecord.independent')).payload.status,'abandoned');return{result,saved,transferred,freshForeignAuthorityPreserved:true,independentRecordProcessed:true,transferStandIn:'Constructed synthetic native import and actual native CAS conflict/projector'};
  });
  await run('a1-route-primary-failure-independent-duties',async()=>{
    let failed=false;fixture.setRequestHook(async(phase,request)=>{if(!failed&&phase==='before'&&(request.path.endsWith('/roo_fetch_recovery_payment_documents')||request.body?.p_document_types?.includes('paymentRecord'))){failed=true;throw new Error('Synthetic primary payment read failure');}});
    const response=await fetch(`${origin}/reconcile-route`,{method:'POST'}),body=await response.json(),proofPath=`${artifact}.route-failure.json`;
    fs.writeFileSync(proofPath,JSON.stringify({status:response.status,body,requestLog:fixture.requestLog},null,2));
    assert.equal(failed,true);assert.equal(response.status,503,JSON.stringify(body));assert.equal(body.ok,false);
    for(const key of ['emailOnlyRecovery','credentialRecovery','rateLimitBucketsCleaned','commerceMetricsCleaned','typedGapSnapshot','reconciliationCheckpoint'])assert.ok(Object.hasOwn(body.summary,key)||Object.hasOwn(body.summary,`${key}Pending`),`Independent duty missing: ${key}`);
    assert.ok(fixture.requestLog.some(r=>r.rpc==='roo_list_email_dispatch_recovery_bookings'));return{proofPath,primaryFailureStillReported:true,independentDutyResults:body.summary};
  });
  for(const kind of ['confirmation','reschedule','dodo-cron','reschedule-cron'])await run(`a1-terminal-email-${kind}-25h-three-calls-rebuild`,async()=>{
    const {sendBookingEmailsForBooking,dispatchRescheduleNotifications}=await import('../src/server/api/ref/bookingEmails.js');
    const prior=new Date(originalNow()-25*3600000).toISOString(),now=new Date().toISOString(),recovery=kind.startsWith('reschedule');
    const changes=recovery?{requiresReschedule:true,recoveryNotificationStatus:'delivery_unknown',recoveryNotificationLastError:'email_delivery_unknown',recoveryNotificationLastAttemptAt:prior,recoveryNotificationAttemptCount:1,recoveryClientFirstAttemptAt:prior,recoveryOwnerNotifiedAt:now}:{emailDispatchStatus:'delivery_unknown',emailDispatchLastError:'email_delivery_unknown',emailDispatchLastAttemptAt:prior,emailDispatchAttemptCount:1,emailDispatchClientFirstAttemptAt:prior,emailDispatchOwnerSentAt:now};
    await seed('dodo','email_partial',{booking:{startTimeUTC:'2026-12-01T00:00:00.000Z',...changes},record:{emailDispatchRequired:!recovery,recoveryNotificationRequired:recovery,requiresReschedule:recovery,emailDispatch:{allSent:false,client:{sent:false},owner:{sent:true}},nextRecoveryAt:''}});
    const ledger=async()=>sql`select dispatch_kind,recipient_type,status,attempt_count,next_attempt_at,lease_id,lease_expires_at from commerce.email_dispatches order by dispatch_kind,recipient_type`;
    const before={source:(await row(bookingId)).payload,ledger:await ledger()},calls=[];
    for(let i=0;i<3;i++){
      const result=kind.endsWith('cron')?await requestFlow('reconcile'):recovery?await dispatchRescheduleNotifications({bookingId,client:commerce}):await sendBookingEmailsForBooking({bookingId,client:commerce});
      calls.push({result,source:(await row(bookingId)).payload,payment:await record(),ledger:await ledger()});
    }
    const proofPath=`${artifact}.terminal-${kind}.json`;fs.writeFileSync(proofPath,JSON.stringify({prior,before,calls},null,2));
    const source=(await row(bookingId)).payload,prefix=recovery?'recoveryNotification':'emailDispatch';assert.equal(source[`${prefix}Status`],'delivery_unknown');assert.equal(source[`${prefix}NextAttemptAt`]||'','');assert.equal(source[`${prefix}AttemptCount`],1);
    for(const call of calls){if(!kind.endsWith('cron')){const result=recovery?call.result:call.result.body;assert.equal(result.retryable,false);assert.equal(result.deliveryUnknown,true);}}
    if(kind.endsWith('cron')){const saved=await record();assert.equal(saved.emailDispatchRequired,false);assert.equal(saved.recoveryNotificationRequired||false,false);assert.equal(saved.emailDeliveryReviewRequired,true);assert.equal(saved.nextRecoveryAt,'');assert.equal(calls[1].result.body.summary.scanned,0);}
    const kindName=recovery?'reschedule':'booking_confirmation';for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){assert.equal((await fixture.client.rpc(rpc)).error,null);const entries=(await ledger()).filter(r=>r.dispatch_kind===kindName);assert.equal(entries.find(r=>r.recipient_type==='customer').status,'historical_unknown');assert.equal(entries.find(r=>r.recipient_type==='owner').status,'sent');assert.ok(entries.every(r=>r.next_attempt_at===null&&r.lease_id===null));}
    assert.equal(providerRequests.filter(r=>r.path==='/emails').length,0);fs.writeFileSync(proofPath,JSON.stringify({prior,before,calls,afterRebuild:await ledger(),source,payment:await record(),providerRequests},null,2));return{proofPath,threeCalls:true,projectionRebuild:true,noProviderAttempt:true};
  });
  for(const provider of ['paypal','razorpay'])await run(`currency-configured-${provider}-start-finalize-rebuild`,async()=>{
    const currency=provider==='paypal'?providers.DEFAULT_PAYPAL_CURRENCY:providers.DEFAULT_RAZORPAY_CURRENCY,expected=providers.toSubunits(9.99,currency);
    assert.equal(currency,provider==='paypal'?'EUR':'KWD','Run this scenario with --currency-config');
    const input=await startInput();input.provider=provider;let orderRequest;
    providerHook=async(request,req,res)=>{
      if(provider==='razorpay'&&request.path.startsWith('/v1/orders?')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({items:[]}));return true;}
      if(request.method!=='POST'||request.path!==(provider==='paypal'?'/v2/checkout/orders':'/v1/orders'))return false;
      orderRequest=request.body;res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(provider==='paypal'?{id:'order-fixture',status:'CREATED'}:{id:'order-fixture',currency,amount:expected,receipt:request.body.receipt,status:'created'}));return true;
    };
    const started=await requestFlow('start',{body:input});assert.equal(started.status,200,JSON.stringify(started));
    const payment=(await commerce.fetch('*[_type == "paymentRecord"]'))[0],id=payment._id;
    const money=async()=>({payment:await sql`select status,currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${id}`,booking:await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=(select payload->>'bookingId' from migration.source_documents where legacy_sanity_id=${id})`});
    const startMoney=await money();const proofPath=`${artifact}.${provider}-start.units.json`;fs.writeFileSync(proofPath,JSON.stringify({started,payment,orderRequest,startMoney},null,2));
    assert.equal(payment.providerPublicData.currency,currency);assert.equal(payment.pricingSnapshot.currency,currency);assert.equal(startMoney.payment[0].currency,currency);assert.equal(Number(startMoney.payment[0].amount_subunits),expected);
    paypalOrder.purchase_units[0].amount.currency_code=currency;paypalOrder.purchase_units[0].payments.captures[0].amount.currency_code=currency;razorpayPayment.currency=currency;razorpayPayment.amount=expected;
    const body=provider==='paypal'?{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}:{razorpayOrderId:'order-fixture',razorpayPaymentId:'payment-fixture',razorpaySignature:crypto.createHmac('sha256','fixture-secret').update('order-fixture|payment-fixture').digest('hex')};
    const finalized=await requestFlow('finalize',{paymentAccessToken:started.body.paymentAccessToken,body});assert.equal(finalized.status,200,JSON.stringify(finalized));
    const incremental=await money();for(const entry of [...incremental.payment,...incremental.booking]){assert.equal(entry.currency,currency);assert.equal(Number(entry.amount_subunits),expected);}assert.equal(incremental.booking.length,1);
    for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){assert.equal((await fixture.client.rpc(rpc)).error,null);assert.deepEqual(await money(),incremental);}
    const before=await snapshot({receipts:true});assert.equal((await requestFlow('finalize',{paymentAccessToken:started.body.paymentAccessToken,body})).status,200);assert.deepEqual(await snapshot({receipts:true}),before);
    fs.writeFileSync(proofPath,JSON.stringify({started,payment,orderRequest,startMoney,finalized,incremental,finalNative:await snapshot({receipts:true}),duplicateUnchanged:true},null,2));return{proofPath,currency,expected,realStart:true,realFinalize:true,allProjectorsAgree:true};
  });
  for(const caller of ['partial-direct','full-direct','reconcile'])await run(`currency-conflicting-booking-${caller}-refused`,async()=>{
    const full=caller==='full-direct',r=await seed('dodo',full?'refunded':'booked',{booking:{currency:'USD'},record:{providerPublicData:{currency:'KWD',totalAmount:9990,environment:'test_mode',productId:'pdt_fixture',taxInclusive:true},refundCurrency:'KWD',refundState:full?'full':'partial',refundProcessedAmountInSubunits:full?9990:4990,refundRequiresBookingSync:true}});
    const before=await snapshot({receipts:true});let response;
    if(caller==='reconcile'){response=await requestFlow('reconcile');assert.equal(response.status,200);assert.equal(response.body.summary.refundsSynced,0);const current=await record();assert.equal(current.providerRecoveryTerminal,true);assert.equal(current.recoveryReason,'payment_currency_mismatch');assert.equal(current.nextRecoveryAt,'');const same=await snapshot({receipts:true});assert.equal((await requestFlow('reconcile')).status,200);assert.deepEqual(await snapshot({receipts:true}),same);}
    else{const {applyBookingRefund}=await import('../src/server/api/ref/bookingRefunds.js');await assert.rejects(applyBookingRefund({client:commerce,paymentRecord:r,refund:full?{full:true,processedAmountInSubunits:9990}:{full:false,totalRefundedAmount:4.99}}),error=>error.code==='payment_currency_mismatch');assert.deepEqual(await snapshot({receipts:true}),before);}
    const after=await snapshot({receipts:true});for(const name of ['bookings','refunds','payment_start_claims','payment_proof_claims','payment_upgrade_locks','slot_holds','slot_claims','coupons','coupon_redemptions','referral_ledger'])assert.deepEqual(after.tables[name],before.tables[name]);assert.equal(providerRequests.length,0);return{response,before,after,noFinancialMutation:true,ownerAlert:caller==='reconcile'?'sanitized logSafeError and terminal/manual recovery':'409/payment_currency_mismatch'};
  });
  for(const provider of ['paypal','razorpay'])await run(`currency-supported-${provider}-missing-quote-refund-replay`,async()=>{
    const currency=provider==='paypal'?'EUR':'KWD',total=providers.toSubunits(9.99,currency),amount=providers.toSubunits(4.99,currency);await seed(provider,'booked',{booking:{currency},record:{providerPublicData:{currency}}});
    paypalCapture.amount.currency_code=currency;razorpayPayment.currency=currency;razorpayPayment.amount=total;
    const refund=provider==='paypal'?{id:'refund-fixture',status:'COMPLETED',supplementary_data:{related_ids:{order_id:'order-fixture',capture_id:'capture-fixture'}},amount:{value:'4.99',currency_code:currency}}:{id:'refund-fixture',payment_id:'payment-fixture',amount,currency,status:'processed'};
    const req=provider==='paypal'?paypalReq('PAYMENT.CAPTURE.REFUNDED',refund):razorReq('refund.processed',{refund:{entity:refund}});const result=await requestFlow(provider,{req});assert.equal(result.status,200,JSON.stringify(result));
    const r=await record(),b=(await row(bookingId)).payload;assert.equal(Object.hasOwn(r.pricingSnapshot,'currency'),false);assert.equal(r.refundCurrency,currency);assert.equal(r.refundProcessedAmountInSubunits,amount);assert.equal(b.status,'captured');
    const rows=async()=>({payment:await sql`select status,currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${recordId}`,booking:await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`,refund:await sql`select status,currency,amount_subunits from commerce.refunds where provider_refund_id='refund-fixture'`});const incremental=await rows();for(const row of [...incremental.payment,...incremental.booking]){assert.equal(row.currency,currency);assert.equal(Number(row.amount_subunits),total);}assert.equal(incremental.refund[0].currency,currency);assert.equal(Number(incremental.refund[0].amount_subunits),amount);
    for(const rpc of ['roo_project_operational_shadow','roo_refresh_operational_shadow']){assert.equal((await fixture.client.rpc(rpc)).error,null);assert.deepEqual(await rows(),incremental);}const before=await snapshot();assert.equal((await requestFlow(provider,{req})).status,200);assert.deepEqual(await snapshot(),before);return{httpStatus:200,provider,currency,missingQuoteCurrencyRetained:true,incremental,providerCurrentStateUsed:true,allProjectorsAgree:true,duplicateUnchanged:true};
  });
  await run('currency-conflicting-booking-admin-full-refused',async()=>{
    await seed('dodo','booked',{booking:{currency:'USD',paymentRecordId:recordId},record:{providerPublicData:{currency:'KWD',totalAmount:9990}}});const before=await snapshot({receipts:true});const {applyBookingStatusTransition}=await import('../src/server/api/ref/bookingRefunds.js');await assert.rejects(applyBookingStatusTransition({client:commerce,bookingId,status:'refunded'}),error=>error.code==='payment_currency_mismatch');assert.deepEqual(await snapshot({receipts:true}),before);return{actualAdminSharedHandler:true,noMutation:true,sourceCurrencyFieldsLoaded:true};
  });
  for(const provider of ['paypal','razorpay'])await run(`currency-frozen-${provider}-order-recovery`,async()=>{
    const currency=provider==='paypal'?'EUR':'KWD',expected=providers.toSubunits(9.99,currency);assert.equal(provider==='paypal'?providers.DEFAULT_PAYPAL_CURRENCY:providers.DEFAULT_RAZORPAY_CURRENCY,'USD','This proves recovery after configuration has changed');
    await seed(provider,'started',{record:{bookingId:'',providerOrderId:'',providerPaymentId:'',providerPublicData:{},pricingSnapshot:{netAmount:9.99,currency},createdAt:new Date(originalNow()-600000).toISOString(),updatedAt:new Date(originalNow()-600000).toISOString(),orderCreationLeaseExpiresAt:'',orderState:'needs_recovery'}});let requestCurrency;
    providerHook=async(request,req,res)=>{
      if(provider==='paypal'&&request.method==='POST'&&request.path==='/v2/checkout/orders'){requestCurrency=request.body.purchase_units[0].amount.currency_code;res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:'order-fixture',status:'CREATED'}));return true;}
      if(provider==='razorpay'&&request.path.startsWith('/v1/orders?')){requestCurrency='KWD';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({items:[{id:'order-fixture',receipt:'fixture-key',amount:expected,currency,status:'created'}]}));return true;}
      if(provider==='paypal'&&request.path==='/v2/checkout/orders/order-fixture'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'order-fixture',status:'CREATED',purchase_units:[{amount:{currency_code:currency,value:'9.99'}}]}));return true;}
      if(provider==='razorpay'&&request.path==='/v1/orders/order-fixture/payments'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({items:[]}));return true;}
      if(provider==='razorpay'&&request.path==='/v1/orders/order-fixture'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'order-fixture',status:'created',amount:expected,amount_paid:0,currency}));return true;}return false;
    };
    const response=await requestFlow('reconcile'),current=await record();assert.equal(response.status,200,JSON.stringify(response));assert.equal(current.providerOrderId,'order-fixture');assert.equal(current.providerPublicData.currency,currency);assert.equal(current.pricingSnapshot.currency,currency);if(provider==='paypal')assert.equal(requestCurrency,currency);const [typed]=await sql`select currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${recordId}`;assert.equal(typed.currency,currency);assert.equal(Number(typed.amount_subunits),expected);return{response,current,typed,currentConfiguredCurrency:'USD',frozenCurrency:currency,actualProviderRecovery:true};
  });
  for(const pathName of ['failure','schedule'])for(const label of ['preflight','release','commit','current-owner','release-captured-b'])await run(`recovery-hold-authority-${pathName}-${label}`,async()=>{
    const capturedB=label==='release-captured-b',boundary=capturedB?'release':label;
    const input=await startInput();paypalOrder.status=pathName==='schedule'?'APPROVED':'CREATED';paypalOrder.purchase_units[0].payments={captures:[]};
    providerHook=async(request,req,res)=>{if(request.path!=='/v2/checkout/orders'||request.method!=='POST')return false;res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:'order-fixture',status:'CREATED'}));return true;};
    const started=await requestFlow('start',{body:input});assert.equal(started.status,200,JSON.stringify(started));
    const initial=(await commerce.fetch('*[_type == "paymentRecord"]'))[0],id=initial._id;
    const holdBefore=(await row('slotHold.fixture')).payload,holdExpiry=new Date(holdBefore.expiresAt).getTime();
    const beforeOffset=holdExpiry-originalNow()+(boundary==='current-owner'||boundary==='commit'?1000:-30000);
    Date.now=()=>originalNow()+beforeOffset;
    const token=tokenFor(initial),aGate=deferred(),paused=deferred(),bGate=deferred(),bStarted=deferred();
    let reads=0,providerResponded=false,barrierResponse=null,operationRead=false,requests=0,b=null,ownerA='',ownerB='',expected=null,after=null;
    providerHook=async(request,req,res)=>{if(request.path!=='/v2/checkout/orders/order-fixture')return false;requests++;
      if(requests===1){providerResponded=true;if(pathName==='schedule')return false;res.writeHead(500,{'content-type':'application/json'});res.end('{}');return true;}
      bStarted.resolve();await bGate.promise;if(capturedB)return false;res.writeHead(500,{'content-type':'application/json'});res.end('{}');return true;};
    if(boundary!=='current-owner')fixture.setRequestHook(async(phase,request)=>{
      if(!providerResponded)return;
      const response=JSON.stringify(request.response||null);
      if(phase==='after'&&response.includes(id)&&response.includes('pricingSnapshot')&&!response.includes('slotHold.fixture\",\"_type\":\"slotHold'))operationRead=true;
      const read=phase==='after'&&Array.isArray(request.response)&&request.response.some(d=>d._id==='slotHold.fixture');
      if(read)reads++;
      const mutation=phase==='before'&&request.body?.p_mutations?.some(m=>m.document?._type==='slotHold'&&m.document.releaseReason==='payment_recovery_hold_expired');
      if((boundary==='preflight'&&read&&reads===1)||(boundary==='release'&&read&&reads===2)||(boundary==='commit'&&mutation)){
        fixture.setRequestHook(null);barrierResponse=read?request.response:request.body;paused.resolve();await aGate.promise;
      }
    });
    const a=requestFlow(pathName==='failure'?'paypal':'reconcile',pathName==='failure'?{req:paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}})}:{});
    let aResult,bResult;
    try{
      if(boundary==='current-owner'){
        aResult=await a;assert.ok(aResult.status<400,JSON.stringify(aResult));
        const current=(await row(id)).payload,hold=(await row('slotHold.fixture')).payload;
        assert.equal(hold.phase,'released');assert.equal(hold.paymentRecordId,'');assert.equal(hold.releaseReason,'payment_recovery_hold_expired');assert.equal(current.holdSnapshot.phase,'released');assert.equal(current.holdSnapshot.slotHoldExpiresAt,hold.expiresAt);assert.equal(String(current.finalizationLeaseId||''),'');
        assert.equal(current.status,pathName==='failure'?'needs_recovery':'started');
        const [typed]=await sql`select phase,payment_record_id,source_revision from commerce.slot_holds where legacy_sanity_id='slotHold.fixture'`;
        assert.equal(typed.phase,'released');assert.equal(typed.payment_record_id,null);assert.equal(typed.source_revision,hold._rev);
        return{httpStatus:aResult.status,actualStart:true,currentOwnerExpiredCleanup:true,typed,sourcePayment:current,sourceHold:hold};
      }
      await Promise.race([paused.promise,a.then(r=>{throw new Error(`A did not pause at ${boundary}: ${JSON.stringify(r)}`);})]);
      ownerA=(await row(id)).payload.finalizationLeaseId||'';if(pathName==='failure')assert.ok(ownerA);
      assert.equal(operationRead,true,'A current payment read must precede the held response');
      Date.now=()=>originalNow()+beforeOffset+91000;
      b=requestFlow('finalize',{paymentAccessToken:token,body:{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}});
      await Promise.race([bStarted.promise,b.then(r=>{throw new Error(`B did not hold verification: ${JSON.stringify(r)}`);})]);
      ownerB=(await row(id)).payload.finalizationLeaseId;assert.ok(ownerB);assert.notEqual(ownerB,ownerA);
      expected=await snapshot();
      if(capturedB){const advance=beforeOffset+91000;globalThis.Date=class extends originalDate{constructor(...args){super(...(args.length?args:[originalNow()+advance]));}static now(){return originalNow()+advance;}};}
      aGate.resolve();aResult=await a;after=await snapshot();
      assert.deepEqual(after,expected);
    }catch(error){error.message=`${error.message.slice(0,1200)}; retained expected/after in proof file`;
      fs.writeFileSync(`${artifact}.${pathName}-${boundary}.race.json`,JSON.stringify({id,ownerA,ownerB,barrierResponse,expected,after,aResult},null,2));throw error;
    }finally{fixture.setRequestHook(null);aGate.resolve();
      if(capturedB){paypalOrder.status='COMPLETED';paypalOrder.purchase_units[0].payments={captures:[{id:'capture-fixture',status:'COMPLETED',amount:{value:'9.99',currency_code:'USD'}}]};}
      bGate.resolve();await a.catch(()=>null);if(b)bResult=await b;
      if(capturedB&&b)fs.writeFileSync(`${artifact}.${pathName}-${label}.continuation.json`,JSON.stringify({id,ownerA,ownerB,aResult,bResult,bFinalSource:(await row(id)).payload,finalNative:await snapshot(),clockStandIn:'Date.now and zero-argument new Date advance consistently for captured B; native PostgreSQL clock unchanged'},null,2));
      globalThis.Date=originalDate;
    }
    if(capturedB){const current=(await row(id)).payload;assert.equal(bResult.status,200,JSON.stringify(bResult));assert.equal(current.status,'email_partial');assert.equal(current.verificationState,'server_verified');assert.ok(bResult.body.analyticsReceipt);assert.equal(current.emailDispatchRequired,true);assert.ok(current.bookingId);assert.equal(current.providerPaymentId,'capture-fixture');assert.equal(current.providerOrderId,'order-fixture');assert.equal(current.finalizationLeaseId,'');assert.equal((await row('slotHold.fixture')).payload.phase,'consumed');const savedBooking=(await row(current.bookingId)).payload;assert.equal(savedBooking.slotReservationState,'reconciled_after_expired_hold');assert.equal(savedBooking.paymentRecordId,id);assert.equal(savedBooking.paymentFinalizationLeaseId,ownerB);assert.equal(savedBooking.paymentProofClaimId,current.paymentProofClaimId);assert.equal(savedBooking.netAmount,9.99);const claim=(await row(current.paymentProofClaimId)).payload;assert.equal(claim.bookingId,current.bookingId);assert.equal(claim.paymentRecordId,id);assert.equal(claim.providerPaymentId,'capture-fixture');assert.equal(providerRequests.filter(r=>r.path.includes('refund')).length,0);}
    return{aHttpStatus:aResult.status,bHttpStatus:bResult?.status,actualStart:true,pathName,boundary,ownerA,ownerB,operationRead,barrierResponse,clockAdvanceAfterHoldReadMs:91000,expectedStateWhileBVerifies:expected,stateAfterAWhileBVerifies:after,fullBusinessSnapshotUnchanged:true,webhookReceiptExcluded:'independent A receipt completion only',capturedBBookedAfterExpiredHold:capturedB,clockStandIn:capturedB?'Date.now and zero-argument new Date advance consistently for captured B; native PostgreSQL clock unchanged':'Date.now only; new Date and PostgreSQL clocks unchanged'};
  });
  for(const currency of ['KWD','USD'])for(const caller of ['reconcile','partial-direct','full-direct'])await run(`dodo-local-refund-units-${currency.toLowerCase()}-${caller}`,async()=>{
    const total=currency==='KWD'?9990:999,refunded=currency==='KWD'?4990:499,amount=4.99;
    const full=caller==='full-direct';
    const r=await seed('dodo',full?'refunded':'booked',{booking:{currency},record:{providerPublicData:{currency,totalAmount:total,environment:'test_mode',productId:'pdt_fixture',taxInclusive:true},refundCurrency:currency,refundState:full?'full':'partial',refundProcessedAmountInSubunits:full?total:refunded,refundRequiresBookingSync:true}});
    const before=await snapshot({receipts:true}),bookingBefore=(await row(bookingId)).payload;
    let result;
    if(caller==='reconcile')result=await requestFlow('reconcile');else{const {applyBookingRefund}=await import('../src/server/api/ref/bookingRefunds.js');const sync=await applyBookingRefund({client:commerce,paymentRecord:r,refund:caller==='full-direct'?{full:true,type:'full',processedAmountInSubunits:total}:{full:false,type:'partial',totalRefundedAmount:amount}});result={status:200,body:{sync}};}
    const bookingAfter=(await row(bookingId)).payload,paymentAfter=await record(),after=await snapshot({receipts:true});
    const proofPath=`${artifact}.${currency.toLowerCase()}-${caller}.units.json`;
    fs.writeFileSync(proofPath,JSON.stringify({result,before,after,bookingBefore,bookingAfter,paymentAfter,providerRequests},null,2));
    assert.equal(result.status,200,JSON.stringify(result));assert.equal(providerRequests.length,0);
    assert.equal(bookingAfter.refundedAmount,caller==='full-direct'?9.99:amount);
    if(full){assert.equal(bookingAfter.status,'refunded');assert.equal(bookingAfter.refundStatus,'full');assert.equal(bookingAfter.netAmount,9.99);assert.equal(bookingAfter.currency,currency);assert.equal(paymentAfter.status,'refunded');assert.equal(paymentAfter.refundState,'full');assert.equal(paymentAfter.refundProcessedAmountInSubunits,total);assert.equal(paymentAfter.refundCurrency,currency);assert.equal(paymentAfter.refundRequiresBookingSync,false);assert.deepEqual(paymentAfter.providerPublicData,r.providerPublicData);const [typed]=await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`;assert.equal(typed.status,'refunded');assert.equal(typed.currency,currency);assert.equal(Number(typed.amount_subunits),total);}
    if(caller!=='full-direct'){
      assert.equal(bookingAfter.dodoTotalAmount,9.99);assert.equal(bookingAfter.commissionAmount,0.5);assert.equal(bookingAfter.dodoOriginalCommissionAmount,1);assert.equal(bookingAfter.status,bookingBefore.status);assert.equal(bookingAfter.netAmount,bookingBefore.netAmount);
      if(caller==='reconcile'){assert.equal(paymentAfter.refundRequiresBookingSync,false);assert.equal(result.body.summary.refundsSynced,1);assert.deepEqual(paymentAfter.providerPublicData,r.providerPublicData);assert.equal(paymentAfter.refundProcessedAmountInSubunits,refunded);assert.equal(paymentAfter.refundCurrency,currency);const same=await snapshot({receipts:true});assert.equal((await requestFlow('reconcile')).status,200);assert.deepEqual(await snapshot({receipts:true}),same);}
      for(const name of ['refunds','payment_start_claims','payment_proof_claims','payment_upgrade_locks','slot_holds','slot_claims','coupons','coupon_redemptions','referral_ledger'])assert.deepEqual(after.tables[name],before.tables[name]);
      const [typed]=await sql`select currency,amount_subunits,booking_payload from commerce.bookings where legacy_sanity_id=${bookingId}`;assert.equal(typed.currency,currency);assert.equal(Number(typed.amount_subunits),total);assert.equal(typed.booking_payload.refundedAmount,amount);assert.equal(typed.booking_payload.dodoTotalAmount,9.99);
    }
    const money=async()=>({payment:await sql`select status,currency,amount_subunits from commerce.payment_records where legacy_sanity_id=${recordId}`,booking:await sql`select status,currency,amount_subunits from commerce.bookings where legacy_sanity_id=${bookingId}`});
    const projected={incremental:await money()};
    assert.equal(Object.hasOwn(r.pricingSnapshot,'currency'),false,'Original deficient quote fixture must remain unchanged');
    for(const entry of [...projected.incremental.payment,...projected.incremental.booking]){assert.equal(entry.currency,currency);assert.equal(Number(entry.amount_subunits),total);}
    for(const [key,rpc] of [['originalFull','roo_project_operational_shadow'],['currentRefresh','roo_refresh_operational_shadow']]){const refreshed=await fixture.client.rpc(rpc);assert.equal(refreshed.error,null);projected[key]=await money();assert.deepEqual(projected[key],projected.incremental);}
    const replayBefore=await snapshot({receipts:true});
    if(caller==='reconcile')assert.equal((await requestFlow('reconcile')).status,200);else{const {applyBookingRefund}=await import('../src/server/api/ref/bookingRefunds.js');await applyBookingRefund({client:commerce,paymentRecord:await record(),refund:full?{full:true,type:'full',processedAmountInSubunits:total}:{full:false,type:'partial',totalRefundedAmount:amount}});}
    assert.deepEqual(await snapshot({receipts:true}),replayBefore);
    fs.writeFileSync(proofPath,JSON.stringify({result,before,after,bookingBefore,bookingAfter,paymentAfter,projected,providerRequests,duplicateUnchanged:true},null,2));
    return{projected,allEntryPointsAgree:true,httpStatus:200,currency,caller,processedSubunits:full?total:refunded,refundedAmount:bookingAfter.refundedAmount,totalAmount:bookingAfter.dodoTotalAmount,providerCalls:0,proofPath,sourceEvidenceRetained:caller==='reconcile',duplicateUnchanged:caller==='reconcile'};
  });
  await run('late-provider-order-failure-after-booking',async()=>{
    const input=await startInput(),gate=deferred(),started=deferred();let creates=0,paymentId='';
    paypalOrder.status='CREATED';paypalOrder.purchase_units[0].payments={captures:[]};
    providerHook=async(request,req,res)=>{if(request.path!=='/v2/checkout/orders'||request.method!=='POST')return false;creates++;if(creates===1){paymentId=request.body.purchase_units[0].custom_id;started.resolve();await gate.promise;req.socket.destroy();return true;}res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:'order-fixture',status:'CREATED'}));return true;};
    const a=requestFlow('start',{body:input});await Promise.race([started.promise,a.then(r=>{throw new Error(`Start did not create an order: ${JSON.stringify(r)}`);})]);
    const initial=(await row(paymentId)).payload;assert.ok(initial.orderCreationLeaseId);Date.now=()=>originalNow()+91000;
    let result,before;
    try{
      const reconciled=await requestFlow('reconcile');assert.equal(reconciled.status,200,JSON.stringify(reconciled));const recovered=(await row(paymentId)).payload;assert.equal(recovered.providerOrderId,'order-fixture');
      const exposed=await requestFlow('start',{body:input});assert.equal(exposed.status,200,JSON.stringify(exposed));assert.equal(exposed.body.providerPayload.orderId,'order-fixture');assert.ok(exposed.body.paymentAccessToken);
      await commerce.patch(paymentId).ifRevisionId(recovered._rev).set({emailDispatch:{allSent:true}}).commit();
      paypalOrder.status='COMPLETED';paypalOrder.purchase_units[0].payments={captures:[{id:'capture-fixture',status:'COMPLETED',amount:{value:'9.99',currency_code:'USD'}}]};
      const booked=await requestFlow('paypal',{req:paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture',supplementary_data:{related_ids:{order_id:'order-fixture'}}})});assert.equal(booked.status,200,JSON.stringify(booked));assert.equal((await row(paymentId)).payload.status,'booked');
      before=await snapshot();gate.resolve();result=await a;assert.deepEqual(await snapshot(),before);
    }finally{gate.resolve();await a;}
    const current=(await row(paymentId)).payload;const [typed]=await sql`select status,provider_order_id,provider_payment_id,booking_id from commerce.payment_records where legacy_sanity_id=${paymentId}`;assert.equal(typed.status,'booked');return{oldStartHttpStatus:result.status,currentStatus:current.status,typed,orderRecoveredExposedAndCaptured:true,clockAdvanceMs:91000,emailDeliveryStandIn:'historical emailDispatch.allSent=true source fixture, no external delivery'};
  });
  for(const mode of ['terminal','before-booking-commit','current-owner'])await run(mode==='current-owner'?'current-owner-finalization-booking-handoff':`finalization-lease-takeover-during-booking-${mode}`,async()=>{
    const input=await startInput();providerHook=async(request,req,res)=>{if(request.path!=='/v2/checkout/orders'||request.method!=='POST')return false;res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:'order-fixture',status:'CREATED'}));return true;};
    paypalOrder.status='CREATED';paypalOrder.purchase_units[0].payments={captures:[]};const started=await requestFlow('start',{body:input});assert.equal(started.status,200,JSON.stringify(started));const id=(await commerce.fetch('*[_type == "paymentRecord"]'))[0]._id;assert.ok(id);const token=started.body.paymentAccessToken;
    paypalOrder.status='COMPLETED';paypalOrder.purchase_units[0].payments={captures:[{id:'capture-fixture',status:'COMPLETED',amount:{value:'9.99',currency_code:'USD'}}]};
    if(mode==='current-owner'){
      const finalized=await requestFlow('finalize',{paymentAccessToken:token,body:{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}});assert.equal(finalized.status,200,JSON.stringify(finalized));const r=(await row(id)).payload;assert.equal(r.status,'email_partial');assert.equal(r.verificationState,'server_verified');assert.ok(finalized.body.analyticsReceipt);assert.equal(r.emailDispatchRequired,true);assert.ok(r.emailDispatchToken);assert.equal(r.finalizationLeaseId,'');const [typed]=await sql`select status,booking_id,email_dispatch_required,source_revision from commerce.payment_records where legacy_sanity_id=${id}`;assert.equal(typed.status,'email_partial');assert.equal(typed.email_dispatch_required,true);return{httpStatus:200,status:r.status,typed,guardedBookingHandoffRecognized:true,deferredEmailNoDelivery:true};
    }
    const gate=deferred(),paused=deferred(),bGate=deferred(),bStarted=deferred();let held=false;
    fixture.setRequestHook(async(phase,request)=>{
      if(held||!request.path.endsWith('/roo_apply_commerce_document_mutations'))return;
      const matches=mode==='terminal'?phase==='after'&&JSON.stringify(request.response).includes('server_verified')&&JSON.stringify(request.response).includes('paymentProofClaimId'):phase==='before'&&request.body.p_mutations?.some(m=>m.document?._type==='booking');
      if(!matches)return;held=true;fixture.setRequestHook(null);paused.resolve();await gate.promise;
    });
    const a=requestFlow('finalize',{paymentAccessToken:token,body:{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}});await Promise.race([paused.promise,a.then(r=>{throw new Error(`A did not pause in booking ${JSON.stringify(r)}`);})]);const ownerA=(await row(id)).payload.finalizationLeaseId;assert.ok(ownerA);Date.now=()=>originalNow()+91000;
    let heldProviderRequests=0;providerHook=async(request,req,res)=>{if(request.path!=='/v2/checkout/orders/order-fixture'||++heldProviderRequests!==1)return false;bStarted.resolve();await bGate.promise;res.writeHead(500,{'content-type':'application/json'});res.end('{}');return true;};
    const b=requestFlow('finalize',{paymentAccessToken:token,body:{paypalOrderId:'order-fixture',paypalPaymentId:'capture-fixture'}});await Promise.race([bStarted.promise,b.then(r=>{throw new Error(`B did not hold verification ${JSON.stringify(r)}`);})]);const ownerB=(await row(id)).payload.finalizationLeaseId;assert.notEqual(ownerB,ownerA);const before=await snapshot({receipts:true});let result;
    try{gate.resolve();result=await a;assert.deepEqual(await snapshot({receipts:true}),before);}finally{gate.resolve();bGate.resolve();await a;await b;}
    return{obsoleteHttpStatus:result.status,ownerA,ownerB,fullSnapshotUnchangedBeforeBRelease:true,expectedStateWhileBVerifies:before,clockAdvanceMs:91000,actualNativeBookingCas:mode==='before-booking-commit'};
  });
  await run('start-other-provider-same-reservation-refused', async () => {
    const input = await startInput();
    providerHook = async (request, req, res) => {
      if (request.method !== 'POST' || request.path !== '/v2/checkout/orders') return false;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'order-fixture', status: 'CREATED' }));
      return true;
    };
    const first = await requestFlow('start', { body: input });
    assert.equal(first.status, 200, JSON.stringify(first));
    const before = await snapshot({ receipts: true });
    const requestsBefore = providerRequests.length;
    const second = await requestFlow('start', { body: { ...input, provider: 'razorpay' } });
    assert.equal(second.status, 409, JSON.stringify(second));
    assert.deepEqual(await snapshot({ receipts: true }), before);
    assert.equal(providerRequests.length, requestsBefore);
    return { firstStatus: first.status, second, secondProviderOrderRequests: 0, unchanged: true };
  });
  for(const revisionState of ['absent','null'])await run(`missing-start-hold-authorizing-revision${revisionState==='null'?'-null':''}`,async()=>{
    const input=await startInput();await removeRevision('slotHold.fixture',revisionState);let raced=false,before;
    fixture.setRequestHook(async(phase,request)=>{if(phase!=='after'||raced||!JSON.stringify(request.response).includes('fixture-hold-owner'))return;raced=true;fixture.setRequestHook(null);await commerce.patch('slotHold.fixture').set({holdNonce:'newer-hold-owner'}).commit();before=await snapshot();});
    const result=await requestFlow('start',{body:input});assert.equal(raced,true);assert.ok(result.status>=400);assert.deepEqual(await snapshot(),before);assert.equal(providerRequests.filter(r=>r.path==='/v2/checkout/orders').length,0);return{httpStatus:result.status,revisionState,newerHoldOwnerRetained:true,noClaimRecordProviderCreation:true};
  });
  for(const revisionState of ['absent','null'])await run(`missing-release-hold-authorizing-revision${revisionState==='null'?'-null':''}`,async()=>{
    const r=await seed('paypal','started',{record:{bookingId:'',holdSnapshot:{slotHoldId:'slotHold.fixture',slotHoldExpiresAt:new Date(originalNow()-1000).toISOString()}}});paypalOrder.status='CREATED';paypalOrder.purchase_units[0].payments={captures:[]};
    await commerce.create({_id:'slotHold.fixture',_type:'slotHold',backendOwner:'supabase',cutoverGeneration:0,startTimeUTC:'2099-01-01T10:00:00.000Z',packageTitle:'Vertex Essentials',phase:'holding',paymentRecordId:recordId,paymentProvider:'paypal',holdNonce:'old-release-owner',expiresAt:new Date(originalNow()+30000).toISOString()});await commerce.patch('slotHold.fixture').set({phase:'payment_pending'}).commit();await removeRevision('slotHold.fixture',revisionState);let raced=false,before;
    fixture.setRequestHook(async(phase,request)=>{if(phase!=='after'||raced||!JSON.stringify(request.response).includes('old-release-owner'))return;raced=true;fixture.setRequestHook(null);await commerce.patch('slotHold.fixture').set({holdNonce:'newer-release-owner',expiresAt:new Date(originalNow()+120000).toISOString()}).commit();before=await snapshot();});
    Date.now=()=>originalNow()+91000;const result=await requestFlow('cancel',{paymentAccessToken:tokenFor(r)});assert.equal(raced,true);assert.deepEqual(await snapshot(),before);assert.notEqual((await row('slotHold.fixture')).payload.phase,'released');return{httpStatus:result.status,revisionState,newerHoldOwnerRetained:true};
  });
  for(const target of ['payment','booking'])for(const revisionState of ['absent','null'])await run(`missing-dodo-dispute-${target}-authorizing-revision${revisionState==='null'?'-null':''}`,async()=>{
    await seed('dodo');const id=target==='payment'?recordId:bookingId;await removeRevision(id,revisionState);dodoPayment.disputes=[{amount:'9.99',business_id:'business-fixture',created_at:'2026-01-01T00:00:00.000Z',currency:'USD',dispute_id:'dispute-fixture',dispute_stage:'dispute',dispute_status:'dispute_opened',payment_id:'payment-fixture'}];let raced=false,before;
    fixture.setRequestHook(async(phase,request)=>{if(phase!=='after'||raced||!Array.isArray(request.response)||!request.response.some(d=>d._id===id&&d._rev==null))return;raced=true;fixture.setRequestHook(null);await commerce.patch(id).set(target==='payment'?{status:'booked',finalizationLeaseId:'newer-dispute-owner'}:{status:'completed',commissionAmount:7,fixtureConcurrentEdit:'newer-dispute-owner'}).commit();before=await snapshot();});
    const result=await requestFlow('dodo',{req:dodoReq()});assert.equal(raced,true);assert.deepEqual(await snapshot(),before);assert.ok(result.status>=400);return{httpStatus:result.status,revisionState,missingRevision:target,currentFinancialStatePreserved:true};
  });
  await run('unlink-projected-provider',async()=>{
    const userId='11111111-1111-4111-8111-111111111111',email='fixture@example.invalid';
    const {functionDefinition}=await import('./lib/sweep-postgres-fixture.mjs');const domain='20260726051500_scope_identity_links_by_domain.sql';
    await fixture.apply(domain,fs.readFileSync(path.join(process.cwd(),'supabase/migrations',domain),'utf8').split('-- Domain-scoped reconciliation.')[0],'actual current domain identity DDL/indexes/helper prefix');
    const retired='20260914010000_preserve_retired_tourney_identity_domains.sql';await fixture.apply(retired,functionDefinition(retired,'accounts.principal_domain'),'current actual domain helper; unrelated retired-account saga excluded');
    await sql`insert into auth.users(id,email,email_confirmed_at) values(${userId}::uuid,${email},now())`;
    await sql`insert into public.profiles(user_id,primary_email,display_name,status,legacy_sanity_id) values(${userId}::uuid,${email},'Fixture','active','referral.fixture')`;
    await sql`insert into accounts.creator_profiles(user_id,referral_code,legacy_sanity_id,active) values(${userId}::uuid,'fixture','referral.fixture',true)`;
    await sql`insert into accounts.account_roles(user_id,role) values(${userId}::uuid,'creator')`;
    await sql`insert into accounts.identity_links(user_id,provider,provider_subject,domain) values(${userId}::uuid,'email',${email},'referral'),(${userId}::uuid,'google','projected-google-fixture','referral')`;
    const secret='fixture-auth-signing';const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:`${fixture.origin}/auth/v1`,sub:userId,role:'authenticated',aud:'authenticated',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,session_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).toString('base64url');const token=`${head}.${claims}.${crypto.createHmac('sha256',secret).update(`${head}.${claims}`).digest('base64url')}`;
    authUser={id:userId,email,aud:'authenticated',role:'authenticated',identities:[{id:'email-fixture',identity_id:'email-fixture',user_id:userId,provider:'email',identity_data:{email}}],app_metadata:{provider:'email'},user_metadata:{}};
    let authGets=0;fixture.setAuthHandler(async request=>{if(request.path==='/auth/v1/user'){authGets++;return{body:authUser};}if(request.method==='DELETE'){authUnlinks++;return{body:{}};}throw new Error(`Unexpected Auth request ${request.method} ${request.path}`);});
    const previousFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);if(url.origin===fixture.origin&&url.pathname==='/auth/v1/user'){const headers=new Headers(init?.headers||input?.headers);const supplied=headers.get('authorization')?.replace(/^Bearer /,'');assert.equal(supplied,token);const parts=supplied.split('.');assert.equal(parts[2],crypto.createHmac('sha256',secret).update(`${parts[0]}.${parts[1]}`).digest('base64url'));}return previousFetch(input,init);};
    try{
      const ssr=await import('../src/server/supabase/serverSession.js');const headers=new Map(),res={getHeader:k=>headers.get(k),setHeader:(k,v)=>headers.set(k,v)};await ssr.installLegacySupabaseSession({req:{headers:{}},res,session:{access_token:token,refresh_token:'fixture-refresh'}});const authCookie=[].concat(headers.get('Set-Cookie')||[]).map(v=>v.split(';')[0]).join('; ');assert.ok(authCookie);
      const auth=await import('../src/server/api/ref/auth.js');const domainCookie=auth.createReferralSessionCookie({referralId:'referral.fixture',code:'fixture',authBackend:'supabase',principalId:userId,sessionVersion:1});
      const account=await fixture.client.rpc('roo_account_by_user_id',{p_user_id:userId});assert.equal(account.error,null);assert.deepEqual(account.data.connected_providers,['email','google']);
      const accountSnapshot=async()=>({principals:await sql`select * from accounts.principals order by id`,profiles:await sql`select * from public.profiles order by user_id`,mappings:await sql`select * from accounts.principal_auth_users order by user_id`,creators:await sql`select * from accounts.creator_profiles order by user_id`,links:await sql`select * from accounts.identity_links order by id`,roles:await sql`select * from accounts.account_roles order by user_id,role`,authIdentities:await sql`select * from auth.identities order by id`});
      const before=await accountSnapshot();const response=await fetch(`${origin}/identities`,{method:'POST',headers:{'content-type':'application/json',origin,cookie:`${authCookie}; ${domainCookie.name}=${domainCookie.value}; roo_reauth_grant=fixture-proof`},body:JSON.stringify({flow:'referral',provider:'google'})});const body=await response.json();assert.equal(response.status,409,JSON.stringify(body));assert.equal(body.ok,false);assert.match(body.error,/another sign-in account/);assert.equal(authUnlinks,0);assert.deepEqual(await accountSnapshot(),before);assert.ok(authGets>=2);return{httpStatus:409,actualSsrCookieSelection:true,actualAuthGetCount:authGets,authUnlinks:0,currentAccountDomainIdentityUnchanged:true,projectedProviders:account.data.connected_providers,authProviders:authUser.identities.map(i=>i.provider)};
    }finally{globalThis.fetch=previousFetch;}
  });
  await run('terminal-finalize-different-proof',async()=>{const r=await seed();const before=await snapshot({receipts:true});const result=await requestFlow('finalize',{paymentAccessToken:tokenFor(r),body:{paypalOrderId:'other-order'}});assert.equal(result.status,409);assert.deepEqual(await snapshot({receipts:true}),before);return{httpStatus:409,noMutation:true};});
  for(const variant of ['up-link','reversal-resource-capture'])await run(`paypal-${variant==='up-link'?'refund-up-link':'reversal-resource-capture'}`,async()=>{
    await seed('paypal','booked',{record:variant==='up-link'?{providerPaymentId:''}:{}});const resource=variant==='up-link'?{id:'refund-fixture',status:'COMPLETED',amount:{value:'9.99',currency_code:'USD'},links:[{rel:'up',method:'GET',href:'https://api-m.paypal.com/v2/payments/captures/capture-fixture'}]}:{id:'capture-fixture',status:'REFUNDED',amount:{value:'9.99',currency_code:'USD'}};
    const req=paypalReq(variant==='up-link'?'PAYMENT.CAPTURE.REFUNDED':'PAYMENT.CAPTURE.REVERSED',resource);const result=await requestFlow('paypal',{req});assert.equal(result.status,200,JSON.stringify(result));const proof=await assertRefund({reversed:variant==='reversal-resource-capture'});const before=await snapshot();assert.equal((await requestFlow('paypal',{req})).status,200);assert.deepEqual(await snapshot(),before);return{...proof,idempotentReplay:true};
  });
  await run('paypal-refund-missing-identity',async()=>{await seed();const before=await snapshot();const result=await requestFlow('paypal',{req:paypalReq('PAYMENT.CAPTURE.REFUNDED',{id:'refund-fixture',status:'COMPLETED',amount:{value:'9.99',currency_code:'USD'}})});assert.ok(result.status>=400);assert.deepEqual(await snapshot(),before);return{httpStatus:result.status,paymentBookingClaimsOutboxUnchanged:true,receiptLifecycle:'error receipt processed by existing handler'};});
  for(const code of [500,429,'disconnect'])await run(`paypal-webhook-verification-${code}`,async()=>{verificationStatus=code==='disconnect'?200:code;verificationDisconnect=code==='disconnect';const before=await snapshot({receipts:true});const result=await requestFlow('paypal',{req:paypalReq('PAYMENT.CAPTURE.COMPLETED',{id:'capture-fixture'})});assert.equal(result.status,503);assert.deepEqual(await snapshot({receipts:true}),before);return{httpStatus:503,noMutation:true};});
  await run('refund-order-payment-disagreement',async()=>{await seed();const before=await snapshot();const result=await requestFlow('paypal',{req:paypalReq('PAYMENT.CAPTURE.REFUNDED',{id:'refund-fixture',status:'COMPLETED',supplementary_data:{related_ids:{order_id:'order-fixture',capture_id:'other-capture'}},amount:{value:'9.99',currency_code:'USD'}})});assert.equal(result.status,409);assert.deepEqual(await snapshot(),before);return{httpStatus:409,paymentBookingClaimsOutboxUnchanged:true};});
  await run('refund-requires-present-currency',async()=>{await seed('razorpay','booked',{record:{providerPublicData:{}}});const before=await snapshot();const refund={id:'refund-fixture',payment_id:'payment-fixture',amount:999,currency:'',status:'processed'};const result=await requestFlow('razorpay',{req:razorReq('refund.processed',{refund:{entity:refund}})});assert.equal(result.status,409);assert.deepEqual(await snapshot(),before);return{httpStatus:409,paymentBookingClaimsOutboxUnchanged:true};});
  for(const action of ['finalize','cancel','reconcile'])await run(action==='finalize'?'dodo-full-refund-summary-without-items':action==='cancel'?'dodo-cancel-full-refund-summary':'dodo-reconcile-finalizing-full-refund-summary',async()=>{
    const r=await seed('dodo',action==='reconcile'?'finalizing':'started',{record:{bookingId:'',emailDispatchRequired:false,createdAt:new Date(originalNow()-600000).toISOString(),finalizationLeaseExpiresAt:''}});dodoPayment.refund_status='full';const before=await snapshot({receipts:true});const beforeBooking=(await row(bookingId)).payload;const beforeClaims=await sql`select * from commerce.payment_proof_claims`;const result=await requestFlow(action,action==='reconcile'?{}:{paymentAccessToken:tokenFor(r),body:{}});if(action==='reconcile')assert.equal(result.status,200);const saved=await record();assert.notEqual(saved.verificationState,'server_verified');assert.notEqual(saved.status,'booked');assert.notEqual(saved.status,'email_partial');assert.deepEqual((await row(bookingId)).payload,beforeBooking);assert.deepEqual(await sql`select * from commerce.payment_proof_claims`,beforeClaims);const [typed]=await sql`select payment.status,payment.finalization_lease_id,payment.source_revision,source.payload->>'verificationState' as source_verification_state from commerce.payment_records payment join migration.source_documents source using(legacy_sanity_id) where payment.legacy_sanity_id=${recordId}`;assert.notEqual(typed.source_verification_state,'server_verified');const after=await snapshot({receipts:true});
    if(action==='finalize')assert.deepEqual(after,before);else{
      const omit=(value,fields)=>Object.fromEntries(Object.entries(value).filter(([key])=>!fields.includes(key)));
      const allowedSource=['_rev','_updatedAt','updatedAt','status','finalizationLeaseId','finalizationLeaseExpiresAt','attemptCount','lastAttemptAt','source','events','recoveryReason','recoveryAttemptCount','recoveryFailureCount','reconciliationRecoveryTerminal','nextRecoveryAt'];
      const prior=before.source.find(s=>s.legacy_sanity_id===recordId),next=after.source.find(s=>s.legacy_sanity_id===recordId);assert.deepEqual(omit(next.payload,allowedSource),omit(prior.payload,allowedSource));assert.deepEqual(after.source.filter(s=>s.legacy_sanity_id!==recordId),before.source.filter(s=>s.legacy_sanity_id!==recordId));
      const allowedTyped=['status','quote_fingerprint','recovery_attempt_count','next_recovery_at','source_revision','source_hash','source_updated_at','updated_at','imported_at'];assert.deepEqual(omit(after.tables.payment_records[0].row,allowedTyped),omit(before.tables.payment_records[0].row,allowedTyped));assert.equal(before.tables.payment_records[0].row.quote_fingerprint,`legacy:${before.tables.payment_records[0].row.source_hash}`);assert.equal(after.tables.payment_records[0].row.quote_fingerprint,`legacy:${after.tables.payment_records[0].row.source_hash}`);
      for(const name of ['bookings','refunds','payment_start_claims','payment_proof_claims','payment_upgrade_locks','slot_holds','slot_claims','document_outbox','webhook_receipts'])assert.deepEqual(after.tables[name],before.tables[name]);
      for(const priorRow of before.tables.commerce_outbox)assert.deepEqual(after.tables.commerce_outbox.find(r=>r.row.id===priorRow.row.id),priorRow);
      const newOutbox=after.tables.commerce_outbox.filter(r=>!before.tables.commerce_outbox.some(p=>p.row.id===r.row.id));if(fullChain)assert.equal(newOutbox.length,0);else assert.ok(newOutbox.length);for(const {row:outbox} of newOutbox){assert.deepEqual(outbox.deleted_ids,[]);assert.equal(outbox.documents.length,1);assert.equal(outbox.documents[0]._id,recordId);assert.notEqual(outbox.documents[0].verificationState,'server_verified');}
      assert.equal(saved.recoveryFailureCount,1);assert.equal(saved.reconciliationRecoveryTerminal,false);
      assert.equal(saved.status,'needs_recovery');assert.equal(saved.recoveryReason,'dodo_refund_requires_reconciliation');assert.ok(saved.events.every(e=>!['provider_capture_verified','refund_full'].includes(e.reason)));
    }return{httpStatus:result.status,status:saved.status,typed,noBookingGrant:true,claimsUnchanged:true,fullPersistenceUnchanged:action==='finalize',allowedRecoveryDiagnosticsOnly:action!=='finalize',sourceAndTypedFinancialStateAndResourcesUnchanged:true,typedLegacyQuoteFingerprintFollowsSourceHash:true};
  });
  await run('dodo-optional-refund-fields-retrieve-detail',async()=>{await seed('dodo');dodoPayment.refund_status='full';dodoPayment.refunds=[{...dodoRefund,amount:null,currency:null}];const req=dodoReq();assert.equal((await requestFlow('dodo',{req})).status,200);const proof=await assertRefund();assert.ok(providerRequests.some(r=>r.path==='/refunds/refund-fixture'));const before=await snapshot();assert.equal((await requestFlow('dodo',{req})).status,200);assert.deepEqual(await snapshot(),before);return{...proof,actualDodoRefundGet:true,idempotentReplay:true};});
  await run('dodo-optional-refund-fields-bounded-manual-recovery',async()=>{await seed('dodo');dodoRefund.amount=null;dodoRefund.currency=null;dodoRefund.is_partial=true;dodoPayment.refund_status='partial';dodoPayment.refunds=[dodoRefund];const req=dodoReq(),beforeBooking=(await row(bookingId)).payload;assert.equal((await requestFlow('dodo',{req})).status,200);let saved=await record();assert.equal(saved.providerRecoveryTerminal,true);assert.equal(saved.recoveryReason,'dodo_refund_details_incomplete');assert.equal(saved.refundProcessedAmountInSubunits,undefined);assert.deepEqual((await row(bookingId)).payload,beforeBooking);const before=await snapshot();const requestsBefore=providerRequests.filter(r=>r.path==='/refunds/refund-fixture').length;assert.equal((await requestFlow('dodo',{req})).status,200);assert.equal((await requestFlow('reconcile')).status,200);saved=await record();assert.equal(saved.providerRecoveryTerminal,true);assert.deepEqual(await snapshot(),before);assert.equal(providerRequests.filter(r=>r.path==='/refunds/refund-fixture').length,requestsBefore);const [typed]=await sql`select payment.status,payment.next_recovery_at,payment.source_revision,source.payload->>'recoveryReason' as source_recovery_reason,(source.payload->>'providerRecoveryTerminal')::boolean as source_provider_recovery_terminal,source.payload->>'providerRecoveryTerminalReason' as source_provider_recovery_terminal_reason from commerce.payment_records payment join migration.source_documents source using(legacy_sanity_id) where payment.legacy_sanity_id=${recordId}`;assert.equal(typed.source_provider_recovery_terminal,true);assert.equal(typed.next_recovery_at,null);return{bound:'one authoritative detail lookup then immediate terminal/manual state; no scheduled retry',typed,retainedPaymentAndBooking:true,ownerAlert:'sanitized actual logSafeError console event retained in run log'};});

  for (const stage of ['headers', 'body']) await run(`recovery-provider-timeout-${stage}`, async () => {
    const pending = new Set();
    providerHook = async (request, req, res) => {
      if (request.path === '/v1/oauth2/token') return false;
      if (stage === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      }
      pending.add(res);
      return true;
    };
    const began = originalNow();
    let timer;
    try {
      const results = await Promise.race([
        Promise.all([
          providers.inspectPayPalOrder({ orderId: 'order-fixture' }),
          providers.inspectPayPalCapture({ paymentId: 'capture-fixture' }),
          providers.inspectRazorpayOrder({ orderId: 'order-fixture' }),
          providers.inspectRazorpayPayment({ paymentId: 'payment-fixture' }),
        ]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Provider request exceeded its 8-second deadline')), 11000);
        }),
      ]);
      assert.ok(results.every(result => result.state === 'unavailable'), JSON.stringify(results));
      assert.ok(originalNow() - began < 11000);
      return { stage, elapsedMs: originalNow() - began, results };
    } finally {
      clearTimeout(timer);
      for (const response of pending) response.destroy();
    }
  });

  for (const mode of ['timeout', 'malformed', 'missing', 'invalid']) await run(`recovery-webhook-verification-body-${mode}`, async () => {
    await seed();
    const pending = new Set();
    providerHook = async (request, req, res) => {
      if (request.path !== '/v1/notifications/verify-webhook-signature') return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'timeout') { res.write('{'); pending.add(res); }
      else res.end(mode === 'malformed' ? '{' : JSON.stringify(mode === 'missing' ? {} : { verification_status: 'FAILURE' }));
      return true;
    };
    const before = await snapshot({ receipts: true });
    const began = originalNow();
    try {
      const result = await requestFlow('paypal', { req: paypalReq('PAYMENT.CAPTURE.COMPLETED', {
        id: 'capture-fixture', supplementary_data: { related_ids: { order_id: 'order-fixture' } },
      }) });
      assert.equal(result.status, mode === 'invalid' ? 401 : 503);
      assert.deepEqual(await snapshot({ receipts: true }), before);
      assert.ok(originalNow() - began < 11000);
      return { mode, result, elapsedMs: originalNow() - began, noMutation: true };
    } finally {
      for (const response of pending) response.destroy();
    }
  });

  for (const provider of ['paypal', 'razorpay', 'dodo']) for (const status of ['started', 'needs_recovery', 'finalizing']) {
    await run(`recovery-terminal-public-status-${provider}-${status}`, async () => {
      const payment = await seed(provider, status, { record: {
        recoveryAttemptCount: 12, recoveryFailureCount: 12, reconciliationRecoveryTerminal: true,
        nextRecoveryAt: '9999-12-31T23:59:59.999Z',
      } });
      const before = await snapshot();
      const result = await flow.getPaymentStatus({ client: commerce, paymentAccessToken: tokenFor(payment) });
      assert.equal(result.httpStatus, 200);
      assert.match(result.body.recoveryReason, /manual review.*contact Roo Industries/i);
      assert.equal(result.body.nextRecoveryAt, '');
      assert.deepEqual(await snapshot(), before);
      return { result, noMutation: true };
    });
  }

  for (const terminal of ['absent', 'false']) for (const nextRecoveryAt of ['', '2099-02-01T00:00:00.000Z']) {
    await run(`recovery-public-status-${terminal}-${nextRecoveryAt ? 'scheduled' : 'unscheduled'}`, async () => {
      const confirmation = 'Payment confirmation is taking longer than expected. Please keep this session and try the status check again shortly.';
      const states = [
        { status: 'started', message: '' },
        { status: 'booked', message: '' },
        { status: 'needs_recovery', message: confirmation },
        { status: 'finalizing', message: confirmation },
        { status: 'refunded', message: 'This payment has been refunded.' },
        { status: 'abandoned', message: 'This payment session was released and is no longer payable.' },
        { status: 'failed', message: 'Payment could not be completed.' },
        { status: 'booked', requiresReschedule: true, message: 'Your payment is safe, but the original time needs to be rescheduled. Roo Industries will contact you.' },
        { status: 'booked', dodoDisputeActive: true, message: 'This payment is under dispute. Please contact Roo Industries before proceeding.' },
      ];
      const payment = await seed('paypal', 'started', { record: {
        nextRecoveryAt, ...(terminal === 'false' ? { reconciliationRecoveryTerminal: false } : {}),
      } });
      const results = [];
      for (const { message, ...state } of states) {
        await commerce.patch(payment._id).set({ requiresReschedule: false, dodoDisputeActive: false, ...state }).commit();
        const before = await snapshot();
        const result = await flow.getPaymentStatus({ client: commerce, paymentAccessToken: tokenFor(payment) });
        assert.equal(result.httpStatus, 200);
        assert.equal(result.body.recoveryReason, message);
        assert.equal(result.body.nextRecoveryAt, nextRecoveryAt);
        assert.deepEqual(await snapshot(), before);
        results.push({ state, result });
      }
      return { terminal, nextRecoveryAt, results, readOnly: true };
    });
  }

  for (const kind of ['provider', 'refund', 'release', 'release-stored']) await run(`recovery-returned-${kind}-failure-bound`, async () => {
    const old = new Date(originalNow() - 3600000).toISOString();
    await seed('paypal', kind === 'refund' ? 'refunded' : kind.startsWith('release') ? 'abandoned' : 'started', {
      record: {
        createdAt: old, updatedAt: old, lastAttemptAt: old, nextRecoveryAt: '',
        recoveryAttemptCount: 11, recoveryFailureCount: 11, emailDispatchRequired: false,
        ...(kind === 'refund' ? {
          bookingId: 'booking.missing', refundState: 'full', refundRequiresBookingSync: true,
          refundProcessedAmountInSubunits: 999,
        } : {}),
        ...(kind.startsWith('release') ? {
          resourceReleasePending: true, resourceReleaseTargetStatus: 'abandoned',
          couponReservationId: 'couponReservation.fixture',
        } : {}),
      },
    });
    if (kind === 'provider') {
      providerHook = async (request, req, res) => {
        if (request.path !== '/v2/checkout/orders/order-fixture') return false;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
        return true;
      };
    }
    const args = {
      client: commerce,
      req: { headers: { authorization: 'Bearer fixture-cron' } },
      ...(kind === 'release' ? {
        releaseCouponReservation: async () => { throw new Error('Synthetic coupon dependency unavailable'); },
      } : {}),
    };
    if (kind === 'release-stored') {
      await commerce.create({
        _id: 'couponReservation.fixture', _type: 'couponRedemption',
        status: 'reserved', backendOwner: 'supabase', cutoverGeneration: 0,
      });
      await removeRevision('couponReservation.fixture', 'null');
    }
    const beforeBooking = (await row(bookingId)).payload;
    const unrelated = commerce.transaction();
    for (let index = 0; index < 75; index += 1) {
      unrelated.create({
        _id: `paymentRecord.settled-${index}`, _type: 'paymentRecord', provider: 'paypal',
        backendOwner: 'supabase', status: 'booked', emailDispatchRequired: false,
      });
    }
    await unrelated.commit();
    const first = await flow.reconcilePaymentSessions(args);
    assert.equal(first.httpStatus, 200);
    const saved = await record();
    assert.equal(saved.recoveryAttemptCount, 12);
    assert.equal(saved.reconciliationRecoveryTerminal, true);
    assert.equal(saved.nextRecoveryAt, '9999-12-31T23:59:59.999Z');
    assert.deepEqual((await row(bookingId)).payload, beforeBooking);
    const before = await snapshot({ receipts: true });
    const next = await flow.reconcilePaymentSessions(args);
    assert.equal(next.body.summary.scanned, 0);
    assert.deepEqual(await snapshot({ receipts: true }), before);
    const [typed] = await sql`select status, next_recovery_at from commerce.payment_records where legacy_sanity_id=${recordId}`;
    assert.equal(new Date(typed.next_recovery_at).toISOString(), saved.nextRecoveryAt);
    return { kind, first, next, saved, typed, productionCouponRelease: kind === 'release-stored' };
  });

  await run('recovery-webhook-after-exhaustion', async () => {
    await seed('paypal', 'needs_recovery', {
      booking: {
        paymentRecordId: recordId,
        emailDispatchClientSentAt: '2026-01-01T00:00:00.000Z',
        emailDispatchOwnerSentAt: '2026-01-01T00:00:00.000Z',
      },
      record: {
        recoveryAttemptCount: 12, recoveryFailureCount: 12, reconciliationRecoveryTerminal: true,
        nextRecoveryAt: '9999-12-31T23:59:59.999Z',
      },
    });
    const result = await requestFlow('paypal', { req: paypalReq('PAYMENT.CAPTURE.REFUNDED', {
      id: 'refund-fixture', status: 'COMPLETED', amount: { value: '9.99', currency_code: 'USD' },
      supplementary_data: { related_ids: { order_id: 'order-fixture', capture_id: 'capture-fixture' } },
    }) });
    assert.equal(result.status, 200, JSON.stringify(result));
    const saved = await record();
    assert.equal(saved.status, 'refunded');
    assert.equal(saved.reconciliationRecoveryTerminal, false);
    assert.equal(saved.recoveryAttemptCount, 0);
    assert.equal(saved.recoveryFailureCount, 0);
    assert.equal(saved.nextRecoveryAt, '');
    return { result, saved };
  });

  for (const scenario of ['paypal-full', 'paypal-partial', 'razorpay-full', 'dodo-full', 'paypal-unbooked', 'paypal-verified']) {
    await run(`recovery-new-refund-after-exhaustion-${scenario}`, async () => {
      const provider = scenario.split('-')[0];
      const partial = scenario.endsWith('partial');
      const unbooked = scenario.endsWith('unbooked');
      const verified = scenario.endsWith('verified');
      const amount = partial ? 499 : 999;
      await seed(provider, 'needs_recovery', { record: {
        ...(unbooked ? { bookingId: '', holdSnapshot: { slotHoldId: 'slotHold.fixture' } } : {}),
        recoveryAttemptCount: 12, recoveryFailureCount: 12, reconciliationRecoveryTerminal: true,
        nextRecoveryAt: '9999-12-31T23:59:59.999Z',
      } });
      if (unbooked) await commerce.create({
        _id: 'slotHold.fixture', _type: 'slotHold', backendOwner: 'supabase', cutoverGeneration: 0,
        startTimeUTC: '2099-01-01T10:00:00.000Z', packageTitle: 'Vertex Essentials',
        phase: 'holding', paymentRecordId: recordId, paymentProvider: provider,
        holdNonce: 'refund-recovery', expiresAt: '2099-01-01T10:00:00.000Z',
      });
      if (unbooked) await commerce.patch('slotHold.fixture').set({ phase: 'payment_pending' }).commit();
      const blockedId = unbooked ? 'slotHold.fixture' : bookingId;
      await sql.unsafe(`create or replace function public.payment_refund_failure_fixture() returns trigger language plpgsql as $$
        begin
          if new.legacy_sanity_id = '${blockedId}' then raise exception 'Synthetic refund storage failure'; end if;
          return new;
        end $$;
        create trigger payment_refund_failure_fixture before update on migration.source_documents
        for each row execute function public.payment_refund_failure_fixture();`);
      const refundEvent = () => {
        if (provider === 'razorpay') return razorReq('refund.processed', { refund: { entity: {
          id: 'refund-fixture', payment_id: 'payment-fixture', amount, currency: 'USD', status: 'processed',
        } } });
        if (provider === 'dodo') {
          dodoPayment.refund_status = 'full';
          dodoPayment.refunds = [{ ...dodoRefund }];
          return dodoReq();
        }
        if (verified) {
          paypalOrder.purchase_units[0].payments.captures[0].status = 'REFUNDED';
          return paypalReq('PAYMENT.CAPTURE.COMPLETED', {
            id: 'capture-fixture', supplementary_data: { related_ids: { order_id: 'order-fixture' } },
          });
        }
        return paypalReq('PAYMENT.CAPTURE.REFUNDED', {
          id: 'refund-fixture', status: 'COMPLETED', amount: { value: partial ? '4.99' : '9.99', currency_code: 'USD' },
          supplementary_data: { related_ids: { order_id: 'order-fixture', capture_id: 'capture-fixture' } },
        });
      };
      const before = (await row(blockedId)).payload;
      let first, pending, recovered;
      try {
        first = await requestFlow(provider, { req: refundEvent() });
        pending = await record();
        assert.equal(pending.refundRequiresBookingSync, true);
        assert.deepEqual((await row(blockedId)).payload, before);
        assert.equal(pending.reconciliationRecoveryTerminal, false);
        assert.equal(pending.recoveryFailureCount, 0);
        assert.equal(pending.nextRecoveryAt, '');
      } finally {
        await sql.unsafe('drop trigger payment_refund_failure_fixture on migration.source_documents');
      }
      recovered = await requestFlow('reconcile');
      const saved = await record();
      assert.equal(recovered.status, 200, JSON.stringify(recovered));
      assert.equal(recovered.body.summary.refundsSynced, 1);
      assert.equal(saved.refundRequiresBookingSync, false);
      assert.equal(saved.reconciliationRecoveryTerminal, false);
      assert.equal(saved.recoveryFailureCount, 0);
      if (unbooked) assert.equal((await row(blockedId)).payload.phase, 'released');
      else assert.equal((await row(bookingId)).payload.refundedAmount, partial ? 4.99 : 9.99);
      return { scenario, first, pending, recovered, saved, realPostgresFailure: true };
    });
  }

  await run('recovery-duplicate-refund-keeps-failure-bound', async () => {
    await seed('paypal', 'needs_recovery', { record: {
      recoveryAttemptCount: 12, recoveryFailureCount: 12, reconciliationRecoveryTerminal: true,
      nextRecoveryAt: '9999-12-31T23:59:59.999Z',
    } });
    await sql.unsafe(`create or replace function public.payment_refund_failure_fixture() returns trigger language plpgsql as $$
      begin
        if new.legacy_sanity_id = 'booking.fixture' then raise exception 'Synthetic refund storage failure'; end if;
        return new;
      end $$;
      create trigger payment_refund_failure_fixture before update on migration.source_documents
      for each row execute function public.payment_refund_failure_fixture();`);
    const refundEvent = id => paypalReq('PAYMENT.CAPTURE.REFUNDED', {
      id: 'refund-fixture', status: 'COMPLETED', amount: { value: '9.99', currency_code: 'USD' },
      supplementary_data: { related_ids: { order_id: 'order-fixture', capture_id: 'capture-fixture' } },
    }, id);
    const attempts = [];
    try {
      await requestFlow('paypal', { req: refundEvent('new-refund-event') });
      assert.equal((await record()).recoveryFailureCount, 0);
      for (let index = 0; index < 12; index += 1) {
        const current = await record();
        const when = current.nextRecoveryAt ? new originalDate(current.nextRecoveryAt).getTime() + 1 : originalNow();
        globalThis.Date = class extends originalDate {
          constructor(...args) { super(...(args.length ? args : [when])); }
          static now() { return when; }
        };
        const result = await requestFlow('reconcile');
        assert.equal(result.status, 200, JSON.stringify(result));
        attempts.push((await record()).recoveryFailureCount);
      }
      const exhausted = await record();
      assert.equal(exhausted.reconciliationRecoveryTerminal, true);
      assert.deepEqual(attempts, Array.from({ length: 12 }, (_, index) => index + 1));
      await requestFlow('paypal', { req: refundEvent('duplicate-refund-event') });
      const duplicate = await record();
      assert.equal(duplicate.recoveryFailureCount, 12);
      assert.equal(duplicate.reconciliationRecoveryTerminal, true);
      assert.equal(duplicate.nextRecoveryAt, exhausted.nextRecoveryAt);
      assert.equal((await requestFlow('reconcile')).body.summary.scanned, 0);
      return { attempts, exhausted, duplicate, realPostgresFailure: true };
    } finally {
      globalThis.Date = originalDate;
      await sql.unsafe('drop trigger payment_refund_failure_fixture on migration.source_documents');
    }
  });

  for (const count of [null, -100, 'corrupt', 2.8]) await run(`recovery-invalid-counter-${String(count)}`, async () => {
    const old = new Date(originalNow() - 3600000).toISOString();
    await seed('paypal', 'started', { record: {
      createdAt: old, updatedAt: old, lastAttemptAt: old, nextRecoveryAt: '',
      recoveryAttemptCount: count, recoveryFailureCount: count, emailDispatchRequired: false,
    } });
    providerHook = async (request, req, res) => {
      if (request.path !== '/v2/checkout/orders/order-fixture') return false;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
      return true;
    };
    const result = await requestFlow('reconcile');
    const saved = await record();
    assert.equal(result.status, 200);
    assert.equal(saved.recoveryAttemptCount, count === 2.8 ? 3 : 1);
    assert.notEqual(saved.reconciliationRecoveryTerminal, true);
    return { result, saved };
  });

  await run('recovery-pending-payment-remains-retryable', async () => {
    const old = new Date(originalNow() - 3600000).toISOString();
    await seed('paypal', 'started', { record: {
      createdAt: old, updatedAt: old, nextRecoveryAt: '', recoveryAttemptCount: 12,
      providerPaymentId: '', emailDispatchRequired: false,
    } });
    paypalOrder.status = 'APPROVED';
    paypalOrder.purchase_units[0].payments = { captures: [] };
    const result = await requestFlow('reconcile');
    const saved = await record();
    assert.equal(result.status, 200);
    assert.notEqual(saved.reconciliationRecoveryTerminal, true);
    assert.equal(saved.status, 'started');
    assert.ok(new Date(saved.nextRecoveryAt).getTime() < Date.UTC(9999, 0, 1));
    return { result, saved };
  });

  await run('recovery-review-only-refunds-leave-room-for-recoverable-payments', async () => {
    for (let index = 0; index < 60; index += 1) {
      await commerce.create({
        _id: `paymentRecord.review-only-${index}`, _type: 'paymentRecord', provider: 'paypal',
        backendOwner: 'supabase', cutoverGeneration: 0, status: 'booked',
        providerOrderId: `order-review-only-${index}`, providerPaymentId: `capture-review-only-${index}`,
        refundState: 'partial', providerRefundStatus: 'partial', refundRequiresBookingSync: true,
        providerRefundDetailsMissing: true, providerRecoveryTerminal: true, reconciliationRecoveryTerminal: true,
        providerRecoveryTerminalReason: 'provider_partial_refund_details_missing_owner_review',
        recoveryReason: 'provider_partial_refund_details_missing_owner_review', nextRecoveryAt: '',
      });
    }
    await seed('dodo', 'booked', {
      booking: { currency: 'USD' },
      record: {
        providerPublicData: { currency: 'USD', totalAmount: 999, environment: 'test_mode', productId: 'pdt_fixture', taxInclusive: true },
        refundCurrency: 'USD', refundState: 'partial', refundProcessedAmountInSubunits: 499, refundRequiresBookingSync: true,
      },
    });
    const [{ ahead }] = await sql`select count(*)::integer as ahead
      from commerce.payment_records review
      join commerce.payment_records recoverable on recoverable.legacy_sanity_id = ${recordId}
      where review.legacy_sanity_id like 'paymentRecord.review-only-%'
        and review.next_recovery_at is null and recoverable.next_recovery_at is null
        and (review.updated_at, review.id) < (recoverable.updated_at, recoverable.id)`;
    assert.equal(ahead, 60);
    const { data, error } = await fixture.client.rpc('roo_fetch_recovery_payment_documents', {
      p_backend: 'supabase',
      p_statuses: ['started', 'captured_client', 'captured_webhook', 'finalizing', 'email_partial', 'needs_recovery'],
      p_refunded_status: 'refunded', p_booked_status: 'booked', p_abandoned_status: 'abandoned',
      p_dodo_enabled: true, p_now: new Date().toISOString(), p_limit: 50,
    });
    assert.equal(error, null);
    const candidates = data.map(candidate => candidate._id);
    assert.deepEqual(candidates, [recordId]);
    const result = await requestFlow('reconcile');
    const saved = await record();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.summary.refundsSynced, 1);
    assert.equal(saved.refundRequiresBookingSync, false);
    const reviewOnly = await sql`select payload from migration.source_documents
      where legacy_sanity_id like 'paymentRecord.review-only-%'`;
    assert.equal(reviewOnly.length, 60);
    for (const { payload } of reviewOnly) {
      assert.equal(payload.refundRequiresBookingSync, true);
      assert.equal(payload.reconciliationRecoveryTerminal, true);
    }
    return { reviewOnly: reviewOnly.length, candidates, result, saved };
  });

  await run('recovery-dodo-requested-payment-binding', async () => {
    const paymentRecord = await seed('dodo', 'started', { record: { providerPaymentId: '', bookingId: '' } });
    dodoPayment.payment_id = 'other-payment';
    const before = await snapshot({ receipts: true });
    const result = await requestFlow('finalize', { paymentAccessToken: tokenFor(paymentRecord), body: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'dodo_payment_binding_mismatch');
    assert.deepEqual(await snapshot({ receipts: true }), before);
    return { result, requested: 'payment-fixture', received: 'other-payment' };
  });

  await run('confirmation-summary-policy', async () => {
    const appointment = { startTimeUTC: '2026-03-08T07:30:00.000Z', localTimeZone: 'America/New_York', paymentRecordId: recordId };
    const payment = await seed('paypal', 'booked', { booking: appointment });
    const expected = { bookingId, packageTitle: 'Vertex Essentials', startTimeUTC: appointment.startTimeUTC, localTimeZone: appointment.localTimeZone };
    const responses = [];
    const check = async (recordChanges, bookingChanges, visible) => {
      const originalRecord = await record(), originalBooking = (await row(bookingId)).payload;
      const current = { ...originalRecord, status: 'booked', requiresReschedule: false, refundState: '', dodoDisputeActive: false, dodoDisputes: [], ...recordChanges };
      const booking = { ...originalBooking, status: 'captured', refundStatus: '', requiresReschedule: false, recoveryStatus: '', dodoDisputeActive: false, dodoDisputes: [], ...appointment, ...bookingChanges };
      const warningCount = summaryWarnings.length;
      const result = await requestFlow('status', { paymentAccessToken: tokenFor(payment), confirmationReadOverride: { record: current, booking } });
      const warnings = summaryWarnings.slice(warningCount);
      if (booking.paymentRecordId === 'paymentRecord.other') assert.equal(warnings.length, current.duplicatePaymentRecord ? 0 : 1);
      assert.equal(JSON.stringify(warnings).includes('customer@example.invalid'), false);
      responses.push({ recordChanges, bookingChanges, expectedVisible: visible, response: result.body, warnings });
      assert.deepEqual(result.body.bookingSummary, visible ? { ...expected, localTimeZone: booking.localTimeZone } : null, JSON.stringify(responses.at(-1)));
    };
    const initial = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.deepEqual(initial.body.bookingSummary, expected);
    for (const status of ['booked', 'email_partial', 'started', 'captured_client', 'captured_webhook', 'finalizing', 'verified_server', 'needs_recovery', 'failed', 'refunded', 'abandoned']) await check({ status }, {}, ['booked', 'email_partial'].includes(status));
    for (const status of ['pending', 'captured', 'completed', 'failed', 'cancelled', 'canceled', 'refunded', 'unknown', '']) await check({}, { status }, ['pending', 'captured', 'completed'].includes(status));
    for (const field of ['emailDeliveryReviewRequired', 'providerRecoveryTerminal', 'reconciliationRecoveryTerminal']) await check({ [field]: true }, {}, true);
    for (const state of ['pending', 'review', 'failed', 'partial', 'full']) { await check({ refundState: state }, {}, state !== 'full'); await check({}, { refundStatus: state }, state !== 'full'); }
    await check({ requiresReschedule: true }, {}, false);
    await check({}, { requiresReschedule: true }, false);
    await check({}, { recoveryStatus: 'requires_reschedule' }, false);
    await check({}, { startTimeUTC: '', originalRequestedStartTimeUTC: appointment.startTimeUTC }, false);
    for (const instant of ['tomorrow', '2026-02-30T10:00:00Z', '2026-01-01', '']) await check({}, { startTimeUTC: instant }, false);
    for (const zone of ['Invalid/Zone', '', null]) await check({}, { localTimeZone: zone }, false);
    await check({ bookingPayload: { originalOrderId: 'booking.original' } }, {}, true);
    await check({}, { localTimeZone: 'Asia/Calcutta' }, true);
    await check({}, { backendOwner: 'sanity' }, true);
    await check({}, { cutoverGeneration: 1 }, false);
    await check({}, { paymentRecordId: 'paymentRecord.other' }, false);
    await check({ duplicatePaymentRecord: true, canonicalPaymentRecordId: 'paymentRecord.other' }, { paymentRecordId: 'paymentRecord.other' }, false);
    for (const status of ['dispute_opened', 'dispute_challenged', 'dispute_lost', 'dispute_accepted', 'dispute_expired', 'dispute_won', 'dispute_cancelled']) {
      const visible = ['dispute_won', 'dispute_cancelled'].includes(status);
      await check({ dodoDisputes: [{ status }] }, {}, visible);
      await check({}, { dodoDisputes: [{ status }] }, visible);
    }
    await check({ dodoDisputeActive: true }, {}, false); await check({}, { dodoDisputeActive: true }, false);
    await sql`update migration.source_documents set payload = payload - 'cutoverGeneration' where legacy_sanity_id in (${recordId}, ${bookingId})`;
    const missingGenerationRows = { paymentRecord: (await row(recordId)).payload, booking: (await row(bookingId)).payload };
    for (const stored of Object.values(missingGenerationRows)) assert.equal(Object.hasOwn(stored, 'cutoverGeneration'), false);
    const missingGeneration = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.deepEqual(missingGeneration.body.bookingSummary, expected);
    const failure = await requestFlow('status', { paymentAccessToken: tokenFor(payment), confirmationReadOverride: { failBookingRead: true } });
    assert.equal(failure.status, 200); assert.equal(failure.body.bookingId, bookingId); assert.equal(failure.body.bookingSummary, null);
    return { paymentRecord: await record(), booking: (await row(bookingId)).payload, initial, responses, missingGenerationRows, missingGeneration, failure };
  });
  await run('confirmation-summary-authorization', async () => {
    const payment = await seed('paypal', 'booked', { booking: { paymentRecordId: recordId, startTimeUTC: '2026-01-01T00:30:00.000Z', localTimeZone: 'UTC' } });
    await commerce.create({ _id: 'booking.other-browser', _type: 'booking', paymentRecordId: 'paymentRecord.other-browser', status: 'captured', packageTitle: 'Other customer package', startTimeUTC: '2026-01-01T00:30:00.000Z', localTimeZone: 'UTC' });
    const result = await requestFlow('status', { paymentAccessToken: tokenFor(payment), query: { bookingId: 'booking.other-browser', paymentRecordId: 'paymentRecord.other-browser' } });
    assert.equal(result.body.bookingSummary.bookingId, bookingId);
    const missing = await requestFlow('status', { paymentAccessToken: '', query: { bookingId } });
    const forged = await requestFlow('status', { paymentAccessToken: tokenFor(payment) + 'x', query: { bookingId } });
    assert.equal(missing.status, 401); assert.ok(forged.status >= 400); assert.ok(!forged.body.bookingSummary);
    const upgradeDenied = await requestFlow('start', { body: { provider: 'free', bookingPayload: { originalOrderId: 'booking.other-browser', email: 'customer@example.invalid', packageTitle: 'Vertex Essentials', upgradeIntentToken: 'invalid-intent' } } });
    assert.equal(upgradeDenied.status, 403);
    assert.equal(upgradeDenied.body.code, 'upgrade_intent_invalid');
    assert.equal(Object.hasOwn(upgradeDenied.body, 'bookingSummary'), false);
    const finalized = await requestFlow('finalize', { paymentAccessToken: tokenFor(payment), body: { bookingId: 'booking.other-browser' } });
    assert.equal(finalized.body.bookingSummary.bookingId, bookingId);
    await commerce.patch(recordId).set({ bookingId: 'booking.other-browser' }).commit();
    const mismatch = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.equal(mismatch.body.bookingSummary, null);
    assert.equal(JSON.stringify(mismatch.body).includes('Other customer package'), false);
    await commerce.create({ ...payment, _id: 'paymentRecord.other-browser', _rev: undefined, providerOrderId: 'order-other-browser', providerPaymentId: 'capture-other-browser', providerIdempotencyKey: 'fixture-key-other-browser', sessionScope: 'fixture-session-other-browser', bookingId: 'booking.other-browser' });
    await commerce.patch(recordId).set({ duplicatePaymentRecord: true, canonicalPaymentRecordId: 'paymentRecord.other-browser' }).commit();
    const warningCount = summaryWarnings.length;
    const duplicate = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.equal(duplicate.body.bookingSummary, null);
    assert.equal(summaryWarnings.length, warningCount);
    return { paymentRecord: payment, booking: (await row(bookingId)).payload, result, missing, forged, upgradeDenied, finalized, mismatch, duplicate };
  });
  await run('confirmation-summary-free-and-replay', async () => {
    const checkout = await a1Start('free', 'browser');
    const payment = (await row(checkout.id)).payload;
    const booking = (await row(payment.bookingId)).payload;
    const response = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.equal(response.body.bookingSummary.bookingId, booking._id);
    assert.equal(response.body.bookingSummary.packageTitle, booking.packageTitle);
    assert.equal(checkout.started.body.bookingSummary.bookingId, booking._id);
    assert.equal(checkout.started.cacheControl, 'private, no-store');
    const beforeReplay = await snapshot({ receipts: true });
    const replay = await requestFlow('start', { body: checkout.input });
    assert.deepEqual(await snapshot({ receipts: true }), beforeReplay);
    assert.equal(replay.status, 409, JSON.stringify(replay));
    assert.equal(replay.body.error, 'Your slot reservation expired.');
    assert.equal(Object.hasOwn(replay.body, 'bookingSummary'), false);
    return { paymentRecord: payment, booking, response, free: checkout.started, replay };
  });
  await run('confirmation-summary-upgrade-completion', async () => {
    const checkout = await a1Start('paypal', 'upgrade');
    const originalBefore = (await row('booking.original')).payload;
    const paymentBefore = (await row(checkout.id)).payload;
    const finalized = await requestFlow('finalize', { paymentAccessToken: tokenFor(paymentBefore), body: checkout.proof });
    assert.equal(finalized.status, 200, JSON.stringify(finalized));
    const payment = (await row(checkout.id)).payload;
    const booking = (await row(payment.bookingId)).payload;
    assert.notEqual(booking._id, originalBefore._id);
    assert.equal(booking.originalOrderId, originalBefore._id);
    assert.equal(booking.paymentRecordId, payment._id);
    assert.notEqual(booking.packageTitle, originalBefore.packageTitle);
    assert.deepEqual(finalized.body.bookingSummary, { bookingId: booking._id, packageTitle: booking.packageTitle, startTimeUTC: booking.startTimeUTC, localTimeZone: booking.localTimeZone });
    assert.notEqual(finalized.body.bookingSummary.bookingId, originalBefore._id);
    const recovered = await requestFlow('status', { paymentAccessToken: tokenFor(payment) });
    assert.deepEqual(recovered.body.bookingSummary, finalized.body.bookingSummary);
    return { originalBefore, originalAfter: (await row(originalBefore._id)).payload, payment, booking, finalized, recovered };
  });
  await run('confirmation-summary-settled-cancel', async () => {
    const responses = {};
    const unchanged = [];
    for (const status of ['booked', 'email_partial', 'refunded', 'failed', 'abandoned', 'needs_recovery', 'finalizing', 'verified_server']) {
      await reset();
      const input = await startInput();
      const settled = ['booked', 'email_partial'].includes(status);
      const pending = status === 'email_partial';
      await commerce.patch(input.bookingPayload.slotHoldId).set({
        phase: ['finalizing', 'verified_server'].includes(status) ? 'payment_pending' : settled || status === 'needs_recovery' ? 'consumed' : 'released',
      }).commit();
      const payment = await seed('dodo', status, {
        booking: {
          ...input.bookingPayload,
          paymentRecordId: recordId,
          status: settled ? 'captured' : status === 'refunded' ? 'refunded' : 'failed',
          localTimeZone: pending ? '' : input.bookingPayload.localTimeZone,
          emailDispatchClientSentAt: pending ? '' : '2026-01-01T00:00:00.000Z',
          emailDispatchOwnerSentAt: '2026-01-01T00:00:00.000Z',
        },
        record: {
          bookingPayload: input.bookingPayload,
          bookingId: ['abandoned', 'needs_recovery', 'finalizing', 'verified_server'].includes(status) ? '' : bookingId,
          refundState: status === 'refunded' ? 'full' : '',
          emailDispatch: { allSent: !pending, client: { sent: !pending }, owner: { sent: true } },
          emailDispatchToken: pending ? 'fixture-email-token' : '',
          cancelledHoldSnapshot: status === 'abandoned' ? { slotHoldId: input.bookingPayload.slotHoldId } : {},
        },
      });
      const before = {
        stored: await snapshot({ receipts: true }),
        emailDispatches: await sql`select to_jsonb(dispatch) as row from commerce.email_dispatches dispatch order by id`,
      };
      const response = await fetch(`${origin}/cancel-route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(payment)}` },
        body: '{}',
      });
      const result = { status: response.status, body: await response.json() };
      assert.deepEqual({
        stored: await snapshot({ receipts: true }),
        emailDispatches: await sql`select to_jsonb(dispatch) as row from commerce.email_dispatches dispatch order by id`,
      }, before, `${status} cancellation changed stored data`);
      unchanged.push(status);
      responses[status] = result;
      assert.equal(result.body.status, status);
      assert.equal(result.body.bookingId, payment.bookingId);
      assert.equal(result.body.emailDispatchToken, payment.emailDispatchToken);
      assert.deepEqual(result.body.bookingSummary, settled && !pending ? {
        bookingId,
        packageTitle: input.bookingPayload.packageTitle,
        startTimeUTC: input.bookingPayload.startTimeUTC,
        localTimeZone: input.bookingPayload.localTimeZone,
      } : null);
    }
    fs.writeFileSync(`${artifact}.cancel-responses.json`, `${JSON.stringify(responses, null, 2)}\n`);
    for (const [status, result] of Object.entries(responses)) {
      if (['booked', 'email_partial'].includes(status)) {
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.body.ok, true);
        assert.equal(result.body.captured, true);
        assert.equal(result.body.cancelled, false);
      } else if (status === 'abandoned') {
        assert.equal(result.status, 200);
        assert.equal(result.body.ok, true);
        assert.equal(result.body.cancelled, true);
        assert.equal(Object.hasOwn(result.body, 'captured'), false);
      } else {
        assert.equal(result.status, 409);
        assert.equal(result.body.ok, false);
        const generic = 'This payment session can no longer be changed.';
        if (status === 'verified_server') {
          assert.equal(result.body.recoveryReason, '');
          assert.equal(result.body.error, generic);
        } else {
          assert.ok(result.body.recoveryReason);
          assert.equal(result.body.error, result.body.recoveryReason);
        }
        assert.equal(Object.hasOwn(result.body, 'captured'), false);
      }
    }
    assert.deepEqual(responses, JSON.parse(sourceText('tests/fixtures/payment-cancel.json')));
    return { responses, unchanged };
  });

  await run('confirmation-summary-captured-cancel', async () => {
    const checkout = await a1Start('paypal');
    const initial = (await row(checkout.id)).payload;
    const cancelled = await requestFlow('cancel', { paymentAccessToken: tokenFor(initial) });
    const payment = (await row(checkout.id)).payload;
    const booking = (await row(payment.bookingId)).payload;
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    assert.equal(cancelled.body.captured, true);
    assert.equal(cancelled.body.bookingSummary.bookingId, booking._id);
    const webhook = await a1Hook('paypal');
    assert.equal(Object.hasOwn(webhook.body, 'bookingSummary'), false);
    await reset();
    const finalizing = await a1Start('paypal');
    const current = (await row(finalizing.id)).payload;
    const finalized = await requestFlow('finalize', { paymentAccessToken: tokenFor(current), body: finalizing.proof });
    assert.equal(finalized.status, 200, JSON.stringify(finalized));
    assert.equal(finalized.body.bookingSummary.bookingId, (await row(finalizing.id)).payload.bookingId);
    return { paymentRecord: payment, booking, cancelled, webhook, finalized };
  });
  assert.ok(evidence.scenarios.length,'Unknown named scenario');if(only)assert.equal(evidence.scenarios.length,new Set(only).size,'Unknown selected payment scenario');assert.equal(blockedNetwork,0);
  evidence.modules=Object.fromEntries(['@supabase/supabase-js','@supabase/ssr','postgres','dodopayments'].map(name=>[name,JSON.parse(fs.readFileSync(path.join(process.cwd(),'node_modules',name,'package.json'),'utf8')).version]));
  evidence.sourceHashes=Object.fromEntries(['src/server/api/payment/flow.js','src/server/api/payment/providerClients.js','src/server/api/payment/dodoProvider.js','src/server/api/payment/reconcileReport.js','src/server/api/ref/createBooking.js','src/server/api/ref/bookingCommit.js','src/server/api/payment/reconcile.js','src/server/api/ref/bookingEmails.js','src/components/Payment.jsx','src/server/api/ref/bookingRefunds.js','scripts/test-payment-persistence-sweep.mjs','scripts/lib/sweep-postgres-fixture.mjs','supabase/migrations/20261005000500_project_booking_payment_currency_subunits.sql'].map(name=>[name,crypto.createHash('sha256').update(sourceText(name)).digest('hex')]));
  evidence.ok=evidence.scenarios.every(s=>s.passed);
}catch(error){evidence.ok=false;evidence.failure={message:error.message,stack:error.stack};}
finally{
  globalThis.Date=originalDate;Date.now=originalNow;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(fixture){evidence.vendorEnvironment=legacyVendorEnvironment?'synthetic-leftovers':'absent';evidence.fullMigrationChain=fullChain;evidence.legacyOwner=legacyOwner;evidence.runtime={postgres:fixture.postgresVersion,postgrest:fixture.postgrestVersion,storage:fixture.versions?.storage,scratch:fixture.scratch,host};evidence.appliedSql=fixture.manifest;evidence.requests={blockedNetwork,authUnlinks,rpcs:Object.fromEntries([...new Set(fixture.requestLog.filter(r=>r.rpc).map(r=>r.rpc))].map(name=>[name,fixture.requestLog.filter(r=>r.rpc===name).length]))};await fixture.stop();evidence.servicesStopped=true;}globalThis.fetch=originalFetch;restores.forEach(r=>r());syncBuiltinESMExports();fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,`${JSON.stringify(evidence,null,2)}\n`);process.stdout.write(`${JSON.stringify({ok:evidence.ok,scenarios:evidence.scenarios.map(({name,passed,error})=>({name,passed,error:error?.slice(0,160)})),failure:evidence.failure,artifact})}\n`);
}
if(!evidence.ok)process.exitCode=1;

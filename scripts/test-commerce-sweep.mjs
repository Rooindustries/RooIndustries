const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSweepPostgresFixture } from './lib/sweep-postgres-fixture.mjs';

for (const key of Object.keys(process.env)) if (/^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO_PAYMENTS|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND)/.test(key)) delete process.env[key];
Object.assign(process.env, {NODE_ENV:'test', VERCEL_ENV:'development', DATA_PRIMARY_BACKEND:'supabase', COMMERCE_PRIMARY_BACKEND:'supabase', COMMERCE_FAILOVER_GENERATION:'0', REF_ADMIN_KEY:'fixture-commerce-admin'});
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;for(const suffix of ['.js','.ts','/index.js']){const candidate=new URL(`${specifier}${suffix}`,context.parentURL);if(fs.existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);}throw error;}}});
const selected=process.argv.find(value=>value.startsWith('--scenario='))?.slice(11);
const artifact=path.resolve(process.env.ROO_COMMERCE_SWEEP_ARTIFACT||'test-results/commerce-sweep.json');
const evidence={checkedAt:new Date().toISOString(), productionRequests:0, scenarios:[], standIns:['Minimal Auth/storage bootstrap and broad local service-role grants in shared fixture; hosted RLS/version not proved.','Synthetic referral documents, local HTTP invoking actual updatePayments handler and real SDK/PostgREST/PostgreSQL adapter.','Deterministic before-read barrier writes the actual concurrent admin payment through the actual adapter.']};
const nativeFetch=globalThis.fetch;
let fixture,server,origin;
const check=async(name,fn)=>{if(selected&&selected!==name)return;try{fixture.setRequestHook(null);evidence.scenarios.push({name,passed:true,proof:await fn()});}catch(error){evidence.scenarios.push({name,passed:false,error:error.message,code:error.code});}};
try {
 fixture=await createSweepPostgresFixture();
 Object.assign(process.env,{SUPABASE_URL:fixture.origin,SUPABASE_SERVICE_ROLE_KEY:fixture.token});
 globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);assert.ok([fixture.origin,origin].includes(url.origin),`Forbidden target ${url.origin}`);assert.ok(!init?.redirect||init.redirect==='error'||init.redirect==='manual');return nativeFetch(input,{...init,redirect:init?.redirect||'error'});};
 const {createSupabaseDocumentClient}=await import('../src/server/supabase/documentClient.js');
 const documents=createSupabaseDocumentClient({shadowClient:fixture.client});
 const handler=(await import('../src/server/api/ref/updatePayments.js')).default;
 server=http.createServer(async(req,res)=>{try{const parts=[];for await(const part of req)parts.push(part);req.body=JSON.parse(Buffer.concat(parts).toString());res.status=value=>{res.statusCode=value;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res;};await handler(req,res);}catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}});
 server.listen(0,testHost);await once(server,'listening');origin=`http://${testHost}:${server.address().port}`;
 let serial=0;
 const seed=async()=>documents.create({_id:`commerce.referral.${++serial}`,_type:'referral',slug:{current:`commerce-${serial}`},registrationStatus:'active',xocPayments:[],vertexPayments:[]});
 const read=id=>documents.getDocument(id);
 await check('partial-native-control-cannot-authorize-stale-lease',async()=>{
  const {issueCommerceFailoverLease}=await import('../src/server/supabase/commerceFailoverLease.js');
  const {assertCommerceWriteAllowed}=await import('../src/server/supabase/commerceControl.js');
  const secret='fixture-commerce-failover-lease-secret';const deploymentId='fixture-commerce-deployment';
  await fixture.sql`update migration.commerce_control set primary_backend='sanity',generation=2,starts_paused=false`;
  const env={NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'sanity',COMMERCE_PRIMARY_BACKEND:'sanity',COMMERCE_FAILOVER_GENERATION:'0',COMMERCE_DEPLOYMENT_ID:deploymentId,COMMERCE_FAILOVER_LEASE_SECRET:secret,COMMERCE_FAILOVER_LEASE:issueCommerceFailoverLease({backend:'sanity',generation:0,startsPaused:false,deploymentId,secret})};
  const partial={async rpc(name,parameters){const result=await fixture.client.rpc(name,parameters);if(result.error||name!=='roo_commerce_control')return result;assert.equal(result.data.generation,2);const {generation,...data}=result.data;return{...result,data};}};
  try{await assert.rejects(assertCommerceWriteAllowed({env,client:partial}),error=>error.statusCode===503);}
  finally{await fixture.sql`update migration.commerce_control set primary_backend='supabase',generation=0,starts_paused=false`;}
  return{actualNativeGeneration:2,refusedSignedGeneration:0,scope:'only successful RPC response field is omitted; signed lease and database control are actual code/SQL'};
 });
 await check('partial-native-pause-cannot-authorize-unpaused-lease',async()=>{
  const {issueCommerceFailoverLease}=await import('../src/server/supabase/commerceFailoverLease.js');
  const {assertCommerceWriteAllowed}=await import('../src/server/supabase/commerceControl.js');
  const secret='fixture-commerce-failover-lease-secret';const deploymentId='fixture-commerce-deployment';
  await fixture.sql`update migration.commerce_control set primary_backend='sanity',generation=0,starts_paused=true`;
  const env={NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'sanity',COMMERCE_PRIMARY_BACKEND:'sanity',COMMERCE_FAILOVER_GENERATION:'0',COMMERCE_DEPLOYMENT_ID:deploymentId,COMMERCE_FAILOVER_LEASE_SECRET:secret,COMMERCE_FAILOVER_LEASE:issueCommerceFailoverLease({backend:'sanity',generation:0,startsPaused:false,deploymentId,secret})};
  const partial={async rpc(name,parameters){const result=await fixture.client.rpc(name,parameters);if(result.error||name!=='roo_commerce_control')return result;assert.equal(result.data.starts_paused,true);const {starts_paused,...data}=result.data;return{...result,data};}};
  try{await assert.rejects(assertCommerceWriteAllowed({env,client:partial}),error=>error.code==='COMMERCE_CONTROL_INVALID');}
  finally{await fixture.sql`update migration.commerce_control set primary_backend='supabase',generation=0,starts_paused=false`;}
  return{actualNativePause:true,refusedSignedPause:false};
 });
 await check('explicit-missing-revision-concurrent-payments-5-plus-1',async()=>{
  const referral=await seed();await fixture.sql`update migration.source_documents set source_revision=null,payload=payload-'_rev' where legacy_sanity_id=${referral._id}`;
  let raced=false;
  fixture.setRequestHook(async(phase,request)=>{if(phase!=='after'||raced||!request.path.endsWith('/roo_fetch_shadow_documents_targeted'))return;if(!request.body.p_ids?.includes(referral._id))return;raced=true;fixture.setRequestHook(null);await documents.patch(referral._id).set({xocPayments:[{_key:'admin-five',amount:5}]}).commit();});
  const response=await fetch(origin,{method:'POST',headers:{'content-type':'application/json','x-admin-key':'fixture-commerce-admin'},body:JSON.stringify({referralId:referral._id,packageType:'xoc',amount:1,entryId:'admin-one'})});const body=await response.json();const saved=await read(referral._id);evidence.paymentOrdering={raced,httpStatus:response.status,body,logs:saved.xocPayments};assert.equal(raced,true);assert.ok([200,409].includes(response.status));assert.equal(saved.xocPayments.find(log=>log._key==='admin-five')?.amount,5);if(response.status===200)assert.equal(saved.xocPayments.reduce((sum,log)=>sum+log.amount,0),6);return evidence.paymentOrdering;
 });
 for(const revision of [undefined,null,'', '   ', 0,{},[]])await check(`explicit-invalid-revision-${JSON.stringify(revision)}`,async()=>{const doc=await seed();await assert.rejects(async()=>documents.patch(doc._id).ifRevisionId(revision).set({notes:'incorrect'}).commit(),error=>error.statusCode===409);assert.equal((await read(doc._id)).notes,undefined);await assert.rejects(async()=>documents.transaction().patch(doc._id,p=>p.ifRevisionId(revision).set({notes:'incorrect'})).commit(),error=>error.statusCode===409);await assert.rejects(async()=>documents.delete(doc._id,{ifRevisionId:revision}),error=>error.statusCode===409);await assert.rejects(async()=>documents.transaction().delete(doc._id,{ifRevisionId:revision}).commit(),error=>error.statusCode===409);assert.ok(await read(doc._id));});
 await check('query-delete-explicit-undefined-concurrent-five-refused',async()=>{
  const doc=await seed();let raced=false;
  fixture.setRequestHook(async(phase,request)=>{
   if(phase!=='after'||raced||!request.path.endsWith('/roo_fetch_shadow_documents_targeted')||!request.body.p_ids?.includes(doc._id))return;
   raced=true;fixture.setRequestHook(null);await documents.patch(doc._id).set({paidTotal:5}).commit();
  });
  await assert.rejects(documents.delete({query:'*[_id in $ids]',params:{ids:[doc._id]}},{ifRevisionId:undefined}),error=>error.statusCode===409);
  fixture.setRequestHook(null);const saved=await read(doc._id);assert.ok(saved);
  if(raced)assert.equal(saved.paidTotal,5);
  return{refused:true,concurrentWriteReached:raced,scope:'explicit invalid guard may refuse before selector; if selector runs, actual concurrent5 must be retained'};
 });
 await check('unguarded-patch-keeps-current-data',async()=>{const doc=await seed();await documents.patch(doc._id).set({notes:'kept'}).commit();await documents.patch(doc._id).set({paidTotal:1}).commit();assert.equal((await read(doc._id)).notes,'kept');});
 for(const order of ['patch-patch','patch-delete','create-patch','create-delete','delete-create','createIfNotExists-patch','createOrReplace-patch','patch-createOrReplace','patch-delete-create-patch'])await check(`compound-${order}`,async()=>{
  const fresh=order.startsWith('create-');const doc=fresh?{_id:`commerce.new.${++serial}`,_type:'referral',notes:'created'}:await seed();let tx=documents.transaction();
  for(const op of order.split('-')){if(op==='patch')tx=tx.patch(doc._id,p=>(fresh?p:p.ifRevisionId(doc._rev)).inc({paidTotal:1}));else if(op==='delete')tx=tx.delete(doc._id);else tx=tx[op==='createIfNotExists'?'createIfNotExists':op]({...doc,notes:'created'});}
  await tx.commit();const saved=await read(doc._id);if(order.endsWith('delete'))assert.equal(saved,null);else assert.ok(saved);if(order==='patch-patch')assert.equal(saved.paidTotal,2);if(order==='create-patch')assert.equal(saved.paidTotal,1);return{present:!!saved,paidTotal:saved?.paidTotal};
 });
 for(const race of ['activation','claim-owner'])await check(`compound-delete-${race}-rolls-back`,async()=>{
  const doc=await seed();const claim=await documents.create({_id:`commerce.claim.${++serial}`,_type:'referralIdentityClaim',referral:{_ref:doc._id}});const marker=`aaaa.rollback.${++serial}`;let raced=false;
  const tx=documents.transaction().create({_id:marker,_type:'referralIdentityClaim',referral:{_ref:doc._id}}).patch(doc._id,p=>p.ifRevisionId(doc._rev).set({registrationStatus:'pending_email'})).delete(doc._id).patch(claim._id,p=>p.ifRevisionId(claim._rev).set({referral:claim.referral})).delete(claim._id);
  fixture.setRequestHook(async(phase,request)=>{if(phase!=='before'||raced||!request.path.endsWith('/roo_apply_document_mutations')||!request.body.p_mutations.some(m=>m.document?._id===marker))return;raced=true;fixture.setRequestHook(null);if(race==='activation')await documents.patch(doc._id).set({registrationStatus:'active',paidTotal:5}).commit();else await documents.patch(claim._id).set({referral:{_ref:'other'}}).commit();});
  await assert.rejects(tx.commit(),error=>error.statusCode===409);assert.equal(raced,true);assert.equal(await read(marker),null);assert.ok(await read(doc._id));assert.ok(await read(claim._id));if(race==='activation')assert.equal((await read(doc._id)).paidTotal,5);else assert.equal((await read(claim._id)).referral._ref,'other');return {concurrentWriterAfterAdapterRead:true,earlierCreateRolledBack:true};
 });

 assert.ok(evidence.scenarios.length,'Unknown scenario');
 evidence.ok=evidence.scenarios.every(item=>item.passed);
} catch(error){evidence.ok=false;evidence.failure={message:error.message,stack:error.stack};}
finally {globalThis.fetch=nativeFetch;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(fixture){evidence.runtime={postgres:fixture.postgresVersion,postgrest:fixture.postgrestVersion,scratch:fixture.scratch};evidence.migrations=fixture.manifest;await fixture.stop();evidence.servicesStopped=true;}fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({ok:evidence.ok,scenarios:evidence.scenarios.map(({name,passed,error})=>({name,passed,error})),failure:evidence.failure,artifact})+'\n');}
if(!evidence.ok)process.exitCode=1;

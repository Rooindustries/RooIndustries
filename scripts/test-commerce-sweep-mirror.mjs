const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createClient as createSanityClient} from '@sanity/client';
import {createSweepPostgresFixture} from './lib/sweep-postgres-fixture.mjs';

for(const key of Object.keys(process.env))if(/^(SANITY|SUPABASE|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'supabase',COMMERCE_PRIMARY_BACKEND:'supabase',COMMERCE_FAILOVER_GENERATION:'0'});
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;for(const suffix of ['.js','.ts','/index.js']){const candidate=new URL(`${specifier}${suffix}`,context.parentURL);if(fs.existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);}throw error;}},load(url,context,nextLoad){if(process.argv.includes('--target-read-baseline')&&['/reverseMirroringClient.js','/documentMutationOutbox.js','/commerceMirrorOutbox.js'].some(path=>url.endsWith(path))){let source=fs.readFileSync(fileURLToPath(url),'utf8');source=source.replace(/requireShadowDocumentArray\((await sanityClient\.fetch\([\s\S]*?\n  \))\);/g,'$1;');source=source.replace('    current\n      .filter','    (Array.isArray(current) ? current : [])\n      .filter').replace('    currentDocuments\n      .filter','    (Array.isArray(currentDocuments) ? currentDocuments : [])\n      .filter');if(url.endsWith('/commerceMirrorOutbox.js'))source=source.replace('      _type,\n','');return{format:'module',shortCircuit:true,source};}if(url.endsWith('/mirrorRpcResponse.js')&&(process.argv.includes('--completion-baseline')||process.argv.includes('--backlog-baseline'))){let source=fs.readFileSync(fileURLToPath(url),'utf8');if(process.argv.includes('--completion-baseline'))source=source.replace('value?.status === undefined && ','');if(process.argv.includes('--backlog-baseline')){const start=source.indexOf('  for (const key of ["actionable"');const end=source.indexOf('  return value;',start);assert.ok(start>=0&&end>start);source=source.slice(0,start)+source.slice(end);}return{format:'module',shortCircuit:true,source};}return nextLoad(url,context);}});
const selected=process.argv.find(value=>value.startsWith('--scenario='))?.slice(11);
const artifact=path.resolve(process.env.ROO_COMMERCE_MIRROR_ARTIFACT||'test-results/commerce-sweep-mirror.json');
const evidence={checkedAt:new Date().toISOString(),completionBaseline:process.argv.includes('--completion-baseline'),backlogBaseline:process.argv.includes('--backlog-baseline'),targetReadBaseline:process.argv.includes('--target-read-baseline'),productionRequests:0,scenarios:[],standIns:['Actual Sanity SDK uses only a run-owned local HTTP provider fixture; documented ifRevisionID/atomic transaction responses are fixtures, not a live Sanity locking proof.','Minimal Auth/storage bootstrap and broad local service-role grants; hosted RLS and deployed version/ledger unproved.','Synthetic commerce/CMS records and direct SQL lease expiry represent two competing workers.','C6 replaces only HTTP/RPC response fields after the actual current PostgreSQL function executes; underlying outbox transaction, claims, completion and constraints are actual repo SQL.','--target-read-baseline restores only the three target-read JS null-to-empty preconditions and old projected guard field list; SDK HTTP, native queues and SQL remain current and real.','--backlog-baseline removes only JS optional backlog counter validation; current native PostgreSQL claims, rows and status counts remain real.','--completion-baseline restores only the pre-transfer JS condition allowing mirrored:true to override an explicit retry status; SQL remains actual current repository code.'],requests:[]};
let fixture,server,origin,beforeMutation=null,targetQueryFault=null,targetQueries=[];
const nativeFetch=globalThis.fetch;
const check=async(name,fn)=>{if(selected&&!selected.split(',').includes(name))return;try{await fixture.sql`truncate local_sanity_documents`;await fixture.sql`delete from migration.commerce_mirror_outbox`;await fixture.sql`delete from migration.document_mutation_mirror_outbox`;await fixture.sql`delete from migration.dead_letters`;beforeMutation=null;targetQueryFault=null;targetQueries=[];evidence.scenarios.push({name,passed:true,proof:await fn()});}catch(error){evidence.scenarios.push({name,passed:false,error:error.message,code:error.code,stack:error.stack});}};
try{
 fixture=await createSweepPostgresFixture();const {sql,client}=fixture;
 Object.assign(process.env,{SUPABASE_URL:fixture.origin,SUPABASE_SERVICE_ROLE_KEY:fixture.token});
 await sql`create table local_sanity_documents(id text primary key,payload jsonb not null)`;
 globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);assert.ok([origin,fixture.origin].includes(url.origin),`Forbidden target ${url.origin}`);return nativeFetch(input,{...init,redirect:'error'});};
 let revision=0;
 const put=async document=>{const payload={...document,_rev:`local-sanity-${++revision}`};await sql`insert into local_sanity_documents(id,payload) values(${document._id},${sql.json(payload)}) on conflict(id) do update set payload=excluded.payload`;return payload;};
 const get=async id=>(await sql`select payload from local_sanity_documents where id=${id}`)[0]?.payload;
 server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,origin);const respond=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(url.pathname.includes('/data/query/')){const ids=JSON.parse(url.searchParams.get('$ids')||'[]');const rows=await sql`select payload from local_sanity_documents where id=any(${ids}::text[])`;const query=url.searchParams.get('query')||'';const deliveredNull=targetQueryFault==='all'||(targetQueryFault==='guard'&&query.includes('_commerceCutoverGeneration'));targetQueries.push({query,ids,actualTargetRows:rows.length,deliveredNull});respond(200,{result:deliveredNull?null:rows.map(row=>row.payload)});return;}
  assert.ok(url.pathname.includes('/data/mutate/'),'Unexpected Sanity fixture path');const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts));evidence.requests.push({path:url.pathname,mutations:body.mutations});
  if(beforeMutation){const hook=beforeMutation;beforeMutation=null;await hook(body);}
  const rows=await sql`select payload from local_sanity_documents`;const state=new Map(rows.map(row=>[row.payload._id,structuredClone(row.payload)]));
  for(const mutation of body.mutations){if(mutation.patch){const patch=mutation.patch;const current=state.get(patch.id);if(!current||(patch.ifRevisionID&&patch.ifRevisionID!==current._rev)){respond(409,{error:{type:'mutationError',description:'Revision conflict'}});return;}const next={...current,...patch.set};for(const key of patch.unset||[])delete next[key];state.set(patch.id,next);}else if(mutation.delete)state.delete(mutation.delete.id);else{const document=mutation.createOrReplace||mutation.createIfNotExists||mutation.create;if(mutation.createIfNotExists&&state.has(document._id))continue;if(mutation.create&&state.has(document._id)){respond(409,{error:{description:'Document exists'}});return;}state.set(document._id,document);}}
  await sql.begin(async tx=>{await tx`truncate local_sanity_documents`;for(const document of state.values())await tx`insert into local_sanity_documents(id,payload) values(${document._id},${tx.json({...document,_rev:`local-sanity-${++revision}`})})`;});respond(200,{transactionId:'local-provider-fixture',results:body.mutations.map(m=>({id:m.patch?.id||m.delete?.id||(m.createOrReplace||m.createIfNotExists||m.create)?._id}))});
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{description:error.message}}));}});
 server.listen(0,testHost);await once(server,'listening');origin=`http://${testHost}:${server.address().port}`;
 const sanity=createSanityClient({projectId:'fixture',dataset:'fixture',apiVersion:'2023-10-01',apiHost:origin,useProjectHostname:false,useCdn:false,token:'fixture-sanity-token',maxRetries:0});
 const {createSupabaseDocumentClient}=await import('../src/server/supabase/documentClient.js');const documents=createSupabaseDocumentClient({shadowClient:client});const commerce=createSupabaseDocumentClient({shadowClient:client,commerceOnly:true,cutoverGeneration:0});
 const {drainCommerceMirrorOutbox}=await import('../src/server/supabase/commerceMirrorOutbox.js');const {drainDocumentMutationOutbox}=await import('../src/server/supabase/documentMutationOutbox.js');
 let serial=0;
 for(const domain of ['commerce','global'])for(const operation of ['upsert','delete'])await check(`${domain}-${operation}-newer-between-read-and-commit`,async()=>{
  const id=`mirror.${domain}.${++serial}`;const adapter=domain==='commerce'?commerce:documents;const source=await adapter.create({_id:id,_type:domain==='commerce'?'booking':'siteSettings',status:'cancelled',title:'old',netAmount:9.99,grossAmount:9.99});
  let oldSequence=0;const outbox=domain==='commerce'?'commerce_mirror_outbox':'document_mutation_mirror_outbox';
  const rows=await sql.unsafe(`select sequence_no from migration.${outbox} order by sequence_no desc limit 1`);oldSequence=Number(rows[0].sequence_no);
  const current=await put({...source,_supabaseSequences:{[domain]:String(Math.max(0,oldSequence-1))},_supabaseRevision:source._rev,_supabaseCanonicalHash:crypto.createHash('sha256').update('fixture').digest('hex')});
  if(operation==='delete'){await sql.unsafe(`delete from migration.${outbox}`);await adapter.delete(id);if(domain==='commerce'){const [event]=await sql`select delete_guards from migration.commerce_mirror_outbox order by sequence_no desc limit 1`;await put({...current,_supabaseCanonicalHash:event.delete_guards[id].canonical_hash,_commerceCutoverGeneration:event.delete_guards[id].cutover_generation});}}
  const latest=(await sql.unsafe(`select sequence_no from migration.${outbox} order by sequence_no desc limit 1`))[0].sequence_no;
  beforeMutation=async()=>{await put({...await get(id),title:'newer-canonical-content',status:'refunded',_supabaseSequences:{[domain]:String(Number(latest)+1)}});};
  const summary=domain==='commerce'?await drainCommerceMirrorOutbox({supabaseClient:client,sanityClient:sanity,limit:1,maxBatches:1}):await drainDocumentMutationOutbox({supabaseClient:client,sanityClient:sanity,limit:1,maxBatches:1});const saved=await get(id);assert.equal(saved?.title,'newer-canonical-content');assert.equal(saved.status,'refunded');const status=(await sql.unsafe(`select status from migration.${outbox} order by sequence_no desc limit 1`))[0].status;assert.ok(['retry','mirrored','superseded','applied'].includes(status));return{summary,outboxStatus:status,newerPreserved:true,scope:'Real SDK request against documented HTTP fixture; native outbox/lease/constraint engine, no live Sanity proof'};
 });
 for(const typeChange of [false,true])for(const overlap of [false,true])await check(`global-delete-create-final-upsert-${typeChange?'different-type':'same-type'}${overlap?'-stored-overlap':''}`,async()=>{
  const id=`mirror.recreated.${++serial}`;
  const source=await documents.create({_id:id,_type:'siteSettings',title:'before'});
  await sql`delete from migration.document_mutation_mirror_outbox`;
  await put({...source,_supabaseSequences:{global:'0'}});
  await documents.transaction().delete(id,{ifRevisionId:source._rev}).create({_id:id,_type:typeChange?'footerSettings':'siteSettings',title:'after'}).commit();
  const [nativeEvent]=await sql`select documents,deleted_documents from migration.document_mutation_mirror_outbox`;
  assert.equal(nativeEvent.documents[0]._id,id);
  assert.equal(nativeEvent.deleted_documents.length,0);
  if(overlap)await sql`update migration.document_mutation_mirror_outbox set deleted_documents=${sql.json([source])}`;
  const summary=await drainDocumentMutationOutbox({supabaseClient:client,sanityClient:sanity,requiredDocumentIds:[id],limit:1,maxBatches:1});
  evidence.recreatedEvents||=[];evidence.recreatedEvents.push({typeChange,overlap,nativeEvent,summary});
  const saved=await get(id);assert.equal(saved?.title,'after');assert.equal(saved._type,typeChange?'footerSettings':'siteSettings');assert.equal(summary.applied,1);
  const [row]=await sql`select status from migration.document_mutation_mirror_outbox order by sequence_no desc limit 1`;assert.equal(row.status,'applied');
  return{summary,sameIdRecreated:true,typeChange,overlap,nativeShape:'current RPC emits only final upsert',overlapScope:overlap?'synthetic persisted shape accepted by actual schema/claim RPC':null};
 });
 await check('global-type-change-newer-between-read-and-commit',async()=>{
  const id=`mirror.type-race.${++serial}`;const source=await documents.create({_id:id,_type:'siteSettings',title:'before'});
  await sql`delete from migration.document_mutation_mirror_outbox`;await put({...source,_supabaseSequences:{global:'0'}});
  await documents.transaction().delete(id,{ifRevisionId:source._rev}).create({_id:id,_type:'footerSettings',title:'after'}).commit();
  const [event]=await sql`select sequence_no from migration.document_mutation_mirror_outbox`;
  beforeMutation=async()=>put({...await get(id),_type:'newerSettings',title:'newer-canonical-content',_supabaseSequences:{global:String(Number(event.sequence_no)+1)}});
  const summary=await drainDocumentMutationOutbox({supabaseClient:client,sanityClient:sanity,requiredDocumentIds:[id],limit:1,maxBatches:1});
  const saved=await get(id);assert.equal(saved.title,'newer-canonical-content');assert.equal(saved._type,'newerSettings');assert.equal(summary.applied,0);
  const [row]=await sql`select status from migration.document_mutation_mirror_outbox`;assert.equal(row.status,'retry');return{summary,newerTypeAndContentPreserved:true};
 });
 for(const domain of ['global','legacy'])await check(`${domain}-type-change-to-referral-final-upsert`,async()=>{
  const id=`mirror.referral-type.${++serial}`;const source=await documents.create({_id:id,_type:'siteSettings',title:'before'});
  await sql`delete from migration.document_mutation_mirror_outbox`;await put({...source,_supabaseSequences:{global:'0'}});
  await documents.transaction().delete(id,{ifRevisionId:source._rev}).create({_id:id,_type:'referral',title:'after',slug:{current:`mirror-referral-${serial}`},registrationStatus:'pending_email'}).commit();
  let summary;
  if(domain==='global')summary=await drainDocumentMutationOutbox({supabaseClient:client,sanityClient:sanity,requiredDocumentIds:[id],limit:1,maxBatches:1});
  else{const {buildMirrorEvent,recordMirrorFailure}=await import('../src/server/supabase/mirrorRecovery.js');const {retryReverseMirrorFailures}=await import('../src/server/supabase/reverseMirroringClient.js');const event=buildMirrorEvent({operation:'supabase_to_sanity_upsert',ids:[id]});await recordMirrorFailure({client,eventKey:event.eventKey,operation:'supabase_to_sanity_upsert',ids:[id],error:new Error('synthetic earlier delivery outage')});summary=await retryReverseMirrorFailures({supabaseClient:documents,sanityClient:sanity,recoveryClient:client});}
  const saved=await get(id);assert.equal(saved.title,'after');assert.equal(saved._type,'referral');if(domain==='global')assert.equal(summary.applied,1);else assert.equal(summary.mirrored,1);return{summary,finalType:'referral'};
 });
 await check('legacy-delete-replay-after-canonical-recreation',async()=>{
  const id=`mirror.legacy.${++serial}`;await documents.create({_id:id,_type:'siteSettings',title:'recreated-canonical-content'});await put({_id:id,_type:'siteSettings',title:'unmarked-recreated-content'});
  const {buildMirrorEvent,recordMirrorFailure}=await import('../src/server/supabase/mirrorRecovery.js');const {retryReverseMirrorFailures}=await import('../src/server/supabase/reverseMirroringClient.js');const event=buildMirrorEvent({operation:'supabase_to_sanity_delete',ids:[id]});await recordMirrorFailure({client,eventKey:event.eventKey,operation:'supabase_to_sanity_delete',ids:[id],error:new Error('synthetic earlier delivery outage')});const summary=await retryReverseMirrorFailures({supabaseClient:documents,sanityClient:sanity,recoveryClient:client});assert.equal((await get(id))?.title,'recreated-canonical-content');const [saved]=await sql`select resolved_at from migration.dead_letters where event_key=${event.eventKey}`;assert.ok(saved.resolved_at);return{summary,canonicalRecreatedRecordPreserved:true};
 });
 await check('legacy-delete-null-canonical-response-keeps-target',async()=>{
  const id=`mirror.null-source.${++serial}`;await documents.create({_id:id,_type:'siteSettings',title:'canonical-present'});await put({_id:id,_type:'siteSettings',title:'existing-target'});
  const partial={...client,async rpc(name,parameters){const result=await client.rpc(name,parameters);if(!result.error&&name==='roo_fetch_shadow_documents_targeted'){assert.equal(result.data[0]._id,id);return{...result,data:null};}return result;}};
  const partialDocuments=createSupabaseDocumentClient({shadowClient:partial});
  const {buildMirrorEvent,recordMirrorFailure}=await import('../src/server/supabase/mirrorRecovery.js');const {retryReverseMirrorFailures}=await import('../src/server/supabase/reverseMirroringClient.js');
  const event=buildMirrorEvent({operation:'supabase_to_sanity_delete',ids:[id]});await recordMirrorFailure({client,eventKey:event.eventKey,operation:'supabase_to_sanity_delete',ids:[id],error:new Error('synthetic earlier delivery outage')});
  const summary=await retryReverseMirrorFailures({supabaseClient:partialDocuments,sanityClient:sanity,recoveryClient:client});
  const target=await get(id);assert.equal(target?.title,'existing-target');assert.equal(summary.mirrored,0);assert.equal(summary.queued,1);
  const [saved]=await sql`select resolved_at from migration.dead_letters where event_key=${event.eventKey}`;assert.equal(saved.resolved_at,null);assert.equal((await documents.getDocument(id)).title,'canonical-present');return{summary,targetAndCanonicalRetained:true};
 });
 for(const domain of ['legacy','global','commerce','commerce-guard'])await check(`${domain}-delete-null-target-keeps-pending`,async()=>{
  const id=`mirror.null-target.${++serial}`;const adapter=domain.startsWith('commerce')?commerce:documents;const source=await adapter.create({_id:id,_type:domain.startsWith('commerce')?'booking':'siteSettings',title:'retained-older-target',status:'cancelled',netAmount:9.99,grossAmount:9.99});
  await sql`delete from migration.document_mutation_mirror_outbox`;await sql`delete from migration.commerce_mirror_outbox`;await adapter.delete(id);assert.equal(await adapter.getDocument(id),null);await put(source);targetQueryFault=domain==='commerce-guard'?'guard':'all';
  let summary,row;
  if(domain==='legacy'){
   const {buildMirrorEvent,recordMirrorFailure}=await import('../src/server/supabase/mirrorRecovery.js');const {retryReverseMirrorFailures}=await import('../src/server/supabase/reverseMirroringClient.js');const event=buildMirrorEvent({operation:'supabase_to_sanity_delete',ids:[id]});await recordMirrorFailure({client,eventKey:event.eventKey,operation:'supabase_to_sanity_delete',ids:[id],error:new Error('synthetic earlier delivery outage')});summary=await retryReverseMirrorFailures({supabaseClient:documents,sanityClient:sanity,recoveryClient:client});[row]=await sql`select resolved_at from migration.dead_letters where event_key=${event.eventKey}`;
  }else if(domain==='global'){summary=await drainDocumentMutationOutbox({supabaseClient:client,sanityClient:sanity,limit:1,maxBatches:1});[row]=await sql`select status from migration.document_mutation_mirror_outbox`;}
  else{summary=await drainCommerceMirrorOutbox({supabaseClient:client,sanityClient:sanity,limit:1,maxBatches:1});[row]=await sql`select status from migration.commerce_mirror_outbox`;}
  const target=await get(id);const observation={domain,canonicalAbsent:true,targetTitle:target?.title,summary,nativeQueue:row,queries:targetQueries};evidence.nullTargets||=[];evidence.nullTargets.push(observation);assert.equal(target?.title,'retained-older-target');assert.ok(targetQueries.some(query=>query.deliveredNull&&query.actualTargetRows===1));
  if(domain==='legacy'){assert.equal(summary.mirrored,0);assert.equal(summary.queued,1);assert.equal(row.resolved_at,null);}else{assert.equal(row.status,'retry');if(domain==='global')assert.equal(summary.applied,0);else assert.equal(summary.mirrored,0);}return observation;
 });
 for(const fault of ['claim-null','claim-missing-document','completion-retry','completion-retry-mirrored-true','completion-wrong-event','backlog-null'])await check(`failclosed-${fault}-refused`,async()=>{
  const id=`mirror.fault.${++serial}`;await commerce.create({_id:id,_type:'booking',status:'cancelled',netAmount:9.99,grossAmount:9.99});
  const mutated={async rpc(name,parameters){const result=await client.rpc(name,parameters);if(result.error)return result;if(fault==='claim-null'&&name==='roo_claim_commerce_mirror_events')return {...result,data:null};if(fault==='claim-missing-document'&&name==='roo_claim_commerce_mirror_events')return {...result,data:result.data.map(event=>({...event,documents:[]}))};if(['completion-retry','completion-retry-mirrored-true'].includes(fault)&&name==='roo_complete_commerce_mirror_event'&&parameters.p_success)return {...result,data:{...result.data,status:'retry',mirrored:fault==='completion-retry-mirrored-true'}};if(fault==='completion-wrong-event'&&name==='roo_complete_commerce_mirror_event'&&parameters.p_success)return {...result,data:{...result.data,event_key:'other-event'}};if(fault==='backlog-null'&&name==='roo_commerce_mirror_status_for_ids')return {...result,data:null};return result;}};
  await assert.rejects(drainCommerceMirrorOutbox({supabaseClient:mutated,sanityClient:sanity,requiredDocumentIds:[id],failClosed:true,limit:1,maxBatches:1}),error=>error.statusCode===503);return{refused:true};
 });
 await check('legacy-completion-flag-without-status-supported',async()=>{
  const id=`mirror.legacy-completion.${++serial}`;await commerce.create({_id:id,_type:'booking',status:'cancelled',netAmount:9.99,grossAmount:9.99});
  const legacy={async rpc(name,parameters){const result=await client.rpc(name,parameters);if(!result.error&&name==='roo_complete_commerce_mirror_event'&&parameters.p_success){const {status,...data}=result.data;return {...result,data:{...data,mirrored:true}};}return result;}};
  const summary=await drainCommerceMirrorOutbox({supabaseClient:legacy,sanityClient:sanity,requiredDocumentIds:[id],failClosed:true,limit:1,maxBatches:1});assert.equal(summary.mirrored,1);
  const [row]=await sql`select status from migration.commerce_mirror_outbox`;assert.equal(row.status,'mirrored');return{summary,scope:'legacy documented mirrored:true shape; actual current SQL completion remains stored mirrored'};
 });
 await check('failclosed-backlog-zero-pending-processing-one-refused',async()=>{
  const id=`mirror.backlog-conflict.${++serial}`;await commerce.create({_id:id,_type:'booking',status:'cancelled',netAmount:9.99,grossAmount:9.99});
  let backlog;
  const inconsistent={async rpc(name,parameters){const result=await client.rpc(name,parameters);if(result.error)return result;if(name==='roo_claim_commerce_mirror_events')return{...result,data:[]};if(name==='roo_commerce_mirror_backlog'){backlog=result.data;assert.equal(backlog.processing,1);return{...result,data:{...backlog,pending:0,dead_letters:0}};}return result;}};
  let error;try{await drainCommerceMirrorOutbox({supabaseClient:inconsistent,sanityClient:sanity,failClosed:true,limit:1,maxBatches:1});}catch(failure){error=failure;}
  const [stored]=await sql`select status,lease_id from migration.commerce_mirror_outbox`;assert.equal(stored.status,'processing');assert.ok(stored.lease_id);
  evidence.backlogContradiction={backlog,reportedPending:0,nativeStatus:stored.status,refused:!!error};assert.equal(error?.statusCode,503);return evidence.backlogContradiction;
 });
 await check('native-dead-letter-blocks-failclosed',async()=>{const id=`mirror.dead.${++serial}`;await commerce.create({_id:id,_type:'booking',status:'cancelled',netAmount:9.99,grossAmount:9.99});await sql`update migration.commerce_mirror_outbox set status='dead_letter',attempt_count=12`;await assert.rejects(drainCommerceMirrorOutbox({supabaseClient:client,sanityClient:sanity,requiredDocumentIds:[id],failClosed:true,limit:1,maxBatches:1}),error=>error.statusCode===503);return{attemptBoundary:12};});
 assert.ok(evidence.scenarios.length);evidence.ok=evidence.scenarios.every(item=>item.passed);
}catch(error){evidence.ok=false;evidence.failure={message:error.message,stack:error.stack};}
finally{globalThis.fetch=nativeFetch;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(fixture){evidence.runtime={postgres:fixture.postgresVersion,postgrest:fixture.postgrestVersion,scratch:fixture.scratch};evidence.migrations=fixture.manifest;await fixture.stop();evidence.servicesStopped=true;}fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({ok:evidence.ok,scenarios:evidence.scenarios.map(({name,passed,error})=>({name,passed,error})),failure:evidence.failure,artifact})+'\n');}
if(!evidence.ok)process.exitCode=1;

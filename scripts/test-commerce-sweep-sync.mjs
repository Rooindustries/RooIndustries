const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createClient as createSanityClient} from '@sanity/client';
import {createSweepPostgresFixture} from './lib/sweep-postgres-fixture.mjs';

for(const key of Object.keys(process.env))if(/^(SANITY|SUPABASE|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'sanity',COMMERCE_PRIMARY_BACKEND:'sanity',SUPABASE_SHADOW_WRITES:'1',COMMERCE_FAILOVER_GENERATION:'0'});
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;for(const suffix of ['.js','.ts','/index.js']){const candidate=new URL(`${specifier}${suffix}`,context.parentURL);if(fs.existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);}throw error;}}});
const artifact=path.resolve(process.env.ROO_COMMERCE_SYNC_ARTIFACT||'test-results/commerce-sweep-sync.json');
const selected=process.argv.find(value=>value.startsWith('--scenario='))?.slice(11);
const evidence={checkedAt:new Date().toISOString(),productionRequests:0,scenarios:[],standIns:['Sanity query engine is a run-owned local HTTP response fixture through the actual Sanity SDK; no live Sanity query/consistency proof.','Synthetic canonical records and platform Auth/storage bootstrap; actual current repo reconciliation/cursor/run/constraint code through PostgREST16.4/PostgreSQL17/SDK.','Existing local service-role grants do not prove hosted RLS or deployment versions.'],queries:[]};
const nativeFetch=globalThis.fetch;
let fixture,server,origin,responseKind,currentId;
try{
 fixture=await createSweepPostgresFixture();const {sql,client}=fixture;
 Object.assign(process.env,{SUPABASE_URL:fixture.origin,SUPABASE_SERVICE_ROLE_KEY:fixture.token});
 globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);assert.ok([fixture.origin,origin].includes(url.origin),`Forbidden target ${url.origin}`);return nativeFetch(input,{...init,redirect:'error'});};
 await fixture.apply('20260711203306_scope_commerce_shadow_sync.sql');
 await fixture.apply('20260711210417_add_incremental_commerce_sync.sql');
 await sql`notify pgrst,'reload schema'`;
 for(let attempt=0;attempt<100;attempt++){
  const result=await client.rpc('roo_release_commerce_sync_cursor',{p_stream_name:'schema-readiness',p_lease_id:'fixture-readiness',p_error_code:null});
  if(result.error?.code!=='PGRST202'){assert.equal(result.error,null);break;}
  assert.ok(attempt<99,'PostgREST sync schema reload deadline');await new Promise(resolve=>setTimeout(resolve,50));
 }
 server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,origin);
  if(url.pathname.includes('/data/mutate/')){assert.equal(req.method,'POST');const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts));evidence.acceptedMutations||=[];evidence.acceptedMutations.push(body.mutations);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({transactionId:'fixture-forward',results:body.mutations.map(mutation=>({id:mutation.create._id,document:mutation.create}))}));return;}
  assert.equal(req.method,'GET');assert.ok(url.pathname.includes('/data/query/'));
  const query=url.searchParams.get('query');evidence.queries.push(query);
  const result=query.includes('._id')?(responseKind==='null-ids'?null:responseKind==='invalid-id'?[123]:[currentId]):(['null-changed','forward-null'].includes(responseKind)?null:[]);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({result}));
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{description:error.message}}));}});
 server.listen(0,testHost);await once(server,'listening');origin=`http://${testHost}:${server.address().port}`;
 const sanity=createSanityClient({projectId:'fixture',dataset:'fixture',apiVersion:'2023-10-01',apiHost:origin,useProjectHostname:false,useCdn:false,token:'fixture-sanity-token',maxRetries:0});
 const {importCommerceShadowDocuments}=await import('../src/server/supabase/shadowStore.js');
 const {syncSanityCommerceChanges}=await import('../src/server/supabase/incrementalCommerceSync.js');
 for(const kind of ['null-ids','invalid-id','null-changed','valid-empty-changed']){
  const name=`incremental-${kind}-retains-canonical`;if(selected&&!selected.split(',').includes(name))continue;
  try{
   await sql`update migration.commerce_control set primary_backend='sanity',generation=0,starts_paused=false`;
   await sql`delete from migration.sync_cursors`;await sql`delete from migration.sync_runs`;
   currentId=`sync.retained.${kind}`;
   await importCommerceShadowDocuments({client,documents:[{_id:currentId,_type:'booking',_rev:`source-${kind}`,_updatedAt:'2026-01-01T00:00:00.000Z',backendOwner:'sanity',status:'cancelled',netAmount:9.99}]});
   responseKind=kind;let result,error;
   try{result=await syncSanityCommerceChanges({sanityClient:sanity,supabaseClient:client});}catch(failure){error={code:failure.code,message:failure.message};}
   const [source]=await sql`select tombstoned,payload from migration.source_documents where legacy_sanity_id=${currentId}`;
   const [run]=await sql`select status from migration.sync_runs order by started_at desc limit 1`;
   const proof={kind,sourceTombstoned:source.tombstoned,runStatus:run.status,result,error};evidence.observations||=[];evidence.observations.push(proof);
   assert.equal(source.tombstoned,false);assert.equal(source.payload._rev,`source-${kind}`);
   if(kind==='valid-empty-changed'){assert.equal(error,undefined);assert.equal(run.status,'completed');assert.equal(result.sourceIds,1);}else{assert.ok(error);assert.equal(run.status,'failed');}
   evidence.scenarios.push({name,passed:true,proof});
  }catch(error){evidence.scenarios.push({name,passed:false,error:error.message,code:error.code,stack:error.stack});}
 }
 const forwardName='forward-null-read-retains-canonical-and-alerts';
 if(!selected||selected.split(',').includes(forwardName)){
  try{
   currentId='sync.forward-null';responseKind='forward-null';
   const document={_id:currentId,_type:'booking',_rev:'source-forward',_updatedAt:'2026-01-01T00:00:00.000Z',backendOwner:'sanity',status:'cancelled',netAmount:9.99};
   await importCommerceShadowDocuments({client,documents:[document]});
   const {createShadowingSanityClient}=await import('../src/server/supabase/shadowingSanityClient.js');
   await createShadowingSanityClient({sanityClient:sanity,shadowClient:client,commerceOnly:true}).create(document);
   const [source]=await sql`select tombstoned,payload from migration.source_documents where legacy_sanity_id=${currentId}`;
   const queue=await sql`select resolved_at,last_error_code from migration.dead_letters where legacy_sanity_id=${currentId}`;
   const proof={sourceTombstoned:source.tombstoned,queue,providerAccepted:true};evidence.observations||=[];evidence.observations.push(proof);
   assert.equal(source.tombstoned,false);assert.equal(source.payload._rev,'source-forward');assert.equal(queue.length,1);assert.equal(queue[0].resolved_at,null);
   evidence.scenarios.push({name:forwardName,passed:true,proof});
  }catch(error){evidence.scenarios.push({name:forwardName,passed:false,error:error.message,code:error.code,stack:error.stack});}
 }
 assert.ok(evidence.scenarios.length);evidence.ok=evidence.scenarios.every(item=>item.passed);
}catch(error){evidence.ok=false;evidence.failure={message:error.message,stack:error.stack};}
finally{globalThis.fetch=nativeFetch;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(fixture){evidence.runtime={postgres:fixture.postgresVersion,postgrest:fixture.postgrestVersion,scratch:fixture.scratch};evidence.migrations=fixture.manifest;await fixture.stop();evidence.servicesStopped=true;}fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({ok:evidence.ok,scenarios:evidence.scenarios.map(({name,passed,error})=>({name,passed,error})),failure:evidence.failure,artifact})+'\n');}
if(!evidence.ok)process.exitCode=1;

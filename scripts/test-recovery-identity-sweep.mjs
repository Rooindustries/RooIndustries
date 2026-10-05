import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installNetworkGuard, localOrigin } from './lib/test-target-safety.mjs';

let host=process.env.ROO_TEST_HOST||'127.0.0.1';
let bindHost=host;
const probe=http.createServer();
try{probe.listen(0,host);await once(probe,'listening');await new Promise(resolve=>probe.close(resolve));}catch(error){if(error.code!=='EADDRNOTAVAIL')throw error;host='127.0.0.1';bindHost='0.0.0.0';}
const originalFetch=globalThis.fetch;
for(const key of Object.keys(process.env))if(/^(SANITY|SUPABASE|PAYPAL|RAZORPAY|DODO|REACT_APP_|NEXT_PUBLIC_|ALLOW_LIVE_|RESEND|BOOKING_EMAIL|DATA_|COMMERCE_|VERCEL_ENV|REF_SESSION|CRON_|RATE_LIMIT_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|NODE_USE_ENV_PROXY)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',VERCEL_ENV:'development',DATA_PRIMARY_BACKEND:'supabase',COMMERCE_PRIMARY_BACKEND:'supabase',REF_SESSION_SECRET:'fixture-recovery-session'});
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);assert.equal(url.protocol,'http:');assert.equal(url.hostname,host);assert.ok(url.port);return originalFetch(input,{...init,redirect:'error',signal:init?.signal||AbortSignal.timeout(30000)});};
const bootstrapRestores=[];
for(const [module,protocol] of [[http,'http:'],[https,'https:']]){
  const originalRequest=module.request,originalGet=module.get;
  module.request=function(input,options,callback){
    const settings=typeof input==='object'&&!(input instanceof URL)?input:typeof options==='object'?options:{};
    const url=typeof input==='string'||input instanceof URL?new URL(input):new URL(`${settings.protocol||protocol}//${settings.hostname||settings.host||'localhost'}:${settings.port||80}${settings.path||'/'}`);
    assert.equal(url.protocol,'http:');assert.equal(url.hostname,host);assert.ok(url.port);assert.ok(!url.username&&!url.password&&!settings.socketPath&&!settings.createConnection);
    return originalRequest.call(this,input,options,callback);
  };
  module.get=function(...args){const request=module.request(...args);request.end();return request;};
  bootstrapRestores.push(()=>{module.request=originalRequest;module.get=originalGet;});
}
syncBuiltinESMExports();
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(host==='127.0.0.1'&&url.endsWith('/scripts/lib/sweep-postgres-fixture.mjs'))return{...result,source:String(result.source).replace(/const host = '[^']+';/,"const host = '127.0.0.1';").replaceAll('server.listen(0, host)','server.listen(0, \"0.0.0.0\")').replaceAll('proxy.listen(0,host)','proxy.listen(0,\"0.0.0.0\")').replace('-h ${host} -k','-h 0.0.0.0 -k').replace('PGRST_SERVER_HOST:host','PGRST_SERVER_HOST:\"0.0.0.0\"')};return result;},resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(!specifier.startsWith('.')||!context.parentURL?.startsWith('file:'))throw error;for(const suffix of ['.js','.ts','/index.js']){const candidate=new URL(`${specifier}${suffix}`,context.parentURL);if(fs.existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);}throw error;}}});
const artifact=path.resolve(process.env.RECOVERY_IDENTITY_ARTIFACT||'test-results/recovery-identity-sweep.json');
const only=process.argv.find(v=>v.startsWith('--scenario='))?.slice(11).split(',');
const evidence={network:{requestedHost:process.env.ROO_TEST_HOST||'127.0.0.1',actualRequestHost:host,bindHost,fixtureNetworkOnlyLoadOverride:host==='127.0.0.1'},checkedAt:new Date().toISOString(),productionRequests:0,scenarios:[],standIns:[{boundary:'Auth HTTP issuance and admin update',scope:'Synthetic signed JWT/user/logout responses. Actual installed SSR/Auth SDK selects/verifies submitted cookies. Admin HTTP handler writes local auth.users via PostgreSQL; hosted GoTrue issuance/storage/revocation excluded.'},{boundary:'Sanity mirror',scope:'Unconfigured at handler import. Synthetic configuration thereafter constructs actual SDK; test guard refuses outbound transport. Real account, credential operation and source SQL apply before pending202. Live mirror not proved.'},{boundary:'Fixture infrastructure',scope:'Shared PostgreSQL17/PostgREST16.4 fixture bootstraps auth/storage tables and expanded local service-role grants; hosted schema/RLS excluded.'},{boundary:'Rate limiting',scope:'Existing NODE_ENV=test bucket; durable rate limiting not claimed here.'}],limits:['No hosted GoTrue, hosted RLS, live Sanity engine, production server/build or UI proof.']};
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const sessions=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const secret='fixture-recovery-signing-only';
const password='fixture-password-one';
let fixture,server,restore,origin,handler,adapter,ssr,documents,sql,bcrypt;
let calls=[],verified=[],providerUserOverride=null,scenarioNumber=0,rateReply,quoteReply;
const jwt=claims=>{const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const body=Buffer.from(JSON.stringify(claims,(_key,value)=>typeof value==='number'&&!Number.isFinite(value)?'fixture-nonfinite-number':value).replaceAll('"fixture-nonfinite-number"','1e400')).toString('base64url');return`${head}.${body}.${crypto.createHmac('sha256',secret).update(`${head}.${body}`).digest('base64url')}`;};
const claims=(index=0,overrides={})=>{const now=Math.floor(Date.now()/1000);return{iss:`${origin}/auth/v1`,aud:'authenticated',role:'authenticated',aal:'aal1',sub:ids[index],session_id:sessions[index],iat:now,exp:now+3600,amr:[{method:'otp',timestamp:now}],...overrides};};
const run=async(name,fn)=>{if(only&&!only.includes(name))return;const start=Date.now();try{await reset();const proof=await fn();evidence.scenarios.push({name,passed:true,durationMs:Date.now()-start,proof});}catch(error){evidence.scenarios.push({name,passed:false,durationMs:Date.now()-start,error:error.message,stack:error.stack,authMutationTargets:calls.map(x=>x.userId),verifiedTokenUsers:verified});}};
const reset=async()=>{
  fixture.setRequestHook(null);calls=[];verified=[];providerUserOverride=null;rateReply=undefined;quoteReply=undefined;globalThis.__rooRateLimitBuckets?.clear();scenarioNumber++;
  await sql`delete from accounts.credential_operations`;
  await sql`delete from accounts.principals`;
  await sql`delete from auth.sessions`;
  await sql`delete from auth.users`;
  for(let i=0;i<2;i++){
    const email=`recovery${i}@fixture.invalid`,id=ids[i],docId=`referral.recovery${i}`;
    await sql`insert into auth.users(id,email,email_confirmed_at,encrypted_password) values(${id}::uuid,${email},now(),'old')`;
    await sql`insert into auth.sessions(id,user_id) values(${sessions[i]}::uuid,${id}::uuid)`;
    await sql`insert into public.profiles(user_id,primary_email,display_name,status,legacy_sanity_id) values(${id}::uuid,${email},'Fixture','active',${docId})`;
    await sql`insert into accounts.creator_profiles(user_id,referral_code,legacy_sanity_id,active) values(${id}::uuid,${`recovery${i}`},${docId},true)`;
    await sql`insert into accounts.account_roles(user_id,role) values(${id}::uuid,'creator')`;
    await sql`insert into accounts.login_aliases(user_id,alias_type,normalized_value,verified) values(${id}::uuid,'email',${email},true),(${id}::uuid,'referral_code',${`recovery${i}`},true)`;
    const old=await documents.fetch('*[_id == $id][0]',{id:docId});
    if(old)await documents.patch(docId).ifRevisionId(old._rev).set({creatorEmail:email,creatorPassword:'old',credentialVersion:2,registrationStatus:'active',active:true}).commit();
    else await documents.create({_id:docId,_type:'referral',creatorEmail:email,slug:{current:`recovery${i}`},creatorPassword:'old',credentialVersion:2,registrationStatus:'active',active:true});
  }
  await sql`insert into auth.sessions(id,user_id) values(${sessions[2]}::uuid,${ids[0]}::uuid)`;
};
const snapshot=async()=>({users:await sql`select id,encrypted_password from auth.users order by id`,principals:await sql`select id,session_version from accounts.principals order by id`,operations:await sql`select user_id,status,operation_key from accounts.credential_operations order by id`,sources:await sql`select legacy_sanity_id,payload->>'creatorPassword' as password,payload->>'credentialVersion' as version from migration.source_documents where legacy_sanity_id like 'referral.recovery%' order by legacy_sanity_id`});
const cookie=async(token,index=0)=>{const headers=new Map();const res={getHeader:n=>headers.get(n),setHeader:(n,v)=>headers.set(n,v)};await ssr.installLegacySupabaseSession({req:{headers:{}},res,session:{access_token:token,refresh_token:'fixture-refresh'}});return[].concat(headers.get('Set-Cookie')||[]).map(v=>v.split(';')[0]).join('; ');};
const post=async(cookieHeader,body={expectedUserId:ids[0],expectedSessionId:sessions[0]})=>{const response=await fetch(`${origin}/recover`,{method:'POST',headers:{'content-type':'application/json',cookie:cookieHeader,'x-forwarded-for':`192.0.2.${scenarioNumber%250+1}`},body:JSON.stringify({password,...body})});return{status:response.status,body:await response.json()};};
const refused=async(cookieHeader,body)=>{const before=await snapshot();calls=[];const result=await post(cookieHeader,body);const after=await snapshot();assert.equal(result.status,401,JSON.stringify({result,authMutationTargets:calls.map(x=>x.userId)}));assert.equal(calls.length,0);assert.deepEqual(after,before);return{status:result.status,authMutations:0,credentialOperationChanges:0,sourceChanges:0};};
const accepted=async(token,index=0)=>{const result=await post(await cookie(token,index),{expectedUserId:ids[index],expectedSessionId:JSON.parse(Buffer.from(token.split('.')[1],'base64url')).session_id});assert.ok([200,202].includes(result.status),JSON.stringify(result));assert.equal(calls.length,1);assert.equal(calls[0].userId,ids[index]);const [user]=await sql`select encrypted_password from auth.users where id=${ids[index]}::uuid`;assert.equal(await bcrypt.compare(password,user.encrypted_password),true);const [op]=await sql`select user_id,status,password_hash from accounts.credential_operations`;assert.equal(op.user_id,ids[index]);assert.ok(['auth_applied','mirrored'].includes(op.status));const [source]=await sql`select payload from migration.source_documents where legacy_sanity_id=${`referral.recovery${index}`}`;assert.equal(source.payload.creatorPassword,op.password_hash);assert.equal(await bcrypt.compare(password,source.payload.creatorPassword),true);return{status:result.status,authMutationTargets:calls.map(x=>x.userId),actualCredentialOperation:op.status,actualSourcePasswordApplied:true};};
try{
  ({createSweepPostgresFixture:fixture}=await import('./lib/sweep-postgres-fixture.mjs'));fixture=await fixture();sql=fixture.sql;
  server=http.createServer(async(req,res)=>{try{
    if(req.url==='/recover'){const request=new Request(`${origin}${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});const result=await adapter.runLegacyApiHandler({request,handler});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);const payload=raw.length?JSON.parse(raw):null;
    if(req.url==='/rest/v1/rpc/roo_consume_rate_limit'&&rateReply!==undefined){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(rateReply));return;}
    if(req.url==='/rest/v1/rpc/roo_consume_quote_rate_limit_and_get_pricing'&&quoteReply!==undefined){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(quoteReply));return;}
    if(req.url.startsWith('/rest/v1/')){const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];const response=await fetch(`${fixture.origin}${req.url}`,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:raw})});res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());return;}
    if(req.url.startsWith('/auth/v1/admin/users/')&&req.method==='PUT'){const userId=req.url.split('/').at(-1);assert.ok(ids.includes(userId));assert.equal(req.headers.authorization,`Bearer ${fixture.token}`);calls.push({userId});const hash=await bcrypt.hash(payload.password,4);await sql`update auth.users set encrypted_password=${hash} where id=${userId}::uuid`;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:userId,email:`recovery${ids.indexOf(userId)}@fixture.invalid`}));return;}
    if(req.url==='/auth/v1/user'){const token=String(req.headers.authorization||'').replace(/^Bearer /,'');const parts=token.split('.');assert.equal(parts[2],crypto.createHmac('sha256',secret).update(`${parts[0]}.${parts[1]}`).digest('base64url'));const c=JSON.parse(Buffer.from(parts[1],'base64url'));const userId=providerUserOverride||c.sub;const [user]=await sql`select id,email from auth.users where id=${userId}::uuid`;assert.ok(user);verified.push({sub:c.sub,sessionId:c.session_id,returnedUserId:user.id});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...user,aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{}}));return;}
    if(req.url.startsWith('/auth/v1/logout')){res.writeHead(204);res.end();return;}
    throw new Error(`Unexpected fixture route ${req.method} ${req.url}`);
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  server.listen(0,bindHost);await once(server,'listening');origin=localOrigin(`http://${host}:${server.address().port}`);restore=installNetworkGuard([origin,fixture.origin]);
  Object.assign(process.env,{SUPABASE_URL:origin,SUPABASE_SERVICE_ROLE_KEY:fixture.token,NEXT_PUBLIC_SUPABASE_ANON_KEY:fixture.token});
  bcrypt=(await import('bcryptjs')).default;
  ({default:handler}=await import('../src/server/api/ref/recoverPassword.js'));adapter=await import('../src/lib/nextApiAdapter.js');ssr=await import('../src/server/supabase/serverSession.js');documents=(await import('../src/server/supabase/documentClient.js')).createSupabaseDocumentClient({shadowClient:fixture.client});
  Object.assign(process.env,{SANITY_PROJECT_ID:'requestfixture',SANITY_DATASET:'test-request',SANITY_WRITE_TOKEN:'fixture-sanity'});
  await run('verified-A-cookie-B-before-post',async()=>{await cookie(jwt(claims()));verified=[];const b=await cookie(jwt(claims(1)),1);return refused(b);});
  await run('verified-A-same-user-new-session-before-post',async()=>{await cookie(jwt(claims()));return refused(await cookie(jwt(claims(0,{session_id:sessions[2]}))));});
  await run('pending202-A-cookie-B-before-retry',async()=>{const a=await accepted(jwt(claims()));assert.equal(a.status,202);const proof=await refused(await cookie(jwt(claims(1)),1));return{first:a,retry:proof,BMutations:0};});
  await run('missing-expected-identity',async()=>refused(await cookie(jwt(claims())),{}));
  await run('missing-expected-session',async()=>refused(await cookie(jwt(claims())),{expectedUserId:ids[0]}));
  await run('missing-expected-user',async()=>refused(await cookie(jwt(claims())),{expectedSessionId:sessions[0]}));
  await run('verified-user-claims-mismatch',async()=>{providerUserOverride=ids[1];return refused(await cookie(jwt(claims())));});
  for(const method of ['otp','recovery']){
    await run(`valid-${method}-object-native-persistence`,async()=>accepted(jwt(claims(0,{amr:[{method,timestamp:Math.floor(Date.now()/1000)}]}))));
    await run(`valid-${method}-string-native-persistence`,async()=>accepted(jwt(claims(0,{amr:[method]}))));
    for(const [name,value] of [['old7201',()=>Math.floor(Date.now()/1000)-7201],['missing',()=>undefined],['null',()=>null],['nonfinite',()=>1e400],['invalid',()=>'invalid'],['numeric-string',()=>String(Math.floor(Date.now()/1000))],['future120',()=>Math.floor(Date.now()/1000)+120]])await run(`${method}-object-timestamp-${name}`,async()=>refused(await cookie(jwt(claims(0,{amr:[{method,timestamp:value()}]})))));
  }
  for(const [name,override] of [['missing-iat',{iat:undefined}],['nonfinite-iat',{iat:1e400}],['invalid-iat',{iat:'invalid'}],['future-iat',{iat:Math.floor(Date.now()/1000)+120}],['old-iat',{iat:Math.floor(Date.now()/1000)-7201}],['missing-exp',{exp:undefined}],['nonfinite-exp',{exp:1e400}],['invalid-exp',{exp:'invalid'}],['expired-exp',{exp:Math.floor(Date.now()/1000)-1}],['missing-session',{session_id:undefined}],['password-method',{amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]}]])await run(name,async()=>{
    const token=jwt(claims(0,override));const session={access_token:token,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:ids[0],email:'recovery0@fixture.invalid'}};const cookieHeader=`sb-${host.split('.')[0]}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;return refused(cookieHeader);
  });
  const limits=await import('../src/server/api/ref/rateLimit.js');
  for(const [name,reply] of [['null',null],['missing',{}],['null-allowed',{allowed:null}],['string-allowed',{allowed:'true'}]])await run(`rate-limit-malformed-${name}`,async()=>{
    rateReply=reply;const response={statusCode:200,setHeader(){},status(value){this.statusCode=value;return this;},json(value){this.body=value;}};process.env.NODE_ENV='development';process.env.RATE_LIMIT_HASH_SECRET='fixture-rate';
    try{const allowed=await limits.requireRateLimit(response,{key:'send-booking-emails:fixture',max:2});assert.equal(allowed,false);assert.equal(response.statusCode,503);return{allowed,status:response.statusCode,actualSdk:true,injectedHttpPayload:reply};}finally{process.env.NODE_ENV='test';}
  });
  for(const [name,reply] of [['missing',{rateLimit:{}}],['null-allowed',{rateLimit:{allowed:null}}],['string-allowed',{rateLimit:{allowed:'true'}}]])await run(`quote-limit-malformed-${name}`,async()=>{
    quoteReply=reply;const response={statusCode:200,setHeader(){},status(value){this.statusCode=value;return this;},json(value){this.body=value;}};process.env.NODE_ENV='development';process.env.RATE_LIMIT_HASH_SECRET='fixture-rate';
    try{const result=await limits.consumeQuoteRateLimitWithPricing(response,{key:'payment-quote:fixture',packageTitles:['Fixture']});assert.equal(result.allowed,false);assert.equal(response.statusCode,503);return{...result,status:response.statusCode,actualSdk:true,injectedHttpPayload:reply};}finally{process.env.NODE_ENV='test';}
  });
  await run('rate-limit-native-grant-refusal',async()=>{
    await sql`delete from commerce.rate_limit_buckets`;const statuses=[];process.env.NODE_ENV='development';process.env.RATE_LIMIT_HASH_SECRET='fixture-rate';
    try{for(let i=0;i<3;i++){const res={statusCode:200,setHeader(){},status(value){this.statusCode=value;return this;},json(value){this.body=value;}};const allowed=await limits.requireRateLimit(res,{key:'send-booking-emails:fixture',max:2,now:1720000000000});statuses.push({allowed,status:res.statusCode});}assert.deepEqual(statuses,[{allowed:true,status:200},{allowed:true,status:200},{allowed:false,status:429}]);const [bucket]=await sql`select count from commerce.rate_limit_buckets`;assert.equal(bucket.count,3);return{statuses,actualBucketCount:bucket.count};}finally{process.env.NODE_ENV='test';}
  });
  evidence.versions={postgres:fixture.postgresVersion,postgrest:fixture.postgrestVersion};evidence.schemaManifest=fixture.manifest;evidence.fixtureScratch=fixture.scratch;
}catch(error){evidence.setupError={message:error.message,stack:error.stack};process.exitCode=1;}
finally{
  restore?.();bootstrapRestores.forEach(fn=>fn());syncBuiltinESMExports();globalThis.fetch=originalFetch;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(fixture?.stop)await fixture.stop();
  evidence.passed=!evidence.setupError&&evidence.scenarios.length>0&&evidence.scenarios.every(s=>s.passed);fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({artifact,passed:evidence.scenarios.filter(s=>s.passed).length,total:evidence.scenarios.length,setupError:evidence.setupError?.message}));if(!evidence.passed)process.exitCode=1;
}

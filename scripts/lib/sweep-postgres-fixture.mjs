import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

export const root = path.resolve(new URL('../..', import.meta.url).pathname);
const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const migrationDir = path.join(root, 'supabase/migrations');
const jwtSecret = 'local-persistence-proof-secret-never-production';

const bootstrap = `
create role postgres superuser login;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant service_role to ${os.userInfo().username};
create schema extensions;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
create schema auth;
create schema storage;
create schema accounts;
create schema commerce;
create schema licensing;
create schema cms;
create schema migration;
create schema ops;
create table auth.users (
 id uuid primary key, email text, encrypted_password text default '',
 email_confirmed_at timestamptz, banned_until timestamptz,
 raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
 created_at timestamptz default now(), updated_at timestamptz default now()
);
create table auth.identities (
 id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id),
 provider text, provider_id text, email text, identity_data jsonb default '{}'::jsonb,
 created_at timestamptz default now(), updated_at timestamptz default now(), last_sign_in_at timestamptz
);
create table auth.sessions (id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id));
create table auth.refresh_tokens (id bigint generated always as identity primary key,user_id text,token text);
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub' $$;
create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,metadata jsonb default '{}'::jsonb);
grant usage on schema public,accounts,commerce,licensing,cms,migration,auth,ops to service_role;
`;

const readMigration = (name) => fs.readFileSync(path.join(migrationDir, name), 'utf8');
export const functionDefinition = (name, qualifiedName) => {
  const source = readMigration(name);
  const escaped = qualifiedName.replaceAll('.', '\\.');
  const expression = new RegExp(`create(?: or replace)? function ${escaped}\\([\\s\\S]*?\\n(?:\\$\\$|\\$[a-z_]+\\$);`, 'i');
  const match = source.match(expression);
  assert.ok(match, `Actual definition missing: ${name}:${qualifiedName}`);
  return match[0];
};

const freePort = async () => {
  const server = net.createServer();
  server.listen(0, host);
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

export const createSweepPostgresFixture = async ({ commerceRepairMigration = true, fullMigrationChain = false, beforeMigrations, pgBin: requestedPgBin, postgrestBin: requestedPostgrestBin, libraryPath } = {}) => {
  assert.equal(process.env.ROO_TEST_POSTGRES_HOST || host, host);
  const pgBin = requestedPgBin || process.env.PG_BIN || '/tmp/roo-request-pg17/runtime/usr/lib/postgresql/17/bin';
  const postgrestBin = requestedPostgrestBin || process.env.POSTGREST_BIN || '/tmp/roo-request-postgrest/postgrest';
  const env = {...process.env, LC_ALL: 'C', LD_LIBRARY_PATH: libraryPath || process.env.LD_LIBRARY_PATH || '/tmp/roo-request-pg17/runtime/usr/lib/x86_64-linux-gnu'};
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-persistence-sweep-'));
  const dataDir = path.join(scratch, 'data');
  const pgPort = await freePort();
  const restPort = await freePort();
  const run = (binary, args) => {
    const result = spawnSync(binary, args, {env, encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
    if (result.status !== 0) throw new Error(`${path.basename(binary)} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  let postgresVersion, postgrestVersion;
  const manifest = [];
  const requestLog = [];
  let sql;
  let proxy;
  let restProcess;
  let started = false;
  let requestHook = null;
  let authHandler = null;
  let providerHandler = null;
  const stop = async () => {
    if (proxy) {proxy.closeAllConnections();await new Promise((resolve)=>proxy.close(resolve));proxy=null;}
    if (restProcess && restProcess.exitCode === null) {restProcess.kill('SIGTERM');await once(restProcess,'exit');}
    if (sql) await sql.end({timeout:5});
    if (started) {run(path.join(pgBin,'pg_ctl'),['-D',dataDir,'-m','fast','-w','stop']);started=false;}
  };
  try {
    postgresVersion = run(path.join(pgBin,'postgres'),['--version']);
    assert.match(postgresVersion,/PostgreSQL\) 17\./);
    postgrestVersion = run(postgrestBin,['--version']);
    run(path.join(pgBin,'initdb'),['-D',dataDir,'--auth=trust','--no-locale',...(fullMigrationChain ? ['--encoding=UTF8'] : [])]);
    fs.appendFileSync(path.join(dataDir,'pg_hba.conf'),'\nhost all all samehost trust\n');
    run(path.join(pgBin,'pg_ctl'),['-D',dataDir,'-l',path.join(scratch,'postgres.log'),'-o',`-p ${pgPort} -h ${host} -k ${scratch}`,'-w','start']);
    started=true;
    sql=postgres({host,port:pgPort,database:'postgres',max:8,prepare:false,onnotice(notice){fs.appendFileSync(path.join(scratch,'schema-notices.log'),`${notice.message}\n`);}});
    let migrationConnection;
    const apply = async (name, text = readMigration(name), selection = 'complete migration') => {
      try {await (migrationConnection || sql).unsafe(text);} catch (error) {throw new Error(`Schema closure ${name} (${selection}): ${error.message}`,{cause:error});}
      const output=path.join(scratch,`applied-${manifest.length}.sql`);
      fs.writeFileSync(output,text);
      manifest.push({file:`supabase/migrations/${name}`,selection,sha256:crypto.createHash('sha256').update(text).digest('hex'),appliedSql:output});
    };
    const selectedBootstrap = fullMigrationChain ? fs.readFileSync(path.join(root, 'scripts/fixtures/sanity-sql/platform-bootstrap.sql'), 'utf8') : bootstrap;
    const bootstrapSql = beforeMigrations ? selectedBootstrap.replace(/^create table storage\.(buckets|objects).*;$/gm, '') : selectedBootstrap;
    await sql.unsafe(bootstrapSql.replace("select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'", "select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid"));
    if (beforeMigrations) await beforeMigrations({sql,scratch,host,pgPort,restPort,jwtSecret,databaseUrl:`postgres://${os.userInfo().username}@${host}:${pgPort}/postgres`});
    if (fullMigrationChain) {
      migrationConnection = await sql.reserve();
      try {
        for (const name of fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()) await apply(name);
      } finally { migrationConnection.release(); migrationConnection = null; }
    } else {
    for(const name of [
      '20260710205423_create_identity_and_licensing_foundation.sql',
      '20260710205604_create_commerce_shadow_foundation.sql',
      '20260710205653_create_cms_and_migration_foundation.sql',
      '20260710210522_add_shadow_document_rpc.sql',
      '20260710213001_harden_shadow_foundation.sql',
      '20260710213733_add_operational_shadow_projector.sql',
      '20260710233927_reconcile_removed_shadow_sources.sql',
      '20260711021036_harden_live_shadow_convergence.sql',
      '20260711200636_close_commerce_cutover_gaps.sql',
      '20260711211808_make_email_dispatch_ledger_authoritative.sql',
    ]) await apply(name);
    await apply('20260711001953_add_mirror_recovery_queue.sql');
    await apply('20260711204650_guard_commerce_mirror_deletes.sql');
    const social='20260712060649_add_social_identity_linking_and_discord_roles.sql';
    await apply(social,readMigration(social).split('create or replace function public.roo_account_by_user_id')[0],'actual account DDL/backfill prefix');
    const unified='20260712092342_close_supabase_port_and_unified_auth.sql';
    await apply(unified,readMigration(unified).split('create or replace function accounts.real_verified_email')[0],'actual principal/mapping/credential DDL and assign-principal triggers');
    for(const name of ['accounts.real_verified_email','accounts.principal_account_json','public.roo_account_by_user_id','public.roo_resolve_account_alias','public.roo_resolve_tourney_account_alias','public.roo_validate_referral_session','public.roo_referral_earnings_summary']) {
      await apply(unified,functionDefinition(unified,name),name);
    }
    const accountRpc='20260710211428_add_account_and_licensing_rpc.sql';
    await apply(accountRpc,functionDefinition(accountRpc,'public.roo_complete_credential_migration'),'actual credential-migration checkpoint dependency');
    const integrity='20260712031331_harden_commerce_integrity_and_recovery.sql';
    await apply(integrity,readMigration(integrity).split('update licensing.products')[0],'actual commerce DDL/functions prefix; unrelated licensing/Tourney section excluded');
    const debt='20260712094431_close_historical_commerce_debt.sql';
    await apply(debt,readMigration(debt).split('create or replace function')[0],'actual payment debt DDL prefix');
    await apply(debt,functionDefinition(debt,'migration.project_commerce_recovery_fields'),'current actual recovery projector');
    await apply(unified,functionDefinition(unified,'public.roo_complete_commerce_mirror_event'),'current actual commerce mirror completion');
    await apply('20260715080000_add_referral_creator_terms_editor.sql');
    await apply('20260715090000_add_document_mutation_mirror_outbox.sql');
    await apply('20260715100000_add_referral_fallback_authority.sql');
    await apply('20260715130000_harden_credential_recovery_saga.sql');
    await apply('20260718010000_serialize_commerce_slot_claims.sql');
    await apply('20260718011000_bound_commerce_mutations.sql');
    await apply('20260718023317_harden_credential_reconciliation_retry.sql');
    await apply('20260720090000_harden_referral_mutations_and_lifecycle.sql');
    const projector='20260712092342_close_supabase_port_and_unified_auth.sql';
    await apply(projector,functionDefinition(projector,'migration.project_referral_source_change')+'\n'+readMigration(projector).match(/create trigger source_documents_project_referral[\s\S]*?;/)[0],'actual referral source trigger');
    await apply('20260720093000_ignore_namespaced_mirror_metadata.sql');
    await apply('20260817153000_stop_stale_commerce_retry_storm.sql');
    await apply('20260819043000_add_creator_registration_conflict_lookup.sql');
    await apply('20260906120000_preserve_native_claims_during_shadow_refresh.sql');
    await apply('20260906130000_index_targeted_booking_lookups.sql');
    await apply('20260909090000_add_dodo_payment_provider.sql');
    await apply('20260910090000_add_dodo_full_projection.sql');
    await apply('20260910100000_filter_dodo_recovery_candidates.sql');
    await apply('20260910110000_recover_dodo_partial_refunds.sql');
    if (commerceRepairMigration) await apply('20261005000000_terminalize_unknown_booking_email_delivery.sql');
    }
    await sql.unsafe("update migration.commerce_control set primary_backend='supabase',generation=0,starts_paused=false");
    if (!fullMigrationChain) await sql.unsafe('grant usage on schema public,accounts,commerce,licensing,cms,migration,ops to service_role; grant execute on all functions in schema public,accounts,migration to service_role; grant all on all tables in schema public,accounts,commerce,licensing,cms,migration,ops to service_role; grant usage,select on all sequences in schema accounts,commerce,migration to service_role;');
    const restLog=fs.openSync(path.join(scratch,'postgrest.log'),'a');
    restProcess=spawn(postgrestBin,[],{env:{...env,PGRST_DB_URI:`postgres://${os.userInfo().username}@${host}:${pgPort}/postgres`,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:jwtSecret,PGRST_SERVER_HOST:host,PGRST_SERVER_PORT:String(restPort)},stdio:['ignore',restLog,restLog]});
    fs.closeSync(restLog);
    const upstreamFetch=globalThis.fetch;
    for(let n=0;n<100;n++) {
      try {const r=await upstreamFetch(`http://${host}:${restPort}/`,{signal:AbortSignal.timeout(300)});if(r.status<500)break;} catch{}
      assert.ok(restProcess.exitCode===null,fs.readFileSync(path.join(scratch,'postgrest.log'),'utf8'));
      if(n===99)throw new Error('PostgREST readiness deadline exceeded');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    proxy=http.createServer(async(req,res)=>{
      try {
        const parts=[];for await(const chunk of req)parts.push(chunk);
        const body=Buffer.concat(parts);
        const parsed=body.length?(String(req.headers['content-type']||'').includes('application/json')?JSON.parse(body):body.toString()):null;
        const request={method:req.method,path:req.url,body:parsed};
        requestLog.push({method:req.method,path:req.url,rpc:req.url.startsWith('/rest/v1/rpc/')?req.url.slice(13):null});
        if(req.url.startsWith('/provider/')) {
          assert.ok(providerHandler,'Provider HTTP response fixture must be explicitly supplied');
          const result=await providerHandler({...request,path:req.url.slice(9)});
          res.writeHead(result.status||200,{'content-type':'application/json'});res.end(JSON.stringify(result.body));return;
        }
        if(req.url.startsWith('/auth/v1/')) {
          assert.ok(authHandler,'Auth response fixture must be explicitly supplied');
          const result=await authHandler(request);
          res.writeHead(result.status||200,{'content-type':'application/json'});res.end(JSON.stringify(result.body));return;
        }
        assert.ok(req.url.startsWith('/rest/v1/'),'transparent proxy only supports REST/Auth paths');
        if(requestHook)await requestHook('before',request);
        const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
        const response=await upstreamFetch(`http://${host}:${restPort}${req.url.slice(8)}`,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,signal:AbortSignal.timeout(30000)});
        const responseBody=await response.text();
        if(requestHook)await requestHook('after',{...request,status:response.status,response:responseBody?JSON.parse(responseBody):null});
        res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});res.end(responseBody);
      }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:'FIXTURE_PROXY_ERROR',message:error.message}));}
    });
    proxy.listen(0,host);await once(proxy,'listening');
    const origin=`http://${host}:${proxy.address().port}`;
    const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({role:'service_role',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
    const token=`${header}.${payload}.${crypto.createHmac('sha256',jwtSecret).update(`${header}.${payload}`).digest('base64url')}`;
    const client=createClient(origin,token,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}});
    return {sql,client,origin,token,scratch,manifest,requestLog,postgresVersion,postgrestVersion,postgrestUrl:`http://${host}:${restPort}`,pgPort,restPort,postgrestPid:restProcess.pid,stop,apply,setRequestHook(fn){requestHook=fn;},setAuthHandler(fn){authHandler=fn;},setProviderHandler(fn){providerHandler=fn;}};
  } catch(error) {await stop();throw Object.assign(error,{scratch,manifest});}
};

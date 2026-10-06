import argparse,hashlib,json,os,re,socket,subprocess,tempfile,time
from pathlib import Path
P=argparse.ArgumentParser();P.add_argument('--scenario',default='release');A=P.parse_args()
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'test-results/sanity-sql';OUT.mkdir(parents=True,exist_ok=True)
BIN=Path('/tmp/roo-request-pg17/runtime/usr/lib/postgresql/17/bin')
ENV={'PATH':'/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','LD_LIBRARY_PATH':'/tmp/roo-request-pg17/runtime/usr/lib/x86_64-linux-gnu','PGCONNECT_TIMEOUT':'5'}
RUN=Path(tempfile.mkdtemp(prefix='roo-sanity-sql-'));DATA=RUN/'data'
with socket.socket() as s:s.bind(('127.0.0.1',0));PORT=str(s.getsockname()[1])
report={'scenario':A.scenario,'startedAt':time.time(),'scratch':str(RUN),'migrations':[],'checks':[],'passed':False}
def command(args,body=None,check=True):
 r=subprocess.run([str(x) for x in args],input=body,text=True,capture_output=True,env=ENV,timeout=180)
 if check and r.returncode:raise RuntimeError(r.stderr[-7000:])
 return r
def sql(body,check=True):return command([BIN/'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',RUN,'-p',PORT,'-U','serviroo','-d','postgres'],body,check)
def value(body):
 raw=sql(body).stdout.strip();return json.loads(raw) if raw else None
def apply(body):
 body=re.sub(r'(?im)^\s*(begin|commit)\s*;\s*$','',body)
 return sql('begin;\n'+body+'\ncommit;')
def catalog():
 return value("""select jsonb_build_object('functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),'config',p.proconfig) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','migration','commerce','accounts','cms','licensing','tourney','ops') and p.prokind='f' and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')),'tables',(select jsonb_agg(jsonb_build_object('table',c.oid::regclass::text,'acl',c.relacl::text,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid=c.oid),'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'roles',p.polroles::text,'permissive',p.polpermissive,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=c.oid),'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'def',pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid=c.oid),'triggers',(select jsonb_agg(jsonb_build_object('name',tgname,'def',pg_get_triggerdef(oid)) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal)) order by c.oid::regclass::text) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','migration','commerce','accounts','cms','licensing','tourney','ops')));""")
def save(name,obj): (OUT/name).write_text(json.dumps(obj,indent=2) if not isinstance(obj,str) else obj)
def check(name,actual,expected=True):
 report['checks'].append({'name':name,'actual':actual,'expected':expected,'passed':actual==expected})
 if actual!=expected:raise AssertionError(name+': '+str(actual))
exec((ROOT/'scripts/fixtures/sanity-sql/scenarios.py').read_text())
started=False;inflight=None
try:
 report['postgresVersion']=command([BIN/'postgres','--version']).stdout.strip();assert '17.' in report['postgresVersion']
 command([BIN/'initdb','-D',DATA,'--auth=trust','--no-locale','--encoding=UTF8']);command([BIN/'pg_ctl','-D',DATA,'-l',RUN/'postgres.log','-o',f'-p {PORT} -h 127.0.0.1 -k {RUN}','-w','start']);started=True
 sql((ROOT/'scripts/fixtures/sanity-sql/platform-bootstrap.sql').read_text())
 files=sorted((ROOT/'supabase/migrations').glob('*.sql'));new=[p for p in files if p.name>'20261005000500_project_booking_payment_currency_subunits.sql']
 for p in files:
  if p in new:continue
  apply(p.read_text());report['migrations'].append({'file':str(p.relative_to(ROOT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 seed_release()
 golden=hot_paths();save('hot-before.json',golden)
 before=catalog();save('catalog-before.json',before)
 rows_before=snapshot_rows();save('rows-before.json',rows_before)
 inflight=start_inflight_writer()
 for p in new:
  apply(p.read_text());report['migrations'].append({'file':str(p.relative_to(ROOT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 after=catalog();save('catalog-after.json',after)
 capture_catalog_diff(before,after)
 inventory=value("""select jsonb_build_object('functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text) from pg_proc p where p.prokind in ('f','p')),'triggers',(select jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid),'functionDefinition',pg_get_functiondef(t.tgfoid)) order by t.tgrelid::regclass::text,t.tgname) from pg_trigger t where not t.tgisinternal));""")
 prove_lock_order(inventory,before)
 pattern=r'insert\s+into\s+migration\.(commerce_mirror_outbox|document_mutation_mirror_outbox)'
 writers=[f['signature'] for f in inventory['functions'] if re.search(pattern,f['definition'],re.I)]
 feeding=[t for t in inventory['triggers'] if re.search(pattern,t['functionDefinition'],re.I)]
 save('outbox-writer-proof.json',{'writers':writers,'feedingTriggers':feeding,'scannedFunctions':len(inventory['functions']),'scannedTriggers':len(inventory['triggers']),'triggerInventory':inventory['triggers']})
 check('zero outbox inserts across every catalog function/procedure',writers,[])
 check('zero trigger bodies feeding outboxes across every schema',feeding,[])
 check('zero final outbox inserts',sum(bool(re.search(r'insert\s+into\s+migration\.(commerce_mirror_outbox|document_mutation_mirror_outbox)',f['definition'],re.I)) for f in after['functions']),0)
 check('zero fallback mirror trigger bindings',sum(t['name'] in ('principals_refresh_creator_fallback_authority','creator_profiles_refresh_creator_fallback_authority','account_roles_refresh_creator_fallback_authority') for table in after['tables'] for t in table['triggers'] or []),0)
 hot=hot_paths();save('hot-after.json',hot);check('native hot path result shapes unchanged',list(map(shape,hot)),list(map(shape,golden)))
 rows_after=snapshot_rows();save('rows-after.json',rows_after);preservation(rows_before,rows_after)
 finish_inflight_writer(*inflight);inflight=None
 projection_owner_cases()
 run_release_cases()
 run_lock_order_cases()
 run_concurrent_cases()
 create_intent_cases()
 extra_credential_cases()
 upload_sql_cases()
 check('target encoding and case-mapping prerequisites',value((ROOT/'supabase/release/sanity-removal/target-prerequisites.sql').read_text()),{'utf8_required':True,'icu_root_case_mapping_required':True,'document_writer_present':True,'commerce_writer_present':True,'cms_commerce_writer_present':True})
 for impact in sorted((ROOT/'supabase/release/sanity-removal').glob('impact-*.sql')):
  output=sql(impact.read_text()).stdout;save(impact.stem+'.json',{'countOnlyOutput':output})
 rollback_release(before,after)
 exact=command(['/usr/bin/python3',ROOT/'scripts/verify-sanity-target-catalog.py','--capture',OUT/'catalog-rollback.json','--artifact',OUT/'target-catalog-exact-local.json'])
 check('target catalog verifier accepts exact actual rollback capture',exact.returncode,0)
 sql("alter function public.roo_apply_document_mutations(jsonb) set search_path='public';")
 save('catalog-drift-local.json',catalog())
 drift=command(['/usr/bin/python3',ROOT/'scripts/verify-sanity-target-catalog.py','--capture',OUT/'catalog-drift-local.json','--artifact',OUT/'target-catalog-drift-local.json'],check=False)
 check('target catalog verifier refuses actual function configuration drift',drift.returncode,1)
 report['passed']=True
except Exception as e:
 report['error']=str(e);raise
finally:
 if inflight:
  for child in inflight:
   if child.poll() is None:child.terminate();child.wait(timeout=10)
 if started:command([BIN/'pg_ctl','-D',DATA,'-m','fast','-w','stop'])
 report['endedAt']=time.time();report['stopped']=True;save('release.json',report)
 print(json.dumps({'passed':report['passed'],'artifact':str(OUT/'release.json'),'error':report.get('error')}))

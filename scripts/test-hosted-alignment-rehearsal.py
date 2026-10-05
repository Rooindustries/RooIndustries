import os,sys,json,re,hashlib,subprocess,tempfile,shutil,time,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Local PostgreSQL hosted-catalog alignment rehearsal; no hosted requests.')
for name,env in [('input-dir','ROO_ALIGNMENT_INPUT_DIR'),('output-dir','ROO_ALIGNMENT_OUTPUT_DIR'),('release-dir','ROO_RELEASE_DIR'),('pg-bin','PG_BIN'),('pg-library-dir','LD_LIBRARY_PATH'),('port','ROO_ALIGNMENT_PORT'),('sunshine-migrations-dir','ROO_ALIGNMENT_SUNSHINE_MIGRATIONS'),('commerce-preimage','ROO_ALIGNMENT_COMMERCE_PREIMAGE')]:
 parser.add_argument('--'+name,default=os.environ.get(env),required=not bool(os.environ.get(env)))
parser.add_argument('--repo',default=os.environ.get('ROO_ALIGNMENT_REPO',str(Path.cwd())))
ARGS=parser.parse_args()
W=Path(ARGS.input_dir).resolve(); REPO=Path(ARGS.repo).resolve(); BIN=Path(ARGS.pg_bin).resolve()
OUTPUT=Path(ARGS.output_dir).resolve(); RELEASE=Path(ARGS.release_dir).resolve()
SUNSHINE=Path(ARGS.sunshine_migrations_dir).resolve(); COMMERCE_PREIMAGE=Path(ARGS.commerce_preimage).resolve()
if not ARGS.port.isdigit() or not 1024<=int(ARGS.port)<=65535:parser.error('port must be an explicit integer from1024 to65535')
PORT=ARGS.port
for path in [OUTPUT,RELEASE]:
 if path==REPO or REPO in path.parents:parser.error('private output/release directories must be outside the repository')
for path in [W,REPO/'supabase/migrations',SUNSHINE,BIN,Path(ARGS.pg_library_dir)]:
 if not path.is_dir():parser.error('required directory missing: '+str(path))
for path in [W/name for name in ['hosted-full-catalog.sql','hosted-full-catalog.raw.json','ledger-statements.raw.json','stub.sql','local-branch.json','hosted-alignment-extra.raw.json','tourney-state.raw.json','missing-capture-read-only.sql']]+[COMMERCE_PREIMAGE]+[BIN/name for name in ['postgres','initdb','pg_ctl','psql']]:
 if not path.is_file():parser.error('required input or binary missing: '+str(path))
os.umask(0o077)
for path in [OUTPUT,RELEASE]:path.mkdir(parents=True,exist_ok=True,mode=0o700);path.chmod(0o700)
ENV={'PATH':'/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','LD_LIBRARY_PATH':ARGS.pg_library_dir,'PGCONNECT_TIMEOUT':'5'}
RUN=Path(tempfile.mkdtemp(prefix='alignment-run-',dir=OUTPUT)); RUN.chmod(0o700); DATA=RUN/'pgdata'
for filename in ['pgpass-empty','pgservice-empty']:(RUN/filename).write_text('')
ENV.update(PGPASSFILE=str(RUN/'pgpass-empty'),PGSERVICEFILE=str(RUN/'pgservice-empty'))
(OUTPUT/'alignment-latest-path').write_text(str(RUN)+'\n'); (OUTPUT/'alignment-latest-path').chmod(0o600)
CATSQL="set search_path=public,extensions;\n"+(W/'hosted-full-catalog.sql').read_text()
HOST=json.loads((W/'hosted-full-catalog.raw.json').read_text())['rows'][0]['catalog']
ROWS=json.loads((W/'ledger-statements.raw.json').read_text())['rows']
MISSING=['20260715060000','20260716025151','20260717231518','20260718010000','20260718011000','20260718012000','20260718013000','20260817080000','20260914000000','20260914010000']
FIXTURES=REPO/'scripts/fixtures/hosted-alignment'
def impact_file(name):return FIXTURES/name if (FIXTURES/name).exists() else W/name
EXTRA_PATH=W/'hosted-alignment-extra.raw.json'
EXTRA=json.loads(EXTRA_PATH.read_text()) if EXTRA_PATH.exists() else None
if EXTRA and 'rows' in EXTRA:EXTRA=EXTRA['rows'][0]['capture']
TOURNEY_PATH=W/'tourney-state.raw.json'
TOURNEY=json.loads(TOURNEY_PATH.read_text())['rows'][0]['state'] if TOURNEY_PATH.exists() else None
PLATFORM_PROOF={}
INPUTS={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((REPO/'supabase/migrations').glob('*.sql'))}

def save(name,obj):
 p=RUN/name; p.write_text(json.dumps(obj,indent=2) if not isinstance(obj,str) else obj);p.chmod(0o600)
def cmd(args,check=True):
 r=subprocess.run([str(a) for a in args],env=ENV,capture_output=True,text=True)
 if check and r.returncode: raise RuntimeError(str(args)+ '\n'+r.stderr[-6000:])
 return r

def sql(db,body,check=True):
 r=subprocess.run([str(BIN/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(RUN),'-p',PORT,'-U','postgres','-d',db],input=body,env=ENV,capture_output=True,text=True)
 if check and r.returncode: raise RuntimeError(db+' SQL failed:\n'+r.stderr[-6000:])
 return r

def release_body(body):
 clean=re.sub(r'(?im)^\s*(begin|commit)\s*;\s*$', '',body)
 return re.sub(r"(?im)^set (lock_timeout|statement_timeout)([ \t]*=[ \t]*'[^'\n]+'[ \t]*;[ \t]*)$",r'set local \1\2',clean)

def apply(db,body,check=True):
 clean=release_body(body)
 return sql(db,'begin;\n'+clean+'\ncommit;',check)

def catalog(db):return json.loads(sql(db,CATSQL).stdout)

def norm(cat,host=False):
 c=json.loads(json.dumps(cat)); c.pop('observed_at',None);c.pop('transaction_read_only',None);c.pop('schemas',None)
 roles=(supplemental_capture() or {}).get('policy_roles',{'16484':'anon','16485':'authenticated','16486':'service_role'}) if host else {r['oid']:r['rolname'] for r in json.loads(sql('replica',"select json_agg(json_build_object('oid',oid::text,'rolname',rolname)) from pg_roles").stdout)}
 roles['0']='PUBLIC'
 for t in c['tables']:
  for field in ['cons','idx','trg']:
   if t.get(field) is not None:t[field]=sorted(t[field])
  t['pol']=[re.sub(r'roles:\{([^}]*)\}',lambda m:'roles:{'+','.join(sorted(roles.get(x,x) for x in m[1].split(',')))+'}',x) for x in t['pol'] or []]
 for k,key in [('functions','sig'),('tables','t')]:
  for obj in c[k]:
   if obj.get('acl'):obj['acl']='{'+','.join(sorted(obj['acl'][1:-1].split(',')))+'}'
  c[k]=sorted(c[k],key=lambda x:x[key])
 return c

def differences(a,b):
 out=[]
 for kind,key in [('functions','sig'),('tables','t')]:
  aa={x[key]:x for x in a[kind]};bb={x[key]:x for x in b[kind]}
  for k in sorted(set(aa)|set(bb)):
   if aa.get(k)!=bb.get(k):out.append({'kind':kind,'name':k,'fields':{f:{'expected':(aa.get(k) or {}).get(f),'actual':(bb.get(k) or {}).get(f)} for f in sorted(set(aa.get(k) or {})|set(bb.get(k) or {})) if (aa.get(k) or {}).get(f)!=(bb.get(k) or {}).get(f)}})
 return out

def build(db,hosted=False):
 sql('postgres','create database '+db);sql(db,(W/'stub.sql').read_text());sql(db,'create schema ops;')
 files=list((REPO/'supabase/migrations').glob('*.sql'))
 plan=[]
 if hosted:
  for r in sorted(ROWS,key=lambda r:r['version']):
   ff=[f for f in files if f.name.split('_',1)[1][:-4]==r['name']]
   sunshine=list(SUNSHINE.glob('*_'+r['name']+'.sql'))
   if ff or sunshine:
    source=(ff or sunshine)[0];body=source.read_text()
   else:
    source=W/'ledger'/(r['version']+'_'+r['name']+'.sql');body='\n'.join(x.rstrip().rstrip(';')+';' for x in r['statements'] or [])
   plan.append((source,body,r['version']))
 else:plan=[(p,p.read_text(),p.name.split('_',1)[0]) for p in sorted(files)]
 logs=[]
 for source,body,version in plan:
  if hosted and 'reset_tourney_hardening_clock_for_baseline_recovery' in str(source):
   sql(db,"update tourney.cutover_metadata set hardened_active=false where id='tourney';")
  if hosted and version=='20260714230254':
   sql(db,"update tourney.cutover_metadata set hardened_active=false where id='tourney';")
  r=apply(db,body,False); logs.append({'source':str(source),'sha256':hashlib.sha256(body.encode()).hexdigest(),'exit':r.returncode,'stderr':r.stderr})
  if r.returncode: save(db+'-bootstrap.json',logs); raise RuntimeError('bootstrap '+str(source)+'\n'+r.stderr)
 save(db+'-bootstrap.json',logs)
 return catalog(db)

def definitions(db):
 return json.loads(sql(db,"select json_agg(json_build_object('sig',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')','regsig',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','accounts','licensing','migration','commerce','tourney','ops','cms') and p.prokind in ('f','p') and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')").stdout)

def replica_overrides(db):
 before=catalog(db); statements=[]
 statements.append(COMMERCE_PREIMAGE.read_text().rstrip().rstrip(';')+';')
 ledger=(W/'ledger/20260712224034_activate_tourney_schema_v4.sql').read_text()
 m=re.search(r'create or replace function tourney.capture_mirror_event\(\).*?\n\$\$;',ledger,re.S|re.I);statements.append(m[0])
 statements.extend(['drop function public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text);','drop function public.roo_backfill_tourney_email_history_v4(text);'])
 local={t['t']:t for t in before['tables']};priv={'a':'insert','r':'select','w':'update','d':'delete','D':'truncate','x':'references','t':'trigger','m':'maintain'}
 for t in HOST['tables']:
  if t['t'] not in local:continue
  actual=local[t['t']]
  if t['acl']!=actual['acl'] and t['acl']:
   statements.append('revoke all on table '+t['t']+' from public,anon,authenticated,service_role;')
   for entry in t['acl'][1:-1].split(','):
    role,parts=entry.split('=',1); flags=parts.split('/')[0]
    if role=='postgres':continue
    statements.append('grant '+','.join(priv[c] for c in flags if c in priv)+' on table '+t['t']+' to '+(role or 'public')+';')
  for field in ['idx','cons','trg']:
   aa=set(actual.get(field) or []); hh=set(t.get(field) or [])
   for old in aa-hh:
    if field=='idx':statements.append('drop index '+t['t'].split('.')[0]+'.'+old.split('INDEX ',1)[1].split(' ON ',1)[0]+';')
    elif field=='cons':statements.append('alter table '+t['t']+' drop constraint '+old.split(' ',1)[0]+';')
    else:statements.append('drop trigger '+old.split(' ',1)[0]+' on '+t['t']+';')
   for new in hh-aa:
    if field=='idx':statements.append(new+';')
    elif field=='cons':name,definition=new.split(' ',1);statements.append('alter table '+t['t']+' add constraint '+name+' '+definition+';')
    else:statements.append(new.split(' ',2)[2]+';')
 body='\n'.join(statements);save('replica-captured-overrides.sql',body);apply(db,body);restore_extra_capture(db)
 return catalog(db)

def row_snapshot(db):
 tables=json.loads(sql(db,"select json_agg(n.nspname||'.'||c.relname order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('commerce','licensing','accounts','tourney','migration','cms','public','auth') and not exists(select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')").stdout)
 parts=["select "+quote(t)+" as t,coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) as rows from "+t+" r" for t in tables]
 return json.loads(sql(db,"select jsonb_object_agg(t,rows) from ("+' union all '.join(parts)+") s").stdout)

def row_diff(before,after):
 return [{'table':t,'before_count':len(before.get(t,[])),'after_count':len(after.get(t,[])),'before_sha256':hashlib.sha256(json.dumps(before.get(t,[]),sort_keys=True).encode()).hexdigest(),'after_sha256':hashlib.sha256(json.dumps(after.get(t,[]),sort_keys=True).encode()).hexdigest()} for t in sorted(set(before)|set(after)) if before.get(t)!=after.get(t)]

def preservation_proof(before,after):
 from collections import Counter
 rows=[]
 for table in sorted(set(before)|set(after)):
  old=before.get(table,[]);new=after.get(table,[]);fields=set(old[0]) if old else set()
  encode=lambda row:json.dumps(row,sort_keys=True,separators=(',',':'))
  projected=[{k:row[k] for k in fields} for row in new] if fields else new
  old_counts=Counter(map(encode,old));new_counts=Counter(map(encode,projected))
  unchanged=not (old_counts-new_counts);extra=new_counts-old_counts
  added_columns=sorted(set(new[0])-fields) if new and fields else []
  allowed_columns={'accounts.oauth_intents':['recovery_for_intent_id'],'accounts.reauth_grants':['bound_at','bound_intent_id']}.get(table,[])
  expected_count=len(old)+(2 if table=='commerce.email_dispatches' else 0)
  valid=unchanged and len(new)==expected_count and added_columns==allowed_columns and all(row[k] is None for row in new for k in added_columns)
  if table=='commerce.email_dispatches':
   inserted=[json.loads(value) for value,count in extra.items() for _ in range(count)]
   valid=valid and len(inserted)==2 and {r['idempotency_key'] for r in inserted}=={'booking-alignment-unknown-client','booking-alignment-unknown-owner'} and all(r['status']=='historical_unknown' and r['lease_id'] is None and r['lease_expires_at'] is None and r['next_attempt_at'] is None for r in inserted)
  kept=[json.loads(value) for value,count in (old_counts&new_counts).items() for _ in range(count)]
  hash_rows=lambda values:hashlib.sha256(json.dumps(sorted(values,key=encode),sort_keys=True).encode()).hexdigest()
  rows.append({'table':table,'before_count':len(old),'after_count':len(new),'before_original_fields_sha256':hash_rows(old),'after_original_fields_sha256':hash_rows(kept),'existing_row_fields_unchanged':unchanged,'added_null_columns':added_columns,'documented_effects_only':valid})
 save('data-preservation-summary.json',rows)
 if any(not row['documented_effects_only'] for row in rows):raise RuntimeError('Undocumented seeded data change '+str([x['table'] for x in rows if not x['documented_effects_only']]))


def quote(v):return "'"+v.replace("'","''")+"'"
def regsig(sig):
 return re.sub(r'\b[pv]_[A-Za-z0-9_]+ ', '',sig)
def function_guard(cat,names):
 f={x['sig']:x for x in cat['functions']};clauses=[]
 for name in sorted(names):
  old=f.get(name)
  expected={k:old[k] for k in ['md5','owner','secdef','config']} if old else None
  if old:expected['acl']=','.join(sorted(old['acl'][1:-1].split(','))) if old['acl'] else None
  literal=quote(json.dumps(expected))+'::jsonb' if expected else 'null::jsonb'
  expression="select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'="+quote(name)
  clauses.append('if ('+expression+') is distinct from '+literal+" then raise exception 'Unknown function preimage: %',"+quote(name)+" using errcode='55000'; end if;")
 return 'do $guard$ begin\n'+'\n'.join(clauses)+'\nend $guard$;\n'

def adapted_body(version,original,before,expected_defs):
 if version=='20260715060000':
  old='alter function public.roo_tourney_readiness()\n  rename to roo_tourney_readiness_before_trigger_binding_v4;'
  if original.count(old)!=1:raise RuntimeError('tourney repair source changed')
  original=original.replace(old,'').replace('create function public.roo_tourney_readiness()', 'create or replace function public.roo_tourney_readiness()')
  active="v_meta.hardened_active and exists(select 1 from tourney.mirror_contracts where enabled)"
  if original.count('if v_meta.hardened_active and (')!=1 or original.count('if v_meta.hardened_active then')!=1:raise RuntimeError('tourney active repair branches changed')
  original=original.replace('if v_meta.hardened_active and (','if '+active+' and (').replace('if v_meta.hardened_active then','if '+active+' then')
  original="do $release_retirement$ begin lock table tourney.mirror_contracts in share row exclusive mode; if exists(select 1 from tourney.mirror_contracts where enabled) then raise exception 'Alignment requires retired zero-enabled mirror contracts' using errcode='55000'; end if; end $release_retirement$;\n"+original
  original=re.sub(r'create or replace function tourney.mirror_trigger_binding_status_v4\(\).*?\n\$\$;', '', original, flags=re.S|re.I)
  original+="\ndo $retired$ begin if not exists(select 1 from tourney.mirror_contracts where enabled) then drop trigger if exists capture_tourney_mirror_event on accounts.discord_role_assignments; end if; end $retired$;\n"
  required=['public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)','public.roo_backfill_tourney_email_history_v4(p_actor text)','tourney.capture_mirror_event()']
  funcs={f['sig']:f for f in expected_defs}
  for name in required:
   original+='\n'+funcs[name]['definition']+';\n'
   sig=regsig(name);acl=next(f for f in json.loads((RUN/'expected-current-branch.json').read_text())['functions'] if f['sig']==name)['acl']
   original+='revoke all on function '+sig+' from public,anon,authenticated,service_role;\n'
   if 'service_role=X/' in acl:original+='grant execute on function '+sig+' to service_role;\n'

 elif version=='20260718011000':
  a=original.index('alter function public.roo_apply_commerce_document_mutations(');b=original.index('create function public.roo_apply_commerce_document_mutations(',a)
  original=original[:a]+original[b:];original=original.replace('create function public.roo_apply_commerce_document_mutations(', 'create or replace function public.roo_apply_commerce_document_mutations(')
 else:raise RuntimeError('unexpected adaptation '+version)
 return original

def relation_shape_sql(name):
 return """select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass("""+quote(name)+")"

def state(db):
 c=catalog(db);defs=definitions(db)
 shapes={t['t']:json.loads(sql(db,'set search_path=public,extensions;'+relation_shape_sql(t['t'])).stdout) for t in c['tables']}
 constraints=json.loads(sql(db,"select coalesce(json_agg(json_build_object('index',conindid::regclass::text)),'[]'::json) from pg_constraint where conindid<>0").stdout)
 return {'catalog':c,'defs':defs,'shapes':shapes,'constraint_indexes':[x['index'] for x in constraints]}

def stage_guard(before,after):
 bf={x['sig']:x for x in before['catalog']['functions']};af={x['sig']:x for x in after['catalog']['functions']}
 funcs={n for n in bf.keys()|af.keys() if bf.get(n)!=af.get(n)}
 guard=function_guard(before['catalog'],funcs)
 statements=[]
 for name in sorted(before['shapes'].keys()|after['shapes'].keys()):
  old=before['shapes'].get(name);new=after['shapes'].get(name)
  if old==new:continue
  expected=quote(json.dumps(old))+'::jsonb' if old else 'null::jsonb'
  statements.append('if ('+relation_shape_sql(name)+') is distinct from '+expected+" then raise exception 'Unknown relation preimage: %',"+quote(name)+" using errcode='55000'; end if;")
 if statements:guard+='do $shape$ begin\n'+'\n'.join(statements)+'\nend $shape$;\n'
 return "set local search_path=public,extensions;\n"+guard

def index_name(text):return text.split('INDEX ',1)[1].split(' ON ',1)[0]
def acl_restore(kind,sig,acl):
 stmts=['revoke all on '+kind+' '+sig+' from public,anon,authenticated,service_role;']
 for entry in (acl or '{}')[1:-1].split(','):
  if not entry:continue
  role,rest=entry.split('=',1);flags=rest.split('/',1)[0]
  if role=='postgres':continue
  if kind=='function':privs=['execute'] if 'X' in flags else []
  else:privs=[{'a':'insert','r':'select','w':'update','d':'delete','D':'truncate','x':'references','t':'trigger','m':'maintain'}[c] for c in flags if c!='*']
  if privs:stmts.append('grant '+','.join(privs)+' on '+kind+' '+sig+' to '+(role or 'public')+(' with grant option' if '*' in flags else '')+';')
 return '\n'.join(stmts)

def rollback_sql(before,after):
 bt={t['t']:t for t in before['catalog']['tables']};at={t['t']:t for t in after['catalog']['tables']}
 bf={f['sig']:f for f in before['catalog']['functions']};af={f['sig']:f for f in after['catalog']['functions']};bd={f['sig']:f for f in before['defs']}
 stmts=['begin;',"set local lock_timeout='5s';","set local statement_timeout='120s';","set local search_path=public,extensions;",stage_guard(after,before)+platform_guard()]
 for name in sorted(at.keys()&bt.keys()):
  oldcols={x.split(' ',1)[0] for x in bt[name]['cols']};newcols={x.split(' ',1)[0] for x in at[name]['cols']}
  for col in sorted(newcols-oldcols):
   stmts.append('do $column$ begin if exists(select 1 from '+name+' where '+col+" is not null) then raise exception 'Rollback refuses populated new column: %',"+quote(name+'.'+col)+" using errcode='55000'; end if; end $column$;")
 for name,t in at.items():
  old=bt.get(name,{})
  for trg in set(t['trg'] or [])-set(old.get('trg') or []):stmts.append('drop trigger '+trg.split(' ',1)[0]+' on '+name+';')
  if name in bt:
   for con in set(t['cons'] or [])-set(old.get('cons') or []):
    if not con.split(' ',1)[1].startswith('TRIGGER'):stmts.append('alter table '+name+' drop constraint '+con.split(' ',1)[0]+';')
   for ind in set(t['idx'] or [])-set(old.get('idx') or []):
    qualified=name.split('.')[0]+'.'+index_name(ind)
    if qualified not in after['constraint_indexes']:stmts.append('drop index if exists '+qualified+';')
 for name in at.keys()-bt.keys():
  stmts.append('do $rows$ begin if exists(select 1 from '+name+") then raise exception 'Rollback refuses nonempty new table: %',"+quote(name)+" using errcode='55000'; end if; end $rows$;")
  stmts.append('drop table '+name+';')
 for name in af.keys()-bf.keys():stmts.append('drop function '+regsig(name)+';')
 for name in at.keys()&bt.keys():
  oldcols={x.split(' ',1)[0] for x in bt[name]['cols']};newcols={x.split(' ',1)[0] for x in at[name]['cols']}
  for col in newcols-oldcols:stmts.append('alter table '+name+' drop column '+col+';')
 for name in sorted(bf):
  if bf[name]==af.get(name):continue
  stmts.append(bd[name]['definition'].rstrip(';')+';');stmts.append('alter function '+regsig(name)+' owner to '+bf[name]['owner']+';');stmts.append(acl_restore('function',regsig(name),bf[name]['acl']))
 for name in sorted(bt.keys()&at.keys()):
  old=bt[name];new=at[name]
  for con in set(old['cons'] or [])-set(new['cons'] or []):
   cname,defn=con.split(' ',1)
   if not defn.startswith('TRIGGER'):stmts.append('alter table '+name+' add constraint '+cname+' '+defn+';')
  for ind in set(old['idx'] or [])-set(new['idx'] or []):
   qualified=name.split('.')[0]+'.'+index_name(ind)
   if qualified not in before['constraint_indexes']:stmts.append(ind+';')
  for trg in set(old['trg'] or [])-set(new['trg'] or []):stmts.append(trg.split(' ',2)[2]+';')
  if old['acl']!=new['acl']:stmts.append(acl_restore('table',name,old['acl']))
 stmts.extend(["notify pgrst,'reload schema';",'commit;'])
 return '\n'.join(stmts)


def scoped_result(before,after,branch):
 before_n=norm(before);after_n=norm(after);branch_n=norm(branch)
 protected_functions={f['sig'] for f in HOST['functions']} - {f['sig'] for f in branch['functions']}
 protected_tables={t['t'] for t in HOST['tables']} - {t['t'] for t in branch['tables']}
 protected=[]
 for kind,key,names in [('functions','sig',protected_functions),('tables','t',protected_tables)]:
  aa={x[key]:x for x in before_n[kind]};bb={x[key]:x for x in after_n[kind]}
  protected.extend({'kind':kind,'name':n,'changed':aa.get(n)!=bb.get(n),'present':n in aa} for n in sorted(names))
 roo=[];equivalent=[]
 dif=differences(branch_n,after_n)
 for d in dif:
  if d['name'] in protected_functions|protected_tables:continue
  if d['kind']=='functions' and d['name']=='public.rls_auto_enable()':continue
  fields=d['fields']
  if d['kind']=='tables' and all(k in ['cols','idx','trg'] for k in fields):
   reasons=[];ok=True
   for key,val in fields.items():
    if key=='cols':
     if sorted(val['expected'])==sorted(val['actual']):reasons.append('physical column order only; names/types/defaults/nullability identical')
     else:ok=False
    elif key=='idx':
     def canonical(x):return re.sub(r"ARRAY\[([^]]+)\]",lambda m:'ARRAY['+','.join(sorted(m[1].split(',')))+']',x)
     if sorted(map(canonical,val['expected'] or []))==sorted(map(canonical,val['actual'] or [])):reasons.append('ANY predicate constant order only; identical set of non-null text values')
     else:ok=False
    elif key=='trg':ok=False
   if ok:equivalent.append({'name':d['name'],'reasons':reasons});continue
  roo.append(d)
 return {'roo_unexplained':roo,'explained_equivalent':equivalent,'protected':protected,'protected_changed':[x for x in protected if x['changed']]}

def durable_payload_checks(files,rollback_path,post_path,initial,final):
 sql('postgres','create database durable_payload template durable_base;')
 before=row_snapshot('durable_payload'); ledger_before=sql('durable_payload',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
 steps=[]
 for item in files:
  payload=Path(item['payload']).read_text()
  sql('durable_payload',payload)
  after_rows=row_snapshot('durable_payload');after_cat=catalog('durable_payload');after_ledger=sql('durable_payload',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
  duplicate=sql('durable_payload',payload,False)
  if not duplicate.returncode or after_rows!=row_snapshot('durable_payload') or differences(norm(after_cat),norm(catalog('durable_payload'))) or after_ledger!=sql('durable_payload',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout:raise RuntimeError('Durable payload duplicate did not refuse unchanged')
  steps.append({'version':item['ledger_version'],'payload_sha256':item['payload_sha256'],'applied':True,'duplicate_refused_unchanged':True})
 sql('durable_payload',Path(post_path).read_text())
 if differences(norm(final['catalog']),norm(catalog('durable_payload'))):raise RuntimeError('Durable apply catalog differs from rehearsed end state')
 save('durable-seeded-rows-before.json',before);save('durable-seeded-rows-after.json',row_snapshot('durable_payload'))
 preservation_proof(before,row_snapshot('durable_payload'))
 sql('durable_payload',Path(rollback_path).read_text())
 if differences(norm(initial['catalog']),norm(catalog('durable_payload'))) or ledger_before!=sql('durable_payload',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout:raise RuntimeError('Durable rollback catalog/ledger differs from prestate')
 proof={'passed':True,'steps':steps,'post_apply_passed':True,'schema_rollback_equal':True,'complete_ledger_rollback_equal':True}
 save('durable-payload-apply-rollback-results.json',proof)
 return proof

def write_manifest(stages,initial,final,fidelity,endproof,rollback_differences):
 root=RELEASE;root.mkdir(exist_ok=True,mode=0o700);root.chmod(0o700);out=root/RUN.name;out.mkdir(mode=0o700)
 fidelity_gaps=[];fidelity_equivalent=[]
 for d in fidelity:
  if set(d['fields'])=={'cols'} and sorted(d['fields']['cols']['expected'])==sorted(d['fields']['cols']['actual']):fidelity_equivalent.append({'name':d['name'],'reason':'Physical column ordinals differ; every named column/type/default/nullability is identical. No migration accesses either table by a positional row constructor.'})
  else:fidelity_gaps.append(d)
 blocked=[{'stage':'replica_fidelity','differences':fidelity_gaps}] if fidelity_gaps else []
 extra=supplemental_capture()
 if not extra or not extra.get('ledger_shape') or not extra.get('owners') or not extra.get('policy_roles') or not extra.get('schema_privileges') or 'default_privileges' not in extra or 'event_triggers' not in extra:blocked.append({'stage':'captured_metadata_missing','required':'actual table owners, schema/default privileges, event-trigger metadata, policy role OID names and ledger shape from missing-capture-read-only.sql'})
 if not TOURNEY or not PLATFORM_PROOF.get('passed'):blocked.append({'stage':'captured_platform_state_not_proven','proof':PLATFORM_PROOF})
 if endproof['roo_unexplained']:blocked.append({'stage':'roo_end_state','differences':endproof['roo_unexplained']})
 if endproof['protected_changed']:blocked.append({'stage':'protected_objects','differences':endproof['protected_changed']})
 if any(not x['present'] for x in endproof['protected']):blocked.append({'stage':'protected_objects_absent','names':[x['name'] for x in endproof['protected'] if not x['present']]})
 if rollback_differences:blocked.append({'stage':'rollback','differences':rollback_differences})
 files=[]
 for i,st in enumerate(stages,1):
  name=Path(st['source']).name;body=st['body'];clean=release_body(body)
  namepart=name.split('_',1)[1][:-4];version=st['version']
  guardpath=out/(str(i).zfill(2)+'-'+name+'.guard.sql');guardpath.write_text('begin transaction read only;\n'+st['guard'].replace('set local','set local')+'\nrollback;\n');guardpath.chmod(0o600)
  ledger_body=clean
  record="insert into supabase_migrations.schema_migrations(version,name,statements) values ("+quote(version)+','+quote(namepart)+',array['+quote(ledger_body)+']::text[]);'
  gate="do $release$ begin raise exception 'Hosted alignment replica fidelity is incomplete; this candidate is disabled' using errcode='55000'; end $release$;\n" if blocked else ''
  payload='begin;\n'+gate+"set local lock_timeout='5s';\nset local statement_timeout='120s';\n"+st['guard']+'\n'+clean+'\n'+record+'\ncommit;\n'
  path=out/(str(i).zfill(2)+'-'+name);path.write_text(payload);path.chmod(0o600)
  files.append({'order':i,'source':st['source'],'source_sha256':hashlib.sha256(Path(st['source']).read_bytes()).hexdigest(),'applied_body_sha256':hashlib.sha256(body.encode()).hexdigest(),'payload':str(path),'payload_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'pre_guard':str(guardpath),'command':['/usr/bin/supabase','db','query','--linked','--project-ref','ntezmxzaibrrsgtujgxu','--file',str(path)],'ledger_version':version,'ledger_name':namepart})
 rb=with_ledger_rollback(rollback_sql(initial,final),stages);p=out/'rollback-schema.sql';p.write_text(rb);p.chmod(0o600)
 touched={d['name'] for d in differences(norm(initial['catalog']),norm(final['catalog']))}
 function_names={f['sig'] for f in final['catalog']['functions'] if f['sig'] in touched}
 post=function_guard(final['catalog'],{f['sig'] for f in final['catalog']['functions']})+platform_guard()
 checks=['if ('+relation_shape_sql(name)+') is distinct from '+quote(json.dumps(shape))+"::jsonb then raise exception 'Unexpected post-apply relation: %',"+quote(name)+" using errcode='55000'; end if;" for name,shape in sorted(final['shapes'].items())]
 post+='do $tables$ begin\n'+'\n'.join(checks)+'\nend $tables$;\n'
 postpath=out/'post-apply-verification.sql';postpath.write_text('begin transaction read only;\nset local search_path=public,extensions;\n'+post+"select 'verified expected function definitions and relation shapes' as verification;\nrollback;\n");postpath.chmod(0o600)
 capturepath=out/'rollback-capture-read-only.sql';capturepath.write_text(rollback_capture_sql(initial,final));capturepath.chmod(0o600)
 for name in ['impact-alignment.sql','impact-currency.sql','missing-capture-read-only.sql']:
  source=impact_file(name) if name!='missing-capture-read-only.sql' else W/name
  destination=out/name;destination.write_text(source.read_text());destination.chmod(0o600)
 post_check=sql('currency_test',postpath.read_text(),False);save('post-apply-verification-local-result.json',{'exit':post_check.returncode,'output':post_check.stdout,'stderr':post_check.stderr})
 if post_check.returncode:raise RuntimeError('Post-apply verification query '+post_check.stderr)
 pre_capture=sql('replica',capturepath.read_text(),False);save('rollback-pre-apply-capture-local.json',{'exit':pre_capture.returncode,'capture':json.loads(pre_capture.stdout) if pre_capture.returncode==0 else None,'stderr':pre_capture.stderr})
 if pre_capture.returncode:raise RuntimeError('Pre-apply rollback capture '+pre_capture.stderr)
 durable_proof=durable_payload_checks(files,p,postpath,initial,final) if not blocked else {'passed':False,'skipped':'replica proof gaps'}
 manifest={'durable_payload_proof':durable_proof,'rollback_capture':str(capturepath),'ready':not blocked,'project_ref':'ntezmxzaibrrsgtujgxu','run':str(RUN),'inputs':INPUTS,'platform_and_captured_state_proof':PLATFORM_PROOF,'fidelity_explained_equivalent':fidelity_equivalent,'blocking_proof_gaps':blocked,'steps':files,'rollback':str(p),'rollback_scope':'schema; keeps documented email data effects; captured retired tourney metadata is unchanged; refuses populated new columns and nonempty audit table','ledger_plan':'Insert version/name/actual applied SQL statements in the same explicit transaction as each DDL step. Use original missing versions because their intended schema state is now reached; preserve the variant and all existing apply-time versions. Do not run migration repair because it is a separate transaction and does not apply SQL. No hosted ledger rows are written by rehearsal. Production ledger relation shape is captured.','post_apply':str(postpath),'touched_objects':sorted(touched)}
 mp=out/'manifest.json';mp.write_text(json.dumps(manifest,indent=2));mp.chmod(0o600)
 (root/'manifest-latest-path').write_text(str(mp)+'\n');(root/'manifest-latest-path').chmod(0o600)
 save('apply-manifest-path.txt',str(mp));return manifest


def rollback_capture_sql(before,after):
 touched={d['name'] for d in differences(norm(before['catalog']),norm(after['catalog']))}
 functions=sorted({f['sig'] for f in before['catalog']['functions']+after['catalog']['functions'] if f['sig'] in touched}|{'public.rls_auto_enable()'})
 relations=sorted(set(t['t'] for t in before['catalog']['tables']+after['catalog']['tables'] if t['t'] in touched)|{v['name'] for v in (EXTRA or {}).get('views',[])})
 function_values=','.join('('+quote(regsig(n))+')' for n in sorted(set(functions)))
 relation_values=','.join('('+quote(n)+')' for n in relations)
 return "begin transaction isolation level repeatable read read only;\nset local search_path=public,extensions;\nwith wanted_functions(signature) as (values "+function_values+"), wanted_relations(name) as (values "+relation_values+"), captured_functions as (select wanted.signature,p.oid from wanted_functions wanted left join pg_proc p on p.oid=to_regprocedure(wanted.signature)), captured_relations as (select wanted.name,c.oid from wanted_relations wanted left join pg_class c on c.oid=to_regclass(wanted.name)) select jsonb_build_object('observed_at',clock_timestamp(),'server_version',current_setting('server_version'),'functions',(select jsonb_agg(jsonb_build_object('signature',f.signature,'present',p.oid is not null,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,'secdef',p.prosecdef,'md5',md5(pg_get_functiondef(p.oid)))) from captured_functions f left join pg_proc p on p.oid=f.oid),'relations',(select jsonb_agg(jsonb_build_object('name',r.name,'present',c.oid is not null,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'view_definition',case when c.relkind='v' then pg_get_viewdef(c.oid,true) end,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred)) from pg_constraint where conrelid=c.oid),'indexes',(select jsonb_agg(pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),'triggers',(select jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled)) from pg_trigger where tgrelid=c.oid and not tgisinternal),'policies',(select jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'permissive',polpermissive,'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid),'roles',(select jsonb_agg(coalesce(role.rolname,'PUBLIC')) from unnest(polroles) id left join pg_roles role on role.oid=id))) from pg_policy where polrelid=c.oid))) from captured_relations r left join pg_class c on c.oid=r.oid)) as rollback_capture;\nrollback;\n"


def ledger_pre_guard(version):
 return "do $version$ begin if current_user<>'postgres' then raise exception 'Apply role must match captured object owner postgres' using errcode='55000'; end if; if to_regclass('supabase_migrations.schema_migrations') is not null then if exists(select 1 from supabase_migrations.schema_migrations where version="+quote(version)+") then raise exception 'Migration version already recorded: %',"+quote(version)+" using errcode='55000'; end if; end if; end $version$;\n"


def with_ledger_rollback(body,stages):
 checks=[]
 for st in stages:
  clean=release_body(st['body'])
  name=Path(st['source']).name.split('_',1)[1][:-4]
  shape=(EXTRA or {}).get('ledger_shape') or {'column_definitions':['version text','name text','statements text[]']}
  expected={column.split(' ',1)[0]:None for column in shape['column_definitions']};expected.update(version=st['version'],name=name,statements=[clean])
  identity='to_jsonb(schema_migrations)='+quote(json.dumps(expected))+'::jsonb'
  checks.append('if exists(select 1 from supabase_migrations.schema_migrations where version='+quote(st['version'])+' and to_jsonb(schema_migrations) is distinct from '+quote(json.dumps(expected))+"::jsonb) then raise exception 'Unknown rollback ledger row: %',"+quote(st['version'])+" using errcode='55000'; end if;")
  checks.append('delete from supabase_migrations.schema_migrations where version='+quote(st['version'])+' and '+identity+';')
 extra="do $ledger$ begin if to_regclass('supabase_migrations.schema_migrations') is not null then\n"+'\n'.join(checks)+'\nend if;end $ledger$;\n'
 return body.rsplit('commit;',1)[0]+extra+'commit;\n'

def seed_ledger(db):
 extra=supplemental_capture();ledger_shape=(extra or {}).get('ledger_shape')
 if ledger_shape:
  if not ledger_shape.get('column_definitions') or not ledger_shape.get('named_constraints'):raise RuntimeError('Captured migration ledger lacks repeatable actual column/constraint definitions')
  sql(db,'create schema supabase_migrations;create table supabase_migrations.schema_migrations('+','.join(ledger_shape['column_definitions']+ledger_shape['named_constraints'])+');alter table supabase_migrations.schema_migrations owner to '+ledger_shape['owner']+';'+acl_restore('table','supabase_migrations.schema_migrations',ledger_shape['acl']))
 else:sql(db,'create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);')
 for entry in ROWS:
  statements='null::text[]' if entry['statements'] is None else 'array['+','.join(quote(v) for v in entry['statements'])+']::text[]'
  sql(db,'insert into supabase_migrations.schema_migrations(version,name,statements) values('+quote(entry['version'])+','+quote(entry['name'])+','+statements+');')

def adverse_checks(stages,initial,final,rollback_body):
 results=[]
 extra=supplemental_capture();ledger_shape=(extra or {}).get('ledger_shape')
 seed_ledger('replica')
 initial_ledger=sql('replica',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
 for st in stages:
  before_rows=row_snapshot('replica');before_cat=catalog('replica');ledger_before=sql('replica',"select md5(coalesce(jsonb_agg(to_jsonb(r) order by version),'[]'::jsonb)::text) from supabase_migrations.schema_migrations r").stdout
  clean=release_body(st['body'])
  record="insert into supabase_migrations.schema_migrations(version,name,statements) values ("+quote(st['version'])+','+quote(Path(st['source']).name.split('_',1)[1][:-4])+',array['+quote(clean)+']::text[]);'
  r=sql('replica','begin;\n'+st['guard']+'\n'+clean+'\n'+record+'\nselect 1/0;\ncommit;',False)
  unchanged=before_rows==row_snapshot('replica') and not differences(norm(before_cat),norm(catalog('replica')))
  results.append({'scenario':'partial-failure-'+st['version'],'exit':r.returncode,'refused_at_end':'division by zero' in r.stderr,'data_and_catalog_unchanged':unchanged,'ledger_unchanged':ledger_before==sql('replica',"select md5(coalesce(jsonb_agg(to_jsonb(r) order by version),'[]'::jsonb)::text) from supabase_migrations.schema_migrations r").stdout})
  if not r.returncode or 'division by zero' not in r.stderr or not unchanged or not results[-1]['ledger_unchanged']:raise RuntimeError('partial failure proof '+st['version']+' '+r.stderr)
  changed_funcs=[d['name'] for d in differences(norm(st['before']['catalog']),norm(st['after']['catalog'])) if d['kind']=='functions' and any(f['sig']==d['name'] for f in st['before']['catalog']['functions'])]
  if changed_funcs:
   target=changed_funcs[0];r=sql('replica','begin;alter function '+regsig(target)+' cost 99;\n'+st['guard']+'\ncommit;',False)
   unchanged=before_rows==row_snapshot('replica') and not differences(norm(before_cat),norm(catalog('replica')))
   results.append({'scenario':'unknown-preimage-'+st['version'],'target':target,'exit':r.returncode,'refused':'Unknown function preimage' in r.stderr,'data_and_catalog_unchanged':unchanged})
   if not r.returncode or 'Unknown function preimage' not in r.stderr or not unchanged:raise RuntimeError('unknown preimage proof '+st['version']+' '+r.stderr)
  record="insert into supabase_migrations.schema_migrations(version,name,statements) values ("+quote(st['version'])+','+quote(Path(st['source']).name.split('_',1)[1][:-4])+',array['+quote(clean)+']::text[]);'
  r=sql('replica','begin;\n'+st['guard']+'\n'+clean+'\n'+record+'\ncommit;',False)
  if r.returncode:raise RuntimeError('guarded apply '+st['version']+' '+r.stderr)
  if differences(norm(st['after']['catalog']),norm(catalog('replica'))):raise RuntimeError('guarded apply schema mismatch '+st['version'])
  applied_rows=row_snapshot('replica');applied_cat=catalog('replica')
  r=sql('replica','begin;\n'+st['guard']+'\n'+clean+'\n'+record+'\ncommit;',False)
  unchanged=applied_rows==row_snapshot('replica') and not differences(norm(applied_cat),norm(catalog('replica')))
  results.append({'scenario':'duplicate-apply-'+st['version'],'exit':r.returncode,'data_and_catalog_unchanged':unchanged,'error':r.stderr[:220]})
  if not r.returncode or not unchanged:raise RuntimeError('duplicate apply proof '+st['version'])
 save('guarded-apply-adverse-results.json',results)
 target=stages[0];version=target['version'];name=Path(target['source']).name.split('_',1)[1][:-4]
 sql('replica','update supabase_migrations.schema_migrations set name=null where version='+quote(version)+';')
 unknown_before=row_snapshot('replica');unknown_cat=catalog('replica');unknown_ledger=sql('replica',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
 r=sql('replica',rollback_body,False)
 same=unknown_before==row_snapshot('replica') and not differences(norm(unknown_cat),norm(catalog('replica'))) and unknown_ledger==sql('replica',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
 save('null-ledger-rollback-refusal.json',{'exit':r.returncode,'error':r.stderr,'all_rows_catalog_and_ledger_unchanged':same})
 if not r.returncode or 'Unknown rollback ledger row' not in r.stderr or not same:raise RuntimeError('NULL ledger rollback preservation '+r.stderr)
 sql('replica','update supabase_migrations.schema_migrations set name='+quote(name)+' where version='+quote(version)+';')
 extra_fields=[]
 for field,value in [('created_by',"'alignment-unknown-author'"),('idempotency_key',"'alignment-unknown-key'"),('rollback',"array['select 7;']::text[]")]:
  if field not in {column.split(' ',1)[0] for column in (ledger_shape or {}).get('column_definitions',[])}:continue
  sql('replica','update supabase_migrations.schema_migrations set '+ident(field)+'='+value+' where version='+quote(version)+';')
  rows=row_snapshot('replica');cat=catalog('replica');ledger=sql('replica',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
  r=sql('replica',rollback_body,False)
  same=rows==row_snapshot('replica') and not differences(norm(cat),norm(catalog('replica'))) and ledger==sql('replica',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
  extra_fields.append({'scenario':'unknown-ledger-'+field,'exit':r.returncode,'stderr':r.stderr,'all_rows_catalog_and_ledger_unchanged':same,'passed':r.returncode!=0 and 'Unknown rollback ledger row' in r.stderr and same})
  if not extra_fields[-1]['passed']:save('extra-ledger-field-rollback-refusal.json',extra_fields);raise RuntimeError('Unknown extra ledger metadata '+field+' '+r.stderr)
  sql('replica','update supabase_migrations.schema_migrations set '+ident(field)+'=null where version='+quote(version)+';')
 save('extra-ledger-field-rollback-refusal.json',extra_fields)
 sql('replica',"update accounts.reauth_grants set bound_intent_id=(select id from accounts.oauth_intents where action='reauth'),bound_at=now() where token_hash=repeat('6',64);")
 populated_before=row_snapshot('replica');populated_cat=catalog('replica');r=sql('replica',rollback_body,False)
 same=populated_before==row_snapshot('replica') and not differences(norm(populated_cat),norm(catalog('replica')))
 save('populated-column-rollback-refusal.json',{'exit':r.returncode,'error':r.stderr,'data_and_catalog_unchanged':same})
 if not r.returncode or 'Rollback refuses populated new column' not in r.stderr or not same:raise RuntimeError('populated new column rollback proof '+r.stderr)
 sql('replica',"update accounts.reauth_grants set bound_intent_id=null,bound_at=null where token_hash=repeat('6',64);")
 sql('replica',"insert into accounts.orphan_identity_reclaim_audit(oauth_intent_id,provider,target_user_id,target_principal_id,outcome,reason) values(gen_random_uuid(),'google','11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','blocked_conflict','local rollback preservation fixture');")
 rows_before=row_snapshot('replica');cat_before=catalog('replica');r=sql('replica',rollback_body,False)
 same=rows_before==row_snapshot('replica') and not differences(norm(cat_before),norm(catalog('replica')))
 save('nonempty-audit-rollback-refusal.json',{'exit':r.returncode,'error':r.stderr,'data_and_catalog_unchanged':same})
 if not r.returncode or 'Rollback refuses nonempty new table' not in r.stderr or not same:raise RuntimeError('nonempty audit rollback proof '+r.stderr)
 sql('replica','begin;alter table accounts.orphan_identity_reclaim_audit disable trigger orphan_identity_reclaim_audit_immutable;delete from accounts.orphan_identity_reclaim_audit where reason=\'local rollback preservation fixture\';alter table accounts.orphan_identity_reclaim_audit enable trigger orphan_identity_reclaim_audit_immutable;commit;')
 licenses=[]
 for n in [2,3,4]:
  user='11111111-0000-0000-0000-00000000000'+str(n);ent='44444444-0000-0000-0000-00000000000'+str(n)
  r=sql('replica','select public.roo_activate_device('+quote(user)+'::uuid,'+quote(ent)+'::uuid,'+quote(str(n)*64)+','+quote('alignment-request-'+str(n))+');',False)
  licenses.append({'scenario':'activation-owner-'+str(n),'exit':r.returncode,'refused':'active licensing principal not found' in r.stderr})
  if not r.returncode or 'active licensing principal not found' not in r.stderr:raise RuntimeError('inactive principal proof '+r.stderr)
 save('inactive-licensing-owner-results.json',licenses)
 if row_snapshot('replica')!=applied_rows:raise RuntimeError('licensing refusal changed rows')
 sql('postgres','create database currency_test template replica;')
 currency_checks_db='currency_test'
 currency_checks(currency_checks_db)
 sql('replica',rollback_body)
 final_ledger=sql('replica',"select md5(jsonb_agg(to_jsonb(r) order by version)::text) from supabase_migrations.schema_migrations r").stdout
 save('ledger-apply-rollback-preservation.json',{'existing_rows':len(ROWS),'reviewed_rows_added':len(stages),'initial_md5':initial_ledger.strip(),'rollback_md5':final_ledger.strip(),'unchanged':initial_ledger==final_ledger})
 if initial_ledger!=final_ledger:raise RuntimeError('rollback changed existing ledger rows')
 save('guarded-reapply-rollback-differences.json',differences(norm(initial['catalog']),norm(catalog('replica'))))
 st=stages[0]
 control="update tourney.mirror_contracts set enabled=true;update tourney.cutover_metadata set hardened_active=true,primary_backend='supabase',generation=1,writes_paused=true,fallback_read_only=false,clean_since='2026-01-01',natural_mutation_verified_at='2026-01-01',first_zero_drift_at='2026-01-01',second_zero_drift_at='2026-01-01' where id='tourney';update tourney.schema_metadata set schema_version=4 where schema_name='tourney';"
 check="select jsonb_build_object('clocks_cleared',clean_since is null and natural_mutation_verified_at is null and first_zero_drift_at is null and second_zero_drift_at is null,'reason',clock_last_reset_reason,'actor',updated_by,'bindings_ready',tourney.mirror_trigger_binding_status_v4()->>'ready') from tourney.cutover_metadata where id='tourney';"
 active_body=re.sub(r'do \$release_retirement\$.*?end \$release_retirement\$;\n','',st['body'],flags=re.S)
 r=sql('replica','begin;'+control+active_body+'\n'+check+'rollback;',False)
 save('active-tourney-repair.json',{'exit':r.returncode,'output':r.stdout,'stderr':r.stderr})
 if r.returncode or '"clocks_cleared": true' not in r.stdout or '"bindings_ready": "true"' not in r.stdout:raise RuntimeError('active tourney proof '+r.stderr+r.stdout)
 control_results=[]
 for name,setup,expected in [('retired-zero-enabled-contracts',"update tourney.mirror_contracts set enabled=false;",'"enabled_contracts": 0'),('genuinely-active-unpaused-captured-controls',"update tourney.mirror_contracts set enabled=true;",'Alignment requires retired zero-enabled mirror contracts'),('genuinely-active-paused-controls',"update tourney.mirror_contracts set enabled=true;update tourney.cutover_metadata set writes_paused=true where id='tourney';",'Alignment requires retired zero-enabled mirror contracts'),('unexpected-sunshine-contract-destination',"update tourney.mirror_contracts set enabled=true,supabase_relation='public.release_signups' where logical_table=(select min(logical_table) from tourney.mirror_contracts);",'Alignment requires retired zero-enabled mirror contracts')]:
  before=row_snapshot('replica');cat=catalog('replica')
  r=sql('replica','begin;'+setup+st['guard']+st['body']+"select tourney.mirror_trigger_binding_status_v4();rollback;",False)
  same=before==row_snapshot('replica') and not differences(norm(cat),norm(catalog('replica')))
  passed=(r.returncode==0 and expected in r.stdout) if name=='retired-zero-enabled-contracts' else (r.returncode!=0 and expected in r.stderr)
  control_results.append({'scenario':name,'exit':r.returncode,'output':r.stdout,'stderr':r.stderr,'all_rows_and_catalog_unchanged':same,'passed':passed})
  if not passed or not same:save('tourney-contract-destination-results.json',control_results);raise RuntimeError('tourney contracts '+name+' '+r.stderr+r.stdout)
 save('tourney-contract-destination-results.json',control_results)
 p=next((REPO/'supabase/migrations').glob('20260718013000*.sql'))
 setup="update tourney.cutover_metadata set clock_last_reset_reason='shadow_acceptance_gate_failed',natural_mutation_verified_at='2026-01-01' where id='tourney';insert into tourney.shadow_latency_baselines(route,primary_p95_ms,sample_count,captured_by) select route,20,30,'alignment-fixture' from (values('public_roster'),('public_bracket'),('admin_players'),('appeals'),('payouts')) v(route) on conflict(route) do update set primary_p95_ms=20,sample_count=30;insert into tourney.shadow_observations(route,shape_match,value_match,ordering_match,error_match,primary_latency_ms,shadow_latency_ms,primary_status,shadow_status) select route,true,true,true,true,10,10,200,200 from (values('public_roster'),('public_bracket'),('admin_players'),('appeals'),('payouts')) v(route) cross join generate_series(1,30);"
 check="select jsonb_build_object('reason_cleared',clock_last_reset_reason is null,'actor',updated_by,'gate_passes',tourney.current_shadow_acceptance_gate_passes()) from tourney.cutover_metadata where id='tourney';"
 r=sql('replica','begin;'+setup+p.read_text()+'\n'+check+'rollback;',False);save('passing-shadow-acceptance.json',{'exit':r.returncode,'output':r.stdout,'stderr':r.stderr})
 if r.returncode or '"reason_cleared": true' not in r.stdout or '"gate_passes": true' not in r.stdout:raise RuntimeError('shadow acceptance proof '+r.stderr+r.stdout)
 slot_checks('replica',stages)
 impacts=sql('replica',impact_file('impact-alignment.sql').read_text(),False);save('impact-local-result.json',{'exit':impacts.returncode,'output':impacts.stdout,'stderr':impacts.stderr})
 if impacts.returncode:raise RuntimeError('impact SQL '+impacts.stderr)


def slot_checks(db,stages):
 source=next(x['body'] for x in stages if x['version']=='20260718010000')
 impact=impact_file('impact-alignment.sql').read_text();probe='with times as'+impact.split('with times as',1)[1].split("select 'oauth_constraints'",1)[0]
 examples=[
 ('cancelled-parent-missing-booking-claim',"update commerce.bookings set status='cancelled' where legacy_sanity_id='alignment-booking';delete from commerce.slot_claims where start_time_utc='2099-03-01';",'2099-03-01','slot_integrity|0|1|0|0'),
 ('wrong-active-hold-owner',"update commerce.slot_claims set hold_id='55555555-0000-0000-0000-000000000002' where start_time_utc='2099-02-02';",'2099-02-02','slot_integrity|0|0|1|0'),
 ('payment-hold-overlaps-active-booking',"insert into commerce.slot_holds(id,legacy_sanity_id,start_time_utc,package_title,phase,expires_at) values('55555555-0000-0000-0000-000000000005','alignment-overlap','2099-03-01','Fixture','payment','2099-01-01');",'2099-03-01','slot_integrity|1|0|1|0'),
 ('expired-payment-hold-has-orphan-claim',"update commerce.slot_holds set expires_at='2026-01-01' where id='55555555-0000-0000-0000-000000000002';",'2099-02-03','slot_integrity|0|0|0|1')]
 results=[]
 for name,mutate,time_value,expected in examples:
  before=row_snapshot(db);cat=catalog(db)
  r=sql(db,"\\set VERBOSITY verbose\n"+'begin;'+mutate+source+'\n'+probe+"select migration.assert_slot_claim_integrity("+quote(time_value)+"::timestamptz);rollback;",False)
  same=before==row_snapshot(db) and not differences(norm(cat),norm(catalog(db)))
  results.append({'scenario':name,'exit':r.returncode,'output':r.stdout,'sqlstate_23505':'23505' in r.stderr,'expected_counts':expected,'counts_match':expected in r.stdout,'all_rows_and_catalog_unchanged':same,'stderr':r.stderr})
  if not r.returncode or '23505' not in r.stderr or expected not in r.stdout or not same:save('slot-impact-native-results.json',results);raise RuntimeError('slot impact differs '+name+' '+r.stdout+r.stderr)
 save('slot-impact-native-results.json',results)


def supplemental_capture():return EXTRA


def captured_tourney_restore(db):
 if not TOURNEY:raise RuntimeError('Missing captured tourney-state.raw.json')
 row=TOURNEY['cutover_metadata'];columns=TOURNEY['cutover_metadata_columns']
 if set(row)!=set(columns):raise RuntimeError('Captured Tourney row is incomplete')
 updates=','.join(ident(name)+'=incoming.'+ident(name) for name in columns if name!='id')
 sql(db,'update tourney.cutover_metadata current set '+updates+' from jsonb_populate_record(null::tourney.cutover_metadata,'+quote(json.dumps(row))+"::jsonb) incoming where current.id=incoming.id;")
 for schema in TOURNEY['schema_metadata']:
  updates=','.join(ident(name)+'=incoming.'+ident(name) for name in schema if name!='schema_name')
  sql(db,'update tourney.schema_metadata current set '+updates+' from jsonb_populate_record(null::tourney.schema_metadata,'+quote(json.dumps(schema))+'::jsonb) incoming where current.schema_name=incoming.schema_name;')
 actual=tourney_controls(db)
 expected=json.loads(sql(db,'select to_jsonb(jsonb_populate_record(null::tourney.cutover_metadata,'+quote(json.dumps(row))+'::jsonb))').stdout)
 if actual['cutover_metadata']!=expected or actual['mirror_contracts']!=TOURNEY['mirror_contracts']:raise RuntimeError('Exact captured Tourney controls were not restored')
 save('captured-tourney-controls-before.json',actual)


def tourney_controls(db):
 return json.loads(sql(db,"select jsonb_build_object('cutover_metadata',(select to_jsonb(m) from tourney.cutover_metadata m where id='tourney'),'schema_metadata',(select jsonb_agg(to_jsonb(m) order by schema_name) from tourney.schema_metadata m),'mirror_contracts',(select jsonb_build_object('total',count(*),'enabled',count(*) filter(where enabled)) from tourney.mirror_contracts))").stdout)


def ops_views(db,rows=True):
 result=json.loads(sql(db,"select coalesce(jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,'definition',pg_get_viewdef(c.oid,true),'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions) order by c.relname),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ops' and c.relkind='v' and c.relname in ('bookings_overview','payments_overview','recent_holds')").stdout)
 if rows:
  for view in result:view['rows']=json.loads(sql(db,"select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text),'[]'::jsonb) from "+view['name']+' v').stdout)
 return result


def event_metadata(db):
 return json.loads(sql(db,"set search_path=public,extensions;select coalesce(jsonb_agg(jsonb_build_object('name',evtname,'owner',pg_get_userbyid(evtowner),'event',evtevent,'tags',evttags,'enabled',evtenabled,'function',evtfoid::regprocedure::text) order by evtname),'[]'::jsonb) from pg_event_trigger where evtname<>'alignment_trace'").stdout)


def platform_guard():
 if not EXTRA:return ''
 events=sorted(EXTRA['event_triggers'],key=lambda event:event['name'])
 expression="select coalesce(jsonb_agg(jsonb_build_object('name',evtname,'owner',pg_get_userbyid(evtowner),'event',evtevent,'tags',evttags,'enabled',evtenabled,'function',evtfoid::regprocedure::text) order by evtname),'[]'::jsonb) from pg_event_trigger"
 statements=['if ('+expression+') is distinct from '+quote(json.dumps(events))+"::jsonb then raise exception 'Unknown platform event-trigger preimage' using errcode='55000'; end if;"]
 for view in EXTRA['views']:
  expected={k:v for k,v in view.items() if k!='definition'};expected['md5']=hashlib.md5(view['definition'].encode()).hexdigest()
  expression="select jsonb_build_object('name',"+quote(view['name'])+",'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass("+quote(view['name'])+")"
  statements.append('if ('+expression+') is distinct from '+quote(json.dumps(expected))+"::jsonb then raise exception 'Unknown protected ops view preimage: %',"+quote(view['name'])+" using errcode='55000'; end if;")
 return function_guard(HOST,{'public.rls_auto_enable()'})+'do $platform$ begin\n'+'\n'.join(statements)+'\nend $platform$;\n'


def ops_documented_effects(before,after):
 changes=[]
 if [dict((k,v) for k,v in view.items() if k!='rows') for view in before]!=[dict((k,v) for k,v in view.items() if k!='rows') for view in after]:raise RuntimeError('Protected ops view metadata changed')
 for old,new in zip(before,after):
  if old['name']!='ops.bookings_overview':
   if old['rows']!=new['rows']:raise RuntimeError('Undocumented view row change '+old['name'])
   continue
  initial={row['orderId']:row for row in old['rows']};final={row['orderId']:row for row in new['rows']}
  if initial.keys()!=final.keys():raise RuntimeError('Protected booking view row set changed')
  for key,row in initial.items():
   changed={k:{'before':row[k],'after':final[key][k]} for k in row if row[k]!=final[key][k]}
   if not changed:continue
   expected={'emailStatus':{'before':'not_recorded','after':'historical_unknown'},'confirmationCustomerStatus':{'before':None,'after':'historical_unknown'},'confirmationOwnerStatus':{'before':None,'after':'historical_unknown'}}
   if key!='alignment-unknown' or changed!=expected:raise RuntimeError('Undocumented booking view fields '+str(changed))
   changes.append({'view':old['name'],'synthetic_order':key,'fields':changed,'documented_migration':'20261005000000'})
 if len(changes)!=1:raise RuntimeError('Expected exact unknown-email view backfill effect')
 save('ops-view-documented-backfill-effects.json',changes)


def event_model_install(db):
 if not EXTRA or len(EXTRA.get('event_triggers') or [])!=7:raise RuntimeError('Expected exact seven captured platform hooks')
 allowed={'issue_graphql_placeholder':('sql_drop','set_graphql_placeholder()',['DROP EXTENSION']),'pgrst_ddl_watch':('ddl_command_end','pgrst_ddl_watch()',None),'pgrst_drop_watch':('sql_drop','pgrst_drop_watch()',None),'issue_pg_cron_access':('ddl_command_end','grant_pg_cron_access()',['CREATE EXTENSION']),'issue_pg_net_access':('ddl_command_end','grant_pg_net_access()',['CREATE EXTENSION']),'issue_pg_graphql_access':('ddl_command_end','grant_pg_graphql_access()',['CREATE EXTENSION']),'ensure_rls':('ddl_command_end','rls_auto_enable()',['CREATE TABLE','CREATE TABLE AS','SELECT INTO'])}
 sql(db,"do $$ begin if not exists(select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin superuser; else alter role supabase_admin superuser; end if; end $$;")
 sql(db,impact_file('platform-event-functions.sql').read_text())
 for event in EXTRA['event_triggers']:
  if event['name'] not in allowed or (event['event'],event['function'],event['tags'])!=allowed[event['name']] or event['enabled']!='O':raise RuntimeError('Unexpected captured hook contract '+str(event))
  function=('public.' if event['name']=='ensure_rls' else 'extensions.')+event['function']
  if event['name']!='ensure_rls':sql(db,'alter function '+function+' owner to '+ident(event['owner'])+';')
  tags=' when tag in ('+','.join(quote(tag) for tag in event['tags'])+')' if event['tags'] else ''
  sql(db,'create event trigger '+ident(event['name'])+' on '+event['event']+tags+' execute function '+function+';alter event trigger '+ident(event['name'])+' owner to '+ident(event['owner'])+';')
 expected=sorted(EXTRA['event_triggers'],key=lambda event:event['name']);actual=event_metadata(db)
 if actual!=expected:raise RuntimeError('Event-trigger metadata differs '+str(actual))
 sql(db,"create table extensions.alignment_ddl_log(tag text,schema_name text,object_type text,identity text);create function extensions.alignment_trace() returns event_trigger language plpgsql as $$ declare command record;begin for command in select * from pg_event_trigger_ddl_commands() loop insert into extensions.alignment_ddl_log values(command.command_tag,command.schema_name,command.object_type,command.object_identity);end loop;end $$;create event trigger alignment_trace on ddl_command_end execute function extensions.alignment_trace();")
 save('event-triggers-modeled-before.json',actual)


def event_model_probe(db):
 before=catalog(db);rows=row_snapshot(db)
 r=sql(db,"begin;create table public.alignment_rls_probe(id integer);create table accounts.alignment_rls_probe(id integer);select jsonb_build_object('public_rls',(select relrowsecurity from pg_class where oid='public.alignment_rls_probe'::regclass),'accounts_rls',(select relrowsecurity from pg_class where oid='accounts.alignment_rls_probe'::regclass));rollback;",False)
 same=rows==row_snapshot(db) and not differences(norm(before),norm(catalog(db)))
 result={'exit':r.returncode,'output':r.stdout,'stderr':r.stderr,'all_rows_and_catalog_unchanged':same,'passed':r.returncode==0 and '"public_rls": true' in r.stdout and '"accounts_rls": false' in r.stdout and same}
 save('event-trigger-rls-native-probe.json',result)
 if not result['passed']:raise RuntimeError('Captured ensure_rls probe '+r.stdout+r.stderr)
 sql(db,'truncate extensions.alignment_ddl_log;')


def captured_tourney_legacy_refusal(db,branch_defs):
 version='20260715060000';p=next((REPO/'supabase/migrations').glob(version+'*.sql'))
 body=adapted_body(version,p.read_text(),catalog(db),branch_defs)
 active="v_meta.hardened_active and exists(select 1 from tourney.mirror_contracts where enabled)"
 legacy=body.replace('if '+active+' and (','if v_meta.hardened_active and (').replace('if '+active+' then','if v_meta.hardened_active then')
 before=row_snapshot(db);cat=catalog(db);r=apply(db,"\\set VERBOSITY verbose\n"+legacy,False)
 same=before==row_snapshot(db) and not differences(norm(cat),norm(catalog(db)))
 result={'exit':r.returncode,'stderr':r.stderr,'captured_controls':tourney_controls(db),'rows_and_catalog_unchanged':same,'passed':r.returncode!=0 and '55000' in r.stderr and 'safety preconditions are not satisfied' in r.stderr and same}
 save('captured-tourney-old-adaptation-refusal.json',result)
 if not result['passed']:raise RuntimeError('Old adaptation captured-state reproduction '+r.stderr)


def platform_full_proof(stages,initial,final,rollback_body,baseline_views):
 expected=sorted(EXTRA['event_triggers'],key=lambda event:event['name'])
 current=event_metadata('replica')
 view_metadata=[{k:v for k,v in view.items() if k!='rows'} for view in baseline_views]
 current_views=ops_views('replica')
 if current!=expected or [{k:v for k,v in view.items() if k!='rows'} for view in current_views]!=view_metadata:raise RuntimeError('Platform hooks or ops view definitions changed during rollback')
 off=event_metadata('platform_control')
 for event in off:sql('platform_control','alter event trigger '+ident(event['name'])+' disable;')
 sql('platform_control','alter event trigger alignment_trace disable;')
 for st in stages:apply('platform_control',st['guard'].replace(platform_guard(),'')+st['body'])
 hook_dif=differences(norm(final['catalog']),norm(catalog('platform_control')))
 if hook_dif:raise RuntimeError('Platform event hooks changed migration end-state '+str(hook_dif))
 save('event-hooks-enabled-vs-disabled-end-state.json',{'differences':hook_dif,'all_16_steps_succeeded':True})
 sql('ops_stable',"insert into commerce.email_dispatches(booking_id,recipient_type,recipient_email_hash,idempotency_key,status) select migration.document_uuid('booking','alignment-unknown'),recipient,repeat('f',64),'alignment-unknown-history-'||recipient,'historical_unknown' from (values('customer'),('owner')) v(recipient);")
 sql('ops_stable','drop event trigger alignment_trace;')
 stable_before=ops_views('ops_stable');save('ops-stable-rows-before.json',stable_before)
 per_step=[]
 for st in stages:
  apply('ops_stable',st['guard']+st['body']);same=stable_before==ops_views('ops_stable');per_step.append({'version':st['version'],'same_view_rows_definitions_acl_owner':same})
  if not same:save('ops-stable-steps.json',per_step);raise RuntimeError('Seeded ops view rows changed '+st['version'])
 save('ops-stable-rows-after.json',ops_views('ops_stable'));sql('ops_stable',rollback_body)
 stable_rollback=ops_views('ops_stable');save('ops-stable-rows-after-rollback.json',stable_rollback);save('ops-stable-steps.json',per_step)
 if stable_before!=stable_rollback or event_metadata('ops_stable')!=expected:raise RuntimeError('Ops view rows or hooks changed after rollback')
 if current_views!=json.loads((RUN/'ops-view-rows-after.json').read_text()):raise RuntimeError('Documented ops view result changed during schema rollback')
 if tourney_controls('replica')!=json.loads((RUN/'captured-tourney-controls-before.json').read_text()):raise RuntimeError('Captured retired Tourney controls changed')
 PLATFORM_PROOF.update(passed=True,event_trigger_metadata_unchanged=True,event_hooks_end_state_differences=hook_dif,ops_seeded_all_16_steps_and_rollback_equal=True,captured_retired_tourney_controls_unchanged=True,standard_hook_models_source='https://github.com/supabase/postgres/blob/develop/migrations/schema-17.sql',ensure_rls_source=str(EXTRA_PATH))
 save('platform-captured-state-proof.json',PLATFORM_PROOF)


def platform_preimage_checks(stages):
 st=stages[0];view=next(v for v in EXTRA['views'] if v['name']=='ops.bookings_overview');definition=view['definition'].rstrip(';')
 cases=[('modified-ensure-rls-body',"alter function public.rls_auto_enable() cost 99;",'Unknown function preimage'),('disabled-platform-event-hook',"alter event trigger pgrst_ddl_watch disable;",'Unknown platform event-trigger preimage'),('unexpected-alignment-trace-hook',"create event trigger alignment_trace on ddl_command_end execute function extensions.alignment_trace();",'Unknown platform event-trigger preimage'),('changed-protected-ops-view-definition','create or replace view ops.bookings_overview as select * from ('+definition+') captured where false;','Unknown protected ops view preimage')]
 results=[]
 for name,mutate,expected in cases:
  rows=row_snapshot('replica');cat=catalog('replica');views=ops_views('replica');events=event_metadata('replica')
  r=sql('replica','begin;'+mutate+st['guard']+st['body']+'commit;',False)
  same=rows==row_snapshot('replica') and not differences(norm(cat),norm(catalog('replica'))) and views==ops_views('replica') and events==event_metadata('replica')
  results.append({'scenario':name,'exit':r.returncode,'expected_refusal':expected,'stderr':r.stderr,'rows_catalog_views_and_hooks_unchanged':same,'passed':r.returncode!=0 and expected in r.stderr and same})
  if not results[-1]['passed']:save('platform-preimage-refusal-results.json',results);raise RuntimeError('Platform preimage refusal '+name+' '+r.stderr)
 save('platform-preimage-refusal-results.json',results)


def restore_extra_capture(db):
 capture=supplemental_capture()
 if not capture:return
 for f in capture.get('functions') or []:
  sql(db,f['definition'].rstrip(';')+';alter function '+f['signature']+' owner to '+f['owner']+';'+acl_restore('function',f['signature'],f['acl']))
 for v in capture.get('views') or []:
  sql(db,'create view '+v['name']+' as '+v['definition'].rstrip(';')+';alter view '+v['name']+' owner to '+v['owner']+';'+acl_restore('table',v['name'],v['acl']))
  for option in v.get('options') or []:sql(db,'alter view '+v['name']+' set ('+option+');')
 restore_privileges(db,capture)
 for name,owner in (capture.get('owners') or {}).items():
  if name in {t['t'] for t in HOST['tables']}:sql(db,'alter table '+name+' owner to '+owner+';')


def ident(name):return '"'+name.replace('"','""')+'"'

def restore_privileges(db,capture):
 known={r['name'] for r in json.loads(sql(db,"select json_agg(json_build_object('name',rolname)) from pg_roles").stdout)}
 principals={row['owner'] for row in (capture.get('schema_privileges') or [])+(capture.get('default_privileges') or [])}
 for row in (capture.get('schema_privileges') or [])+(capture.get('default_privileges') or []):
  principals|={entry.split('=',1)[0] for entry in (row.get('acl') or '{}')[1:-1].split(',') if entry}
 for role in sorted(principals-known-{''}):sql(db,'create role '+ident(role)+' nologin;')
 for row in capture.get('schema_privileges') or []:
  name=ident(row['name']);sql(db,'alter schema '+name+' owner to '+ident(row['owner'])+';revoke all on schema '+name+' from public,anon,authenticated,service_role;')
  for entry in (row.get('acl') or '{}')[1:-1].split(','):
   if not entry:continue
   role,rest=entry.split('=',1);letters=rest.split('/',1)[0]
   for flag,priv in [('U','usage'),('C','create')]:
    if flag in letters:sql(db,'grant '+priv+' on schema '+name+' to '+(ident(role) if role else 'public')+(' with grant option' if flag+'*' in letters else '')+';')
 for row in capture.get('default_privileges') or []:
  if row['owner']!='postgres':continue
  kinds={'r':'tables','f':'functions','S':'sequences','T':'types','n':'schemas'};kind=kinds[row['kind']]
  prefix='alter default privileges for role '+ident(row['owner'])+(' in schema '+ident(row['schema']) if row.get('schema') else '')+' '
  targets={entry.split('=',1)[0] for entry in (row.get('acl') or '{}')[1:-1].split(',') if entry}|{'','anon','authenticated','service_role','postgres'}
  sql(db,prefix+'revoke all on '+kind+' from '+','.join(ident(role) if role else 'public' for role in sorted(targets))+';')
  for entry in (row.get('acl') or '{}')[1:-1].split(','):
   if not entry:continue
   role,rest=entry.split('=',1);letters=rest.split('/',1)[0];i=0
   flags={'a':'insert','r':'select','w':'update','d':'delete','D':'truncate','x':'references','t':'trigger','m':'maintain','X':'execute','U':'usage','C':'create'}
   while i<len(letters):
    flag=letters[i];grant_option=i+1<len(letters) and letters[i+1]=='*'
    sql(db,prefix+'grant '+flags[flag]+' on '+kind+' to '+(ident(role) if role else 'public')+(' with grant option' if grant_option else '')+';')
    i+=2 if grant_option else 1


def discord_retirement_check(db,allowed):
 for hardened in [True,False]:
  before=row_snapshot(db);cat=catalog(db)
  setup='' if hardened else "update tourney.cutover_metadata set hardened_active=false where id='tourney';"
  body="begin;"+setup+"insert into accounts.discord_role_assignments(user_id,discord_user_id,guild_id) values('11111111-0000-0000-0000-000000000001','123456789','987654321');select jsonb_build_object('rows',count(*),'principal_correct',bool_and(principal_id='22222222-0000-0000-0000-000000000001'::uuid)) from accounts.discord_role_assignments where discord_user_id='123456789';rollback;"
  r=sql(db,"\\set VERBOSITY verbose\n"+body,False)
  same=before==row_snapshot(db) and not differences(norm(cat),norm(catalog(db)))
  expected='Tourney mirror command context is required' if hardened else 'Tourney mirror source authority is invalid'
  passed=(r.returncode==0 and '"principal_correct": true' in r.stdout) if allowed else (r.returncode!=0 and expected in r.stderr)
  suffix='' if hardened else '-inactive-control'
  save('discord-retired-'+('after' if allowed else 'before')+suffix+'.json',{'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'expected_allowed':allowed,'all_rows_and_catalog_unchanged_after_transaction':same,'passed':passed,'exact_input':{'user_id':'11111111-0000-0000-0000-000000000001','discord_user_id':'123456789','guild_id':'987654321','hardened_active':hardened,'enabled_contracts':0,'base_captured_controls':tourney_controls(db)}})
  if not passed or not same:raise RuntimeError('retired Discord trigger proof '+r.stderr+r.stdout)


def principal_session_state(db):
 parts=[]
 for name in ['auth.users','auth.sessions','auth.refresh_tokens','accounts.principals','accounts.principal_auth_users']:
  parts.append('select '+quote(name)+" t,coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) rows from "+name+' r')
 return json.loads(sql(db,'select jsonb_object_agg(t,rows) from ('+' union all '.join(parts)+') s').stdout)

def principal_session_checks(db):
 before=principal_session_state(db); results=[]
 principal='22222222-0000-0000-0000-000000000001'
 mapped={row['user_id'] for row in before['accounts.principal_auth_users'] if row['principal_id']==principal}
 if mapped!={'11111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000005'}:raise RuntimeError('Principal-session fixture must map exactly two users')
 for status in ['disabled','deleted']:
  parts=[]
  for name in before:parts.append('select '+quote(name)+" t,coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) rows from "+name+' r')
  r=sql(db,"begin;update accounts.principals set status="+quote(status)+' where id='+quote(principal)+"::uuid;select jsonb_object_agg(t,rows) from ("+' union all '.join(parts)+') s;rollback;')
  after=json.loads(r.stdout)
  for old in before['auth.users']:
   current=next(row for row in after['auth.users'] if row['id']==old['id'])
   if old['id'] in mapped:
    if current['banned_until']!='infinity' or {k:v for k,v in current.items() if k not in ['banned_until','updated_at']}!={k:v for k,v in old.items() if k not in ['banned_until','updated_at']}:raise RuntimeError('Mapped Auth user ban incorrect')
   elif current!=old:raise RuntimeError('Unrelated Auth user changed')
  for name in ['auth.sessions','auth.refresh_tokens']:
   expected=[row for row in before[name] if row['user_id'] not in mapped]
   if after[name]!=expected:raise RuntimeError('Principal session removal changed unrelated or retained mapped rows '+name)
  old=next(row for row in before['accounts.principals'] if row['id']==principal)
  current=next(row for row in after['accounts.principals'] if row['id']==principal)
  if current['status']!=status or current['session_version']!=old['session_version']+1:raise RuntimeError('Principal status/session version incorrect')
  if [row for row in after['accounts.principals'] if row['id']!=principal]!=[row for row in before['accounts.principals'] if row['id']!=principal] or after['accounts.principal_auth_users']!=before['accounts.principal_auth_users']:raise RuntimeError('Unrelated principal or mapping changed')
  if principal_session_state(db)!=before:raise RuntimeError('Principal probe did not roll back')
  results.append({'scenario':'principal-'+status+'-mapped-auth-only','passed':True,'mapped_users':sorted(mapped),'before':before,'after':after,'rollback_equal':True})
 save('principal-session-trigger-results.json',results)

def currency_checks(db):
 bad={'_id':'alignment-currency-bad','_type':'paymentRecord','provider':'razorpay','status':'needs_recovery','sessionScope':'alignment-currency-bad','providerIdempotencyKey':'alignment-currency-bad','quoteFingerprint':'alignment','pricingSnapshot':{'currency':'USD','netAmount':9.99},'bookingPayload':{'currency':'USD','netAmount':9.99},'providerPublicData':{'currency':'KWD','totalAmount':9990},'refundCurrency':'KWD','providerRecoveryTerminal':True,'providerRecoveryTerminalReason':'payment_currency_mismatch'}
 unrelated={'_id':'alignment-currency-unrelated','_type':'booking','status':'completed','currency':'USD','netAmount':1.23,'packageTitle':'Alignment unrelated fixture'}
 for obj in [bad,unrelated]:sql(db,'insert into migration.source_documents(legacy_sanity_id,document_type,source_hash,payload) values('+quote(obj['_id'])+','+quote(obj['_type'])+','+quote('f'*64)+','+quote(json.dumps(obj))+'::jsonb);')
 baseline=row_snapshot(db);cat=catalog(db);results=[]
 for name,operation in [('full-project','select public.roo_project_operational_shadow();'),('full-refresh','select public.roo_refresh_operational_shadow();'),('mixed-incremental',"select migration.project_commerce_document_ids(array['alignment-currency-bad','alignment-currency-unrelated']);")]:
  r=sql(db,"\\set VERBOSITY verbose\n"+operation,False)
  unchanged=baseline==row_snapshot(db)
  result={'scenario':name,'exit':r.returncode,'sqlstate_22023':'22023' in r.stderr,'payment_currency_mismatch':'payment_currency_mismatch' in r.stderr,'all_rows_unchanged':unchanged,'stderr':r.stderr};results.append(result)
  if not r.returncode or '22023' not in r.stderr or 'payment_currency_mismatch' not in r.stderr or not unchanged:save('currency-projection-results.json',results);raise RuntimeError('currency projection proof '+name+' '+r.stderr)
 r=sql(db,"select migration.project_commerce_document_ids(array['alignment-currency-unrelated']);",False);after=row_snapshot(db);delta=row_diff(baseline,after)
 known=baseline['migration.source_documents'];bad_before=next(x for x in known if x['legacy_sanity_id']==bad['_id']);bad_after=next(x for x in after['migration.source_documents'] if x['legacy_sanity_id']==bad['_id'])
 book=next((x for x in after['commerce.bookings'] if x['legacy_sanity_id']==unrelated['_id']),None)
 source_deltas=[{'id':a['legacy_sanity_id'],'fields':[k for k in a if a.get(k)!=b.get(k)]} for a,b in zip(sorted(baseline['migration.source_documents'],key=lambda x:x['legacy_sanity_id']),sorted(after['migration.source_documents'],key=lambda x:x['legacy_sanity_id'])) if a!=b]
 results.append({'scenario':'unrelated-incremental','source_deltas':source_deltas,'exit':r.returncode,'output':r.stdout,'stderr':r.stderr,'bad_source_unchanged':bad_before==bad_after,'unrelated_booking':book,'changed_tables':delta})
 if r.returncode or not book or book['currency']!='USD' or book['amount_subunits']!=123 or bad_before!=bad_after or any(x['table'] not in ['commerce.bookings','migration.source_documents'] for x in delta) or source_deltas!=[{'id':unrelated['_id'],'fields':['operational_imported']}]:save('currency-projection-results.json',results);raise RuntimeError('unrelated incremental proof '+r.stderr+str(delta))
 impact=sql(db,impact_file('impact-currency.sql').read_text(),False);save('currency-impact-local-result.json',{'exit':impact.returncode,'output':impact.stdout,'stderr':impact.stderr})
 if impact.returncode or 'paymentRecord|payment_currency_mismatch|1' not in impact.stdout:raise RuntimeError('currency impact proof '+impact.stderr+impact.stdout)
 save('currency-projection-results.json',results)
 examples=[
 ('all-missing',{}),('null-blank',{'pricingSnapshot':{'currency':None},'bookingPayload':{'currency':'  '}}),
 ('normalized',{'pricingSnapshot':{'currency':' usd '},'providerPublicData':{'currency':'USD'}}),
 ('provider-kwd',{'providerPublicData':{'currency':'KWD','totalAmount':9990}}),
 ('typed-fallback-kwd',{'bookingId':'alignment-typed-kwd'}),('explicit-overrides-typed',{'bookingId':'alignment-typed-kwd','pricingSnapshot':{'currency':'EUR'}}),
 ('invalid-number',{'pricingSnapshot':{'currency':1}}),('invalid-object',{'providerPublicData':{'currency':{}}}),
 ('invalid-array',{'refundCurrency':[]}),('invalid-tab',{'pricingSnapshot':{'currency':'\t'}}),
 ('mismatch-before-invalid',{'pricingSnapshot':{'currency':'USD'},'bookingPayload':{'currency':'KWD'},'refundCurrency':1}),
 ('invalid-before-mismatch',{'pricingSnapshot':{'currency':1},'bookingPayload':{'currency':'USD'},'refundCurrency':'KWD'}),
 ('refund-mismatch',{'providerPublicData':{'currency':'KWD'},'refunds':[{'currency':'KWD'},{'currency':'USD'}]}),
 ('nonarray-refunds',{'providerPublicData':{'currency':'KWD'},'refunds':{'currency':'USD'}}),
 ('nonobject-refund-members',{'refunds':[None,2,'USD']}),('empty-refund-code',{'refunds':[{'currency':' '},{'currency':'EUR'}]})]
 sql(db,"insert into commerce.bookings(id,legacy_sanity_id,status,package_title,amount_subunits,currency) values(migration.document_uuid('booking','alignment-typed-kwd'),'alignment-typed-kwd','completed','Typed KWD fallback',9990,'KWD');")
 fixture_ids=[]
 for name,payload in examples:
  key='alignment-currency-case-'+name;fixture_ids.append(key)
  payload=dict(payload,_id=key,_type='paymentRecord')
  sql(db,'insert into migration.source_documents(legacy_sanity_id,document_type,source_hash,payload) values('+quote(key)+",'paymentRecord',"+quote('e'*64)+','+quote(json.dumps(payload))+'::jsonb);')
 book_examples=[('own-mismatch',{'currency':'USD','bookingPayload':{'currency':'KWD'}}),('own-invalid',{'currency':2}),('linked-bad',{'paymentRecordId':bad['_id']}),('linked-kwd',{'paymentRecordId':'alignment-currency-case-provider-kwd'}),('linked-kwd-own-usd',{'currency':'USD','paymentRecordId':'alignment-currency-case-provider-kwd'}),('linked-no-explicit-typed-kwd',{'currency':'USD','paymentRecordId':'alignment-currency-case-typed-fallback-kwd'}),('own-invalid-linked-mismatch',{'currency':2,'paymentRecordId':bad['_id']})]
 for name,payload in book_examples:
  key='alignment-currency-book-'+name;fixture_ids.append(key);payload=dict(payload,_id=key,_type='booking')
  sql(db,'insert into migration.source_documents(legacy_sanity_id,document_type,source_hash,payload) values('+quote(key)+",'booking',"+quote('d'*64)+','+quote(json.dumps(payload))+'::jsonb);')
 impact_sql=impact_file('impact-currency.sql').read_text();body=impact_sql.split('with sources as materialized',1)[1].rsplit('select document_type,coalesce(reason',1)[0]
 query='with sources as materialized'+body+"select jsonb_agg(jsonb_build_object('id',legacy_sanity_id,'type',document_type,'reason',reason)) from results;"
 classified=json.loads(sql(db,query).stdout);cases=[]
 for key in fixture_ids:
  t=next(x['type'] for x in classified if x['id']==key);predicted=sorted({x['reason'] for x in classified if x['id']==key and x['reason']})
  function='migration.booking_currency(payload,legacy_sanity_id)' if t=='booking' else "migration.payment_currency(payload,(select to_jsonb(currency) from commerce.bookings where legacy_sanity_id=nullif(source.payload->>'bookingId','')))"
  r=sql(db,"\\set VERBOSITY verbose\nselect "+function+' from migration.source_documents source where legacy_sanity_id='+quote(key)+';',False)
  observed='payment_currency_invalid' if 'payment_currency_invalid' in r.stderr else 'payment_currency_mismatch' if 'payment_currency_mismatch' in r.stderr else None
  correct=observed in predicted if predicted else r.returncode==0
  cases.append({'scenario':key,'predicted_reasons':predicted,'observed_reason':observed,'returned_currency':r.stdout.strip(),'matches':correct})
  if not correct:save('currency-classifier-contract-results.json',cases);raise RuntimeError('currency classifier differs '+key+' '+r.stderr+str(predicted))
 save('currency-classifier-contract-results.json',cases)


started=False
try:
 save('input-hashes.json',INPUTS)
 proof_inputs={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),W/'hosted-full-catalog.raw.json',W/'ledger-statements.raw.json',W/'stub.sql',W/'hosted-full-catalog.sql',impact_file('alignment-seed.sql'),impact_file('impact-alignment.sql'),impact_file('impact-currency.sql'),impact_file('platform-event-functions.sql'),W/'missing-capture-read-only.sql']+([EXTRA_PATH] if EXTRA_PATH.exists() else [])+([TOURNEY_PATH] if TOURNEY_PATH.exists() else [])}
 save('rehearsal-input-hashes.json',proof_inputs)
 version=cmd([BIN/'postgres','--version']).stdout
 if not re.search(r'PostgreSQL\) 17\.',version):raise RuntimeError('PostgreSQL17 binaries required: '+version)
 cmd([BIN/'initdb','-D',DATA,'-U','postgres','-A','trust']);started=True;cmd([BIN/'pg_ctl','-D',DATA,'-o',"-k "+str(RUN)+" -c listen_addresses='' -p "+PORT,'-l',RUN/'postgres.log','-w','start']);started=True
 save('postgres-version.json',{'server_version':sql('postgres',"select current_setting('server_version')").stdout.strip(),'binaries':str(BIN),'unix_socket':str(RUN),'listen_addresses':sql('postgres',"select current_setting('listen_addresses')").stdout.strip()})
 print('local run',RUN,flush=True)
 replica=build('replica',True);save('replica-before-overrides.json',replica);replica=replica_overrides('replica');save('replica-before.json',replica);save('replica-functions-before.json',definitions('replica'))
 dif=differences(norm(HOST,True),norm(replica));save('replica-fidelity-differences.json',dif)
 print('replica differences',len(dif),flush=True)
 branch=build('branch');save('expected-current-branch.json',branch);save('expected-current-functions.json',definitions('branch'))
 save('provided-branch-vs-current-differences.json',differences(norm(json.loads((W/'local-branch.json').read_text())),norm(branch)))
 captured_tourney_restore('replica');event_model_install('replica');event_model_probe('replica')
 views_before=ops_views('replica',False)
 save('ops-view-metadata-before.json',{'expected':sorted(EXTRA['views'],key=lambda view:view['name'].split('.')[-1]),'actual':views_before})
 if views_before!=sorted(EXTRA['views'],key=lambda view:view['name'].split('.')[-1]):raise RuntimeError('Captured ops view definitions/owners/options/ACL differ')
 sql('replica',impact_file('alignment-seed.sql').read_text());save('seeded-rows-before.json',row_snapshot('replica'));data=[];discord_retirement_check('replica',False);initial_state=state('replica');save('rollback-local-prestate.json',initial_state);stages=[]
 baseline_views=ops_views('replica');save('ops-view-rows-before.json',baseline_views);captured_tourney_legacy_refusal('replica',definitions('branch'))
 for db in ['platform_control','ops_stable','durable_base']:sql('postgres','create database '+db+' template replica;')
 sql('durable_base','drop event trigger alignment_trace;');seed_ledger('durable_base')
 captured_controls=tourney_controls('replica');captured_control_steps=[];ops_steps=[]
 tests=[]
 for version in MISSING:
  rows_before=row_snapshot('replica');step_before=state('replica')
  p=next((REPO/'supabase/migrations').glob(version+'*.sql'));r=apply('replica',p.read_text(),False)
  test={'source':str(p),'exit':r.returncode,'stderr':r.stderr};tests.append(test);print(version,'verbatim',r.returncode,r.stderr[:180].replace('\n',' '),flush=True)
  if r.returncode:
   before=catalog('replica');body=adapted_body(version,p.read_text(),before,definitions('branch'))
   names={x['sig'] for x in before['functions'] if x['sig'].startswith(('public.roo_tourney_readiness','tourney.capture_mirror_event','tourney.mirror_trigger_binding_status_v4','public.roo_activate_tourney_schema_v4','public.roo_apply_commerce_document_mutations','migration.roo_apply_commerce_document_mutations_unbounded'))}|{'public.roo_backfill_tourney_email_history_v4(p_actor text)','public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)'}
   guard=function_guard(before,names);save(version+'-adapted.sql',guard+body);rr=apply('replica',guard+body,False);test['adapted_exit']=rr.returncode;test['adapted_stderr']=rr.stderr
   if rr.returncode:raise RuntimeError('adapted '+version+' '+rr.stderr)
  step_after=state('replica');guard=stage_guard(step_before,step_after)
  if r.returncode:
   guard+=function_guard(step_before['catalog'],names)
   related={x['t'] for x in step_before['catalog']['tables'] if x['t'].startswith('tourney.') or x['t']=='accounts.discord_role_assignments'} if version=='20260715060000' else {'migration.commerce_commands','migration.source_documents','commerce.bookings','commerce.slot_holds','commerce.slot_claims'}
   checks=[]
   for relation in sorted(related):
    checks.append('if ('+relation_shape_sql(relation)+') is distinct from '+quote(json.dumps(step_before['shapes'][relation]))+"::jsonb then raise exception 'Unknown adapted relation preimage: %',"+quote(relation)+" using errcode='55000'; end if;")
   guard+='do $adapted$ begin\n'+'\n'.join(checks)+'\nend $adapted$;\n'
   if version=='20260715060000':
    destinations=sorted(x['supabase_relation'] for x in rows_before['tourney.mirror_contracts'])
    if any(x not in step_before['shapes'] or not (x.startswith('tourney.') or x=='accounts.discord_role_assignments') for x in destinations):raise RuntimeError('Mirror registry includes an uncaptured or shared destination')
    guard+="do $retirement$ begin if exists(select 1 from tourney.mirror_contracts where enabled) then raise exception 'Alignment requires retired zero-enabled mirror contracts' using errcode='55000'; end if; end $retirement$;\n"
    guard+="do $contracts$ begin if exists(select 1 from tourney.mirror_contracts where enabled and not (supabase_relation=any(array["+','.join(quote(x) for x in destinations)+"]::text[]))) then raise exception 'Unknown tourney mirror contract destination' using errcode='55000'; end if; end $contracts$;\n"
  guard+=platform_guard()+ledger_pre_guard(version)
  applied_body=body if r.returncode else p.read_text();stages.append({'source':str(p),'version':version,'body':applied_body,'guard':guard,'before':step_before,'after':step_after})
  if r.returncode:
   import difflib
   save(version+'-adapted.sql','begin;\n'+guard+body+'\ncommit;\n')
   save(version+'-adaptation.diff',''.join(difflib.unified_diff(p.read_text().splitlines(True),body.splitlines(True),fromfile=p.name,tofile=version+'-adapted.sql')))
  data.append({'version':version,'changes':row_diff(rows_before,row_snapshot('replica'))})
  control_unchanged=captured_controls==tourney_controls('replica');captured_control_steps.append({'version':version,'all_clock_and_metadata_fields_unchanged':control_unchanged})
  if not control_unchanged:raise RuntimeError('Captured Tourney metadata changed '+version)
  views=ops_views('replica');ops_steps.append({'version':version,'views':views})
  if views!=baseline_views:raise RuntimeError('Ops view rows changed before documented backfill '+version)
 save('data-preservation-by-step.json',data)
 save('verbatim-results.json',tests);save('replica-after-omitted.json',catalog('replica'))
 for p in sorted((REPO/'supabase/migrations').glob('20261005*.sql')):
  rows_before=row_snapshot('replica');step_before=state('replica');r=apply('replica',p.read_text(),False);print(p.name,'forward',r.returncode,r.stderr[:160].replace('\n',' '),flush=True)
  if r.returncode:raise RuntimeError('forward '+str(p)+' '+r.stderr)
  step_after=state('replica');guard=stage_guard(step_before,step_after)+platform_guard()+ledger_pre_guard(p.name.split('_',1)[0]);stages.append({'source':str(p),'version':p.name.split('_',1)[0],'body':p.read_text(),'guard':guard,'before':step_before,'after':step_after})
  data.append({'version':p.name,'changes':row_diff(rows_before,row_snapshot('replica'))})
  control_unchanged=captured_controls==tourney_controls('replica');captured_control_steps.append({'version':p.name,'all_clock_and_metadata_fields_unchanged':control_unchanged})
  if not control_unchanged:raise RuntimeError('Captured Tourney metadata changed '+p.name)
  ops_steps.append({'version':p.name,'views':ops_views('replica')})
 save('data-preservation-by-step.json',data);save('seeded-rows-after.json',row_snapshot('replica'));preservation_proof(json.loads((RUN/'seeded-rows-before.json').read_text()),row_snapshot('replica'))
 save('captured-tourney-controls-per-step.json',captured_control_steps);save('captured-tourney-controls-after.json',tourney_controls('replica'));save('ops-view-rows-per-step.json',ops_steps);save('ops-view-rows-after.json',ops_views('replica'))
 ops_documented_effects(baseline_views,ops_views('replica'))
 trace=json.loads(sql('replica',"select coalesce(jsonb_agg(jsonb_build_object('tag',tag,'schema_name',schema_name,'object_type',object_type,'identity',identity)),'[]'::jsonb) from extensions.alignment_ddl_log").stdout);save('event-trigger-apply-ddl-trace.json',trace)
 if any(x['tag'] in ['CREATE EXTENSION','DROP EXTENSION'] or (x['tag'] in ['CREATE TABLE','CREATE TABLE AS','SELECT INTO'] and x['schema_name']=='public') for x in trace):raise RuntimeError('Unexpected platform hook activation in apply DDL')
 sql('replica','drop event trigger alignment_trace;')
 discord_retirement_check('replica',True)
 principal_session_checks('replica')
 save('replica-after-forward.json',catalog('replica'));save('end-state-differences.json',differences(norm(branch),norm(catalog('replica'))));final_state=state('replica');save('stages.json',stages)
 capture_query=rollback_capture_sql(initial_state,final_state);save('rollback-capture-read-only.sql',capture_query);capture_result=sql('replica',capture_query,False);save('rollback-capture-local-result.json',{'exit':capture_result.returncode,'output':capture_result.stdout,'stderr':capture_result.stderr})
 if capture_result.returncode:raise RuntimeError('rollback capture query '+capture_result.stderr)
 rb=with_ledger_rollback(rollback_sql(initial_state,final_state),stages);save('rollback-local.sql',rb);r=sql('replica',rb,False);save('rollback-result.json',{'exit':r.returncode,'stderr':r.stderr});print('rollback',r.returncode,r.stderr[:200],flush=True)
 if r.returncode:raise RuntimeError('rollback '+r.stderr)
 rollback_dif=differences(norm(initial_state['catalog']),norm(catalog('replica')));save('rollback-catalog-differences.json',rollback_dif);save('rollback-rows-after.json',row_snapshot('replica'))
 endproof=scoped_result(initial_state['catalog'],final_state['catalog'],branch);save('end-state-proof.json',endproof)
 adverse_checks(stages,initial_state,final_state,rb)
 platform_preimage_checks(stages)
 save('ops-view-rows-after-rollback.json',ops_views('replica'));save('captured-tourney-controls-after-rollback.json',tourney_controls('replica'));save('event-triggers-modeled-after-rollback.json',event_metadata('replica'))
 platform_full_proof(stages,initial_state,final_state,rb,baseline_views)
 adapted_fresh=[]
 for st in [x for x in stages if x['version'] in ['20260715060000','20260718011000']]:
  r=apply('branch',st['guard']+st['body'],False);adapted_fresh.append({'version':st['version'],'exit':r.returncode,'refuses_fresh_build':bool(r.returncode),'stderr':r.stderr})
  if not r.returncode:raise RuntimeError('adapted file should be kept out of migrations; guard unexpectedly accepted fresh main')
 save('adapted-fresh-build-refusals.json',adapted_fresh)
 current={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((REPO/'supabase/migrations').glob('*.sql'))}
 if any(not Path(path).exists() or hashlib.sha256(Path(path).read_bytes()).hexdigest()!=expected for path,expected in proof_inputs.items()):raise RuntimeError('Rehearsal inputs changed during run; repeat before accepting proof')
 if current!=INPUTS:raise RuntimeError('Source migrations changed during rehearsal; rerun before accepting proof')
 manifest=write_manifest(stages,initial_state,final_state,dif,endproof,rollback_dif);print('manifest ready',manifest['ready'],flush=True)
 save('result.json',{'local_checks_pass':True,'apply_ready':manifest['ready'],'manifest':str(RELEASE/RUN.name/'manifest.json')})
 if not manifest['ready']:sys.exit(2)
except Exception as e:
 save('error.txt',str(e));print('BLOCKED',str(e),flush=True);sys.exit(1)
finally:
 if started:
  stopped=cmd([BIN/'pg_ctl','-D',DATA,'-m','fast','-w','stop'],False)
  if stopped.returncode==0 or not (DATA/'postmaster.pid').exists():shutil.rmtree(DATA)
  else:save('cleanup-blocked.txt','Owned PostgreSQL stop failed; data retained at '+str(DATA))

import uuid,concurrent.futures

def q(v):return "'"+str(v).replace("'","''")+"'"
def j(v):return q(json.dumps(v))+'::jsonb'
def rpc(name,args):return value('select public.'+name+'('+','.join(args)+');')
def mutations(cmd,items):return rpc('roo_apply_commerce_document_mutations',[q(cmd),j(items),'1'])
def create_doc(doc,cmd=None):return mutations(cmd or 'fixture-create-'+doc['_id'],[{'operation':'create','document':doc}])
def source(id):return value('select to_jsonb(s) from migration.source_documents s where legacy_sanity_id='+q(id)+';')
def source_payload(id):return source(id)['payload']
def publish(doc=None,operation='create',id=None,revision=None,actor='admin:key',salt=''):
 id=id or doc['_id'];m={'operation':operation,'id':id}
 if doc is not None:m['document']=doc
 if revision is not None:m['expected_revision']=revision
 h=hashlib.sha256(json.dumps([actor,m,salt],sort_keys=True).encode()).hexdigest()
 return rpc('roo_apply_cms_publish_command',[q('cms:'+h),q(h),q(actor),j([m]),"'[]'::jsonb","'[]'::jsonb"])
def refused(name,body,needle):
 r=sql(body,False);check(name,r.returncode!=0 and needle in r.stderr);return r.stderr

def snapshot_rows():
 tables=value("select jsonb_agg(c.oid::regclass::text order by c.oid::regclass::text) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','migration','commerce','accounts','cms','licensing','tourney','ops','auth','storage') and not exists(select 1 from pg_depend d where d.objid=c.oid and d.deptype='e');")
 return {t:value("select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) from "+t+' r;') for t in tables}

def seed_release():
 sql("update migration.commerce_control set primary_backend='supabase',generation=1,starts_paused=false where singleton;")
 for owner in ['sanity','supabase','missing']:
  fields={} if owner=='missing' else {'backendOwner':owner}
  for typ,extra in [('paymentRecord',{'provider':'paypal','status':'needs_recovery','providerOrderId':'order-'+owner,'netAmount':9.99,'currency':'USD'}),('slotHold',{'phase':'active','startTimeUTC':'2099-01-0'+str(1+['sanity','supabase','missing'].index(owner))+'T00:00:00Z','expiresAt':'2020-01-01T00:00:00Z','packageTitle':'Fixture','holdNonce':'nonce-'+owner}),('booking',{'status':'captured','packageTitle':'Fixture','netAmount':9.99,'currency':'USD'})]:
   id='fixture-'+typ+'-'+owner;create_doc({'_id':id,'_type':typ,'cutoverGeneration':1,**fields,**extra})
   sql("update migration.source_documents set backend_owner="+q('sanity' if owner!='supabase' else owner)+" where legacy_sanity_id="+q(id)+';')
   if owner=='missing':sql('update migration.source_documents set payload=payload-\'backendOwner\' where legacy_sanity_id='+q(id)+';')
   table={'paymentRecord':'payment_records','slotHold':'slot_holds','booking':'bookings'}[typ]
   sql('update commerce.'+table+' set backend_owner='+q('sanity' if owner!='supabase' else owner)+',source_backend='+q('sanity' if owner!='supabase' else owner)+' where legacy_sanity_id='+q(id)+';')
 sql("update commerce.slot_holds set payload=payload-'backendOwner' where legacy_sanity_id='fixture-slotHold-missing';update commerce.bookings set booking_payload=booking_payload-'backendOwner' where legacy_sanity_id='fixture-booking-missing';")
 sql("update commerce.slot_holds set cutover_generation=0 where legacy_sanity_id='fixture-slotHold-missing'; update migration.source_documents set cutover_generation=0,payload=jsonb_set(payload,'{cutoverGeneration}','0'::jsonb) where legacy_sanity_id='fixture-slotHold-missing'; update commerce.slot_holds set payload=jsonb_set(payload,'{cutoverGeneration}','0'::jsonb) where legacy_sanity_id='fixture-slotHold-missing';")
 for i,status in enumerate(['pending','retry','processing','mirrored','dead_letter','superseded']):
  sql("insert into migration.commerce_commands(command_id,request_hash,cutover_generation,result,operation) values("+q('fixture-outbox-'+status)+",repeat('1',64),1,'{}','document_mutation'); insert into migration.commerce_mirror_outbox(command_id,event_key,document_ids,canonical_hash,cutover_generation,status,lease_id,lease_expires_at,next_attempt_at,mirrored_at) values("+q('fixture-outbox-'+status)+','+q('fixture-event-'+status)+",array['fixture-audit'],repeat('2',64),1,"+q(status)+','+("'old-lease',now()+interval '1 hour'" if status=='processing' else 'null,null')+",now(),"+('now()' if status=='mirrored' else 'null')+');')
 for status in ['pending','retry','processing','applied','dead_letter']:
  sql("insert into migration.document_mutation_mirror_outbox(event_key,document_ids,documents,canonical_hash,status,lease_id,lease_expires_at,applied_at,dead_lettered_at) values("+q(str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-doc-'+status)))+"::uuid,array['fixture-audit'],'[{\"_id\":\"fixture-audit\",\"_type\":\"review\"}]',repeat('3',64),"+q(status)+','+("'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now()+interval '1 hour'" if status=='processing' else 'null,null')+','+('now()' if status=='applied' else 'null')+','+('now()' if status=='dead_letter' else 'null')+');')
 publish({'_id':'fixture-old-cms','_type':'review','title':'Legacy'},actor='sanity:editor')
 cases=['prepared','prepared-lost','auth-revocation','auth-source','mirror-pending','mirror-dead','mirror-failed','genuine','contradictory','mirrored','failed']
 for i,case in enumerate(cases,1):
  uid=str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-user-'+case));key='fixture-cred-'+case;password='$2b$12$'+('A'*53);docid='fixture-referral-'+case
  sql('insert into auth.users(id,email,encrypted_password) values('+q(uid)+'::uuid,'+q(case+'@example.test')+','+q(password if case not in ['prepared','genuine'] else '$2b$12$'+'B'*53)+');')
  rpc('roo_bootstrap_native_account',[q(uid)+'::uuid'])
  pid=value('select to_jsonb(principal_id) from accounts.principal_auth_users where user_id='+q(uid)+'::uuid;')
  if pid is None:raise AssertionError('principal missing')
  set_fields={'creatorPassword':password,'credentialVersion':2,'passwordLoginEnabled':True,'passwordResetRequired':False,'passwordChangedAt':'2026-01-01T00:00:00Z'}
  applied=case in ['mirror-pending','mirror-dead','mirror-failed','genuine','contradictory','mirrored','failed']
  doc={'_id':docid,'_type':'referral','_rev':'source-r1','slug':{'current':case},**(set_fields if applied else {'creatorPassword':'old','credentialVersion':1})}
  if case=='contradictory':doc['creatorPassword']='changed-after-checkpoint'
  sql('insert into migration.source_documents(legacy_sanity_id,document_type,source_revision,source_hash,payload,backend_owner) values('+q(docid)+",'referral','source-r1',repeat('4',64),"+j(doc)+",'sanity');")
  status='prepared' if case.startswith('prepared') else 'failed' if case in ['mirror-failed','failed'] else 'mirrored' if case=='mirrored' else 'auth_applied'
  error='CREDENTIAL_MIRROR_PENDING' if case in ['mirror-pending','mirror-failed','contradictory'] else 'CREDENTIAL_MIRROR_DEAD_LETTER' if case=='mirror-dead' else 'CREDENTIAL_SOURCE_PRECONDITION_FAILED' if case=='genuine' else None
  parked=case in ['mirror-pending','mirror-dead','mirror-failed','genuine','contradictory']
  sql('insert into accounts.credential_operations(operation_key,user_id,principal_id,password_hash,status,source_revision,source_backend,source_document_id,source_expected_revision,source_preconditions,source_mutation,source_applied_revision,source_applied_at,sessions_revoked_at,auth_applied_at,mirrored_at,attempt_count,source_recovery_blocked,source_recovery_blocked_at,next_retry_at,last_error_code,last_error_class) values('+','.join([q(key),q(uid)+'::uuid',q(pid)+'::uuid',q(password),q(status),"'source-r1'","'sanity'",q(docid),"'source-r1'",j({'creatorPassword':'old','credentialVersion':1}),j({'set':set_fields,'unset':['resetTokenHash']}),"'source-r1'" if applied else 'null','now()' if applied else 'null','null' if case in ['prepared','prepared-lost','auth-revocation'] else 'now()','null' if status=='prepared' else 'now()','now()' if status=='mirrored' else 'null','6' if parked else '0','true' if parked else 'false','now()' if parked else 'null',"now()+interval '1 hour'" if parked else 'null',q(error) if error else 'null',"'deterministic'" if case=='genuine' else "'transient'" if parked else 'null'])+');')
 for owner in ['sanity','supabase']:
  sql("insert into commerce.rate_limit_buckets(bucket_key_hmac,window_started_at,count,reset_at,backend_owner) values(repeat("+q('5' if owner=='sanity' else '6')+",64),now()-interval '1 hour',1,now()-interval '30 minutes',"+q(owner)+');')
 uid=value("select to_jsonb(user_id) from accounts.credential_operations where operation_key='fixture-cred-prepared';")
 for owner,domain in [('tourney_link','tourney'),('referral_link','referral'),('sanity','referral')]:
  sql('insert into accounts.identity_links(user_id,principal_id,provider,provider_subject,backend_owner,domain) select user_id,principal_id,'+q('google' if owner=='sanity' else 'discord')+','+q('fixture-social-'+owner)+','+q(owner)+','+q(domain)+" from accounts.credential_operations where operation_key='fixture-cred-prepared';")

def preservation(before,after):
 effects={'status','retired_at','retirement_reason','lease_id','lease_expires_at','next_attempt_at','last_error_code','updated_at'}
 rows=[]
 for table,old in before.items():
  new=after[table];lookup=lambda x:json.dumps(x,sort_keys=True)
  allowed=table in ['migration.commerce_mirror_outbox','migration.document_mutation_mirror_outbox']
  fields=set(old[0]) if old else set()
  if allowed:
   projected=[]
   for r in new:
    original=next(x for x in old if x['event_key']==r['event_key'])
    if original['status'] in ['pending','retry','processing']:
     assert r['status']=='retired' and r['retirement_reason']=='sanity_vendor_retired' and r['retired_at'] and r['lease_id'] is None and r['lease_expires_at'] is None and r['next_attempt_at'] is None
     projected.append({k:(original[k] if k in effects else r[k]) for k in fields})
    else:projected.append({k:r[k] for k in fields});assert r['retired_at'] is None and r['retirement_reason'] is None
  elif table=='storage.buckets':projected=[r for r in new if r['id']!='cms-upload-staging'];assert next(r for r in new if r['id']=='cms-upload-staging')['public'] is False
  else:projected=new
  valid=sorted(map(lookup,old))==sorted(map(lookup,projected));rows.append({'table':table,'beforeCount':len(old),'afterCount':len(new),'documentedEffectsOnly':valid});assert valid,table
 save('data-preservation.json',rows);check('all-column preservation with S2-only effects',all(r['documentedEffectsOnly'] for r in rows))

def run_release_cases():
 check('commerce old claim empty',rpc('roo_claim_commerce_mirror_events',["'old-lease'",'10','false']),[])
 check('document old claim empty',rpc('roo_claim_document_mutation_mirror_events',["'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid",'10','120']),[])
 for name,args in [('roo_complete_commerce_mirror_event',["'fixture-event-processing'","'old-lease'",'true']),('roo_requeue_commerce_mirror_event',["'fixture-event-processing'",'0',"'fixture retired reason'"])]:
  check(name+' does not resurrect',rpc(name,args)['status'],'retired')
 key=str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-doc-processing'))
 check('document stale completion retired',rpc('roo_complete_document_mutation_mirror_event',[q(key)+'::uuid',"'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid",'true'])['status'],'retired')
 check('document requeue retired',rpc('roo_requeue_document_mutation_mirror_event',[q(key)+'::uuid','0',"'fixture-actor'","'fixture retired reason'"])['status'],'retired')
 old=source_payload('fixture-old-cms');r1=old['_rev'];r2=publish({**old,'title':'Editor two'},'replace',revision=r1)['results'][0]['_rev'];snap=snapshot_rows()
 refused('r1 stale replace',"select public.roo_apply_cms_publish_command('cms:"+'a'*64+"','"+'a'*64+"','admin:key',"+j([{'operation':'replace','document':{**old,'title':'Stale'},'expected_revision':r1}])+');','CMS_REVISION_CONFLICT')
 check('stale leaves all content/history unchanged',snapshot_rows(),snap)
 refused('missing revision delete',"select public.roo_apply_cms_publish_command('cms:"+'b'*64+"','"+'b'*64+"','admin:key',"+j([{'operation':'delete','id':old['_id']}])+');','CMS_REVISION_CONFLICT')
 r=publish(None,'delete',old['_id'],r2);check('delete returns committed revision',r['results'][0]['_rev'],r2)
 check('delete archived prior content',rpc('roo_cms_document_revisions',[q(old['_id']),'50'])[0]['operation'],'delete')
 package={'_id':'fixture-package','_type':'package','title':'Performance Vertex Max','price':'$12.34'}
 p=publish(package);check('raw Studio dollar price unchanged',source_payload(package['_id'])['price'],'$12.34')
 for alias in ['XOC','XOC / Extreme Overclocking','performance vertex max (upgrade)']:
  d={**package,'_id':'fixture-alias-'+str(uuid.uuid5(uuid.NAMESPACE_DNS,alias)),'title':alias}
  h=hashlib.sha256(alias.encode()).hexdigest();refused('alias '+alias,'select public.roo_apply_cms_publish_command('+','.join([q('cms:'+h),q(h),"'admin:key'",j([{'operation':'create','document':d}])])+');','CMS_PACKAGE_TITLE_CONFLICT')
 for price in ['0','-1','0.004','abc','$NaN','1e2']:
  check('unusable-price '+price,value('select to_jsonb(migration.cms_usable_price('+q(price)+'));'),False)
 for price in ['$12.34','€1,234.56','£.005','₹+1.','0.005']:
  check('usable-price '+price,value('select to_jsonb(migration.cms_usable_price('+q(price)+'));'),True)
 d={'_id':'fixture-slug-conflict','_type':'coupon','title':'Coupon','code':'PREPARED','isActive':True};h='c'*64
 refused('referral.slug.current coupon namespace','select public.roo_apply_cms_publish_command('+','.join([q('cms:'+h),q(h),"'admin:key'",j([{'operation':'create','document':d}])])+');','CMS_CODE_CONFLICT')
 h='d'*64;d={'_id':'fixture-unverified','_type':'review','image':{'asset':{'_ref':'image-'+'e'*40+'-1x1-png'}}}
 refused('unverified nested asset with omitted links','select public.roo_apply_cms_publish_command('+','.join([q('cms:'+h),q(h),"'admin:key'",j([{'operation':'create','document':d}])])+');','CMS_ASSET_UNVERIFIED')
 recovered=rpc('roo_fetch_recovery_payment_documents',["'supabase'","array['needs_recovery']","'refunded'","'booked'","'abandoned'",'now()','100','true'])
 check('recovery includes all storage owners',sorted(x['_id'] for x in recovered),['fixture-paymentRecord-missing','fixture-paymentRecord-sanity','fixture-paymentRecord-supabase'])
 cleanup=rpc('roo_cleanup_expired_supabase_holds',['1','100']);check('cleanup imports current-generation holds',cleanup['expired_holds'],2);check('cleanup enqueued count zero',cleanup['mirror_events_enqueued'],0)
 check('stale-generation hold unchanged',source_payload('fixture-slotHold-missing')['phase'],'active')
 check('sanity expired hold projection/source agree',value("select to_jsonb(phase) from commerce.slot_holds where legacy_sanity_id='fixture-slotHold-sanity';"),'expired')
 check('rate cleanup includes imported bucket',rpc('roo_cleanup_commerce_rate_limits',['now()']),2)
 links=value("select jsonb_agg(to_jsonb(l) order by id) from accounts.identity_links l where provider_subject like 'fixture-social-%';")
 uid=value("select to_jsonb(user_id) from accounts.credential_operations where operation_key='fixture-cred-prepared';")
 rpc('roo_reconcile_auth_identity_links',[q(uid)+'::uuid',"'referral'"]);rpc('roo_reconcile_auth_identity_links',[q(uid)+'::uuid',"'tourney'"])
 check('cross-domain and sanity provenance unchanged',value("select jsonb_agg(to_jsonb(l) order by id) from accounts.identity_links l where provider_subject like 'fixture-social-%';"),links)
 get_first=rpc('roo_get_credential_operation_v2',["'fixture-cred-mirror-pending'"]);check('request get makes matching mirror-only operation eligible',not get_first['source_recovery_blocked'] and get_first['attempt_count']==0 and get_first['source_backend']=='supabase')
 check('get normalized routing preserves stored legacy backend',value("select to_jsonb(source_backend) from accounts.credential_operations where operation_key='fixture-cred-mirror-pending';"),'sanity')
 for case in ['mirror-pending','mirror-dead','mirror-failed']:
  result=rpc('roo_complete_credential_operation_v2',[q('fixture-cred-'+case)]);check('mirror-only '+case+' completes',result['status'],'mirrored')
 genuine=value("select to_jsonb(o) from accounts.credential_operations o where operation_key='fixture-cred-genuine';")
 contradiction=value("select to_jsonb(o) from accounts.credential_operations o where operation_key='fixture-cred-contradictory';")
 check('contradictory mirror checkpoint remains parked',rpc('roo_complete_credential_operation_v2',["'fixture-cred-contradictory'"])['status'],'parked')
 listed=rpc('roo_list_credential_recovery_v2',['25']);check('cron exposes legacy operations with native routing',all(row['source_backend']=='supabase' for row in listed if row['source_backend'] in ['sanity','supabase']))
 check('genuine error unchanged',value("select to_jsonb(o) from accounts.credential_operations o where operation_key='fixture-cred-genuine';"),genuine)
 check('contradictory source unchanged',value("select to_jsonb(o) from accounts.credential_operations o where operation_key='fixture-cred-contradictory';"),contradiction)
 check('prepared lost Auth response checkpointed',value("select to_jsonb(status='auth_applied' and sessions_revoked_at is not null) from accounts.credential_operations where operation_key='fixture-cred-prepared-lost';"))
 check('legacy mirrored remains terminal',rpc('roo_complete_credential_operation_v2',["'fixture-cred-mirrored'"])['idempotent'])
 check('no newly queued outbox work',value("select to_jsonb((select count(*) from migration.commerce_mirror_outbox where status in ('pending','retry','processing'))+(select count(*) from migration.document_mutation_mirror_outbox where status in ('pending','retry','processing')));"),0)

def sql_publish(m,tag,actor='admin:key'):
 h=hashlib.sha256(tag.encode()).hexdigest();return 'select public.roo_apply_cms_publish_command('+','.join([q('cms:'+h),q(h),q(actor),j([m])])+');'
def concurrent_order(name,first,second,second_error=None):
 started=time.monotonic()
 owner=subprocess.Popen([str(BIN/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(RUN),'-p',PORT,'-U','serviroo','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV)
 body="set application_name="+q(name)+";begin;"+first+"select pg_sleep(0.6);commit;"
 owner.stdin.write(body);owner.stdin.close()
 for _ in range(100):
  waiting=value("select to_jsonb(exists(select 1 from pg_stat_activity where application_name="+q(name)+" and wait_event='PgSleep'));")
  if waiting:break
  if owner.poll() is not None:raise AssertionError(owner.stderr.read())
  time.sleep(.01)
 else:raise AssertionError('first transaction barrier unavailable')
 result=sql(second,False);owner.wait(timeout=10);error=owner.stderr.read();assert owner.returncode==0,error
 valid=(result.returncode==0 if second_error is None else result.returncode!=0 and second_error in result.stderr) and 'deadlock detected' not in result.stderr and '40P01' not in result.stderr
 report.setdefault('concurrency',[]).append({'name':name,'ownerExit':owner.returncode,'secondExit':result.returncode,'secondError':result.stderr.strip(),'elapsedSeconds':time.monotonic()-started})
 check(name+' real-session ordering',valid)

def prove_lock_order(inventory,before):
 functions={row['signature']:row for row in inventory['functions']}
 roots={'public.roo_apply_document_mutations','migration.roo_apply_commerce_document_mutations_unbounded','migration.apply_cms_commerce_mutation'}
 def qualified(signature):
  name=signature.split('(')[0];return name if '.' in name else 'public.'+name
 names={qualified(key):key for key in functions};closure=set(roots);edges={}
 while True:
  added=set()
  for name,key in names.items():
   body=functions[key]['definition'].split('AS $function$',1)[-1]
   calls=[target for target in closure if re.search(r'(?<![\w.])(?:'+re.escape(target.split('.')[0])+r'\.)?'+re.escape(target.split('.')[-1])+r'\s*\(',body,re.I)]
   if calls and name not in roots:edges[name]=sorted(calls);added.add(name)
  if added<=closure:break
  closure|=added
 statement=r'perform\s+(?:pg_catalog\.)?pg_advisory_xact_lock\s*\(\s*(?:pg_catalog\.)?hashtextextended\s*\(\s*\'cms-reference-integrity\',\s*0\)\);'
 callers=[]
 for name in sorted(closure):
  definition=functions[names[name]]['definition'];body=definition.split('AS $function$',1)[-1];outer=re.search(r'\bbegin\b',body,re.I).end();tail=body[outer:]
  match=re.search(statement,tail,re.I)
  check('caller takes common lock as first outer statement '+name,match is not None and not tail[:match.start()].strip())
  check('one common lock statement '+name,len(re.findall(statement,body,re.I)),1)
  callers.append({'function':name,'signature':names[name],'calls':edges.get(name,[]),'firstStatementCommonLock':True,'oneCommonLock':True})
 for original in before['functions']:
  name=qualified(original['signature'])
  if name not in roots:continue
  expected=re.sub(r'insert\s+into\s+migration\.(?:commerce_mirror_outbox|document_mutation_mirror_outbox)[\s\S]*?;','',original['definition'],count=1,flags=re.I)
  actual=re.sub(statement,'',functions[names[name]]['definition'],flags=re.I)
  check('hot writer only removed outbox insert and added one outer lock '+name,re.sub(r'\s+',' ',actual).strip(),re.sub(r'\s+',' ',expected).strip())
 save('writer-lock-order-proof.json',{'scannedFunctions':len(functions),'roots':sorted(roots),'callers':callers,'comparison':'Definitions equal after removing exactly the outbox INSERT and one lock statement, ignoring whitespace only.'})

def run_lock_order_cases():
 for order in ['cleanup-first','mutation-first']:
  id='fixture-lock-hold-'+order
  create_doc({'_id':id,'_type':'slotHold','phase':'active','packageTitle':'Lock fixture','startTimeUTC':'2099-12-'+('01' if order=='cleanup-first' else '02')+'T10:00:00Z','expiresAt':'2020-01-01T00:00:00Z','holdNonce':'lock-old','cutoverGeneration':1})
  current=source_payload(id)
  changed={**current,'expiresAt':'2099-11-01T00:00:00Z','holdNonce':'lock-new'}
  mutation="select public.roo_apply_commerce_document_mutations("+q('fixture-lock-'+order)+','+j([{'operation':'replace','expected_revision':current['_rev'],'document':changed}])+",1);"
  cleanup="select public.roo_cleanup_expired_supabase_holds(1,100);"
  concurrent_order('cleanup-mutation-lock-order-'+order,cleanup if order=='cleanup-first' else mutation,mutation if order=='cleanup-first' else cleanup,'revision' if order=='cleanup-first' else None)
  saved=source_payload(id)
  check('cleanup/mutation deterministic source '+order,saved['phase'],'expired' if order=='cleanup-first' else 'active')
  check('cleanup/mutation no lost nonce '+order,saved['holdNonce']=='lock-new',order=='mutation-first')
 coupon={'_id':'fixture-coupon-booking-lock','_type':'coupon','code':'LOCKBOOK','title':'Lock coupon','isActive':True};publish(coupon)
 current=source_payload(coupon['_id'])
 batch=[{'operation':'replace','expected_revision':current['_rev'],'document':{**current,'timesUsed':1}},{'operation':'create','document':{'_id':'fixture-lock-redemption','_type':'couponRedemption','coupon':{'_type':'reference','_ref':coupon['_id']},'code':'LOCKBOOK','status':'consumed'}},{'operation':'create','document':{'_id':'fixture-lock-booking','_type':'booking','status':'captured','packageTitle':'Lock fixture','startTimeUTC':'2099-12-03T10:00:00Z','netAmount':9.99,'currency':'USD'}},{'operation':'create','document':{'_id':'fixture-lock-payment','_type':'paymentRecord','provider':'paypal','status':'booked','providerOrderId':'fixture-lock-order','bookingId':'fixture-lock-booking','netAmount':9.99,'currency':'USD'}}]
 mutation="select public.roo_apply_commerce_document_mutations('fixture-coupon-booking-batch',"+j(batch)+",1);"
 deletion=sql_publish({'operation':'delete','id':coupon['_id'],'expected_revision':current['_rev']},'fixture-coupon-booking-delete')
 concurrent_order('coupon-booking-batch-before-admin-delete',mutation,deletion,'CMS_REVISION_CONFLICT')
 check('coupon booking batch retained atomically',all(source_payload(item['document']['_id'])['_id']==item['document']['_id'] for item in batch))
 check('referenced coupon retained',source_payload(coupon['_id'])['_id'],coupon['_id'])
 second={**coupon,'_id':'fixture-coupon-delete-lock','code':'LOCKDELETE'};publish(second)
 current=source_payload(second['_id']);reverse_batch=[{'operation':'replace','expected_revision':current['_rev'],'document':{**current,'timesUsed':1}}]+[{**item,'document':{**item['document'],'_id':item['document']['_id']+'-reverse',**({'coupon':{'_type':'reference','_ref':second['_id']}} if item['document']['_type']=='couponRedemption' else {})}} for item in batch[1:]]
 deletion=sql_publish({'operation':'delete','id':second['_id'],'expected_revision':current['_rev']},'fixture-coupon-delete-before-booking')
 mutation="select public.roo_apply_commerce_document_mutations('fixture-coupon-booking-reverse',"+j(reverse_batch)+",1);"
 concurrent_order('admin-coupon-delete-before-booking-batch',deletion,mutation,'document not found')
 check('deleted coupon booking batch grants no documents',all(source(item['document']['_id']) is None for item in reverse_batch[1:]))


def run_concurrent_cases():
 refused('Studio delete missing target cannot bypass type allowlist',sql_publish({'operation':'delete','id':'fixture-missing-type'},'fixture-null-type',actor='sanity:editor'),'unsupported CMS document type')
 coupon={'_id':'fixture-coupon','_type':'coupon','title':'Coupon','code':'SQLTEST','isActive':True,'maxUses':10}
 publish(coupon);loaded=source_payload(coupon['_id']);r1=loaded['_rev']
 redeemed={**loaded,'timesUsed':1,'activeReservations':2,'redemptionCount':3,'autoDeactivatedByRedemptionId':'redemption-one','autoDeactivatedAt':'2026-01-01T00:00:00Z','isActive':False}
 a="select public.roo_apply_commerce_document_mutations('fixture-coupon-redemption-a',"+j([{'operation':'replace','document':redeemed,'expected_revision':r1}])+",1);"
 b=sql_publish({'operation':'replace','document':{**loaded,'title':'stale editor','timesUsed':0},'expected_revision':r1},'coupon-stale-concurrent')
 concurrent_order('coupon-redemption-then-publish',a,b,'CMS_REVISION_CONFLICT');check('coupon exact counters after stale editor',{k:source_payload(coupon['_id']).get(k) for k in ['timesUsed','activeReservations','redemptionCount','autoDeactivatedByRedemptionId','isActive']},{'timesUsed':1,'activeReservations':2,'redemptionCount':3,'autoDeactivatedByRedemptionId':'redemption-one','isActive':False})
 loaded=source_payload(coupon['_id']);m={'operation':'replace','document':{**loaded,'title':'Fresh editor','timesUsed':0,'isActive':True},'expected_revision':loaded['_rev']}
 a=sql_publish(m,'coupon-publish-first')
 b="begin;select pg_advisory_xact_lock(hashtextextended('cms-reference-integrity',0));select public.roo_apply_commerce_document_mutations('fixture-coupon-redemption-b',jsonb_build_array(jsonb_build_object('operation','replace','expected_revision',source_revision,'document',payload||jsonb_build_object('timesUsed',2,'redemptionCount',4))),1) from migration.source_documents where legacy_sanity_id='fixture-coupon';commit;"
 concurrent_order('coupon-publish-then-redemption',a,b);saved=source_payload(coupon['_id']);check('coupon fresh publish preserves locked counters and activation',{k:saved.get(k) for k in ['title','timesUsed','activeReservations','redemptionCount','isActive']},{'title':'Fresh editor','timesUsed':2,'activeReservations':2,'redemptionCount':4,'isActive':False})
 replay=value(a);check('coupon receipt replay does not restore counters',replay['replayed']);check('redemption survives replay',source_payload(coupon['_id'])['timesUsed'],2)
 a=sql_publish({'operation':'create','document':{'_id':'fixture-contact-a','_type':'contact','title':'A'}},'singleton-a');b=sql_publish({'operation':'create','document':{'_id':'fixture-contact-b','_type':'contact','title':'B'}},'singleton-b');concurrent_order('concurrent-singleton-create',a,b,'CMS_SINGLETON_EXISTS')
 target={'_id':'fixture-reference-target','_type':'package','title':'Reference target','price':'$3.00'};publish(target);r=source_payload(target['_id'])['_rev']
 link={'_id':'fixture-reference-link','_type':'upgradeLink','title':'Upgrade','slug':{'current':'fixture-reference-link'},'targetPackage':{'_type':'reference','_ref':target['_id']}}
 a=sql_publish({'operation':'create','document':link},'reference-create-first');b=sql_publish({'operation':'delete','id':target['_id'],'expected_revision':r},'reference-delete-second');concurrent_order('reference-create-target-delete',a,b,'CMS_REFERENCED')
 r=source_payload(link['_id'])['_rev'];publish(None,'delete',link['_id'],r)
 r=source_payload(target['_id'])['_rev'];a=sql_publish({'operation':'delete','id':target['_id'],'expected_revision':r},'reference-delete-first');b=sql_publish({'operation':'create','document':{**link,'_id':'fixture-reference-after-delete'}},'reference-create-second');concurrent_order('target-delete-reference-create',a,b,'CMS_REFERENCE_INVALID')
 coupon=source_payload('fixture-coupon');create_doc({'_id':'fixture-operational-redemption','_type':'couponRedemption','coupon':{'_ref':'fixture-coupon','_type':'reference'},'status':'released','code':'SQLTEST'})
 refused('operational couponRedemption inbound prevents deletion',sql_publish({'operation':'delete','id':'fixture-coupon','expected_revision':coupon['_rev']},'operational-inbound'),'CMS_REFERENCED')
 settings={'_id':'6d8a3646-0ed2-44b5-ad45-c5c9d578126a','_type':'bookingSettings','packageDateSlots':[{'package':{'_ref':'fixture-package','_type':'reference'},'date':'2099-01-01','times':['10:00']}],'ownerEmail':'owner@example.test'}
 publish(settings);check('canonical booking settings projection exists',value("select to_jsonb(count(*)=1) from commerce.booking_settings where legacy_sanity_id='6d8a3646-0ed2-44b5-ad45-c5c9d578126a';"))
 refused('admin cannot delete fixed booking settings',sql_publish({'operation':'delete','id':settings['_id'],'expected_revision':source_payload(settings['_id'])['_rev']},'singleton-delete'),'CMS_SINGLETON_REQUIRED')
 refused('admin cannot create alternate booking settings',sql_publish({'operation':'create','document':{**settings,'_id':'fixture-wrong-booking-settings'}},'singleton-alternate'),'CMS_SINGLETON_IDENTITY')

def create_intent_cases():
 doc={'_id':'fixture-create-intent-history','_type':'review','title':'Original intent'}
 original=sql_publish({'operation':'create','document':doc},'fixture-create-intent-original')
 first=value(original);revision=first['results'][0]['_rev']
 publish(None,'delete',doc['_id'],revision)
 refused('deleted create intent cannot change content',sql_publish({'operation':'create','document':{**doc,'title':'Changed intent'}},'fixture-create-intent-changed'),'CMS_CREATE_INTENT_CONFLICT')
 check('original create receipt survives deletion',value(original)['results'],first['results'])
 check('changed create does not resurrect content',value("select to_jsonb(count(*)=0) from migration.source_documents where legacy_sanity_id='fixture-create-intent-history';"))
 for title in ['XOC\t','\tXOC', '\u00a0XOC\u00a0','XOC / Extreme Overclocking (upgrade)\t','XOC\u00a0/\u00a0Extreme Overclocking']:
  refused('package alias whitespace '+repr(title),sql_publish({'operation':'create','document':{'_id':'fixture-space-'+hashlib.sha256(title.encode()).hexdigest()[:12],'_type':'package','title':title,'price':'$12.34'}},'fixture-space-'+title),'CMS_PACKAGE_TITLE_CONFLICT')
 for upper,lower in [('Ä Package','ä package'),('ΟΣ Package','ος package'),('İ Package','i\u0307 package')]:
  publish({'_id':'fixture-unicode-'+hashlib.sha256(upper.encode()).hexdigest()[:12],'_type':'package','title':upper,'price':'$12.34'})
  refused('generic package namespace Unicode '+repr(upper),sql_publish({'operation':'create','document':{'_id':'fixture-unicode-'+hashlib.sha256(lower.encode()).hexdigest()[:12],'_type':'package','title':lower,'price':'$12.34'}},'fixture-unicode-'+lower),'CMS_PACKAGE_TITLE_CONFLICT')
 refused('Studio package alias cannot bypass namespace',sql_publish({'operation':'create','document':{'_id':'fixture-studio-duplicate','_type':'package','title':'XOC','price':'$12.34'}},'fixture-studio-duplicate',actor='sanity:editor'),'CMS_PACKAGE_TITLE_CONFLICT')
 check('price whitespace follows app parser',value("select to_jsonb(migration.cms_usable_price(E'\\t$12.34\\t'));"))
 check('price NBSP follows app parser',value("select to_jsonb(migration.cms_usable_price(U&'\\00A0$12.34\\00A0'));"))

def shape(v):
 if isinstance(v,dict):return {k:shape(x) for k,x in sorted(v.items())}
 if isinstance(v,list):return [shape(x) for x in v]
 return 'null' if v is None else 'boolean' if isinstance(v,bool) else 'number' if isinstance(v,(int,float)) else 'string'
def hot_paths():
 docs=[{'_id':'hot-hold','_type':'slotHold','phase':'active','packageTitle':'Hot fixture','startTimeUTC':'2099-06-01T00:00:00Z','expiresAt':'2099-05-01T00:00:00Z','holdNonce':'hot-hold-nonce'}, {'_id':'hot-booking','_type':'booking','status':'captured','packageTitle':'Hot fixture','startTimeUTC':'2099-06-02T00:00:00Z','netAmount':9.99,'currency':'USD'}, {'_id':'hot-payment','_type':'paymentRecord','provider':'paypal','status':'order_created','providerOrderId':'hot-order','netAmount':9.99,'currency':'USD','pricingSnapshot':{'netAmount':9.99,'currency':'USD'}}]
 statements=['begin;']
 for i,doc in enumerate(docs):statements.append("select public.roo_apply_commerce_document_mutations("+q('hot-native-'+str(i))+','+j([{'operation':'create','document':doc}])+',1);')
 statements.append("select public.roo_apply_commerce_document_mutations('hot-native-release',jsonb_build_array(jsonb_build_object('operation','replace','document',payload||jsonb_build_object('phase','released'),'expected_revision',source_revision)),1) from migration.source_documents where legacy_sanity_id='hot-hold';")
 statements.append("select public.roo_apply_commerce_document_mutations('hot-native-referral',jsonb_build_array(jsonb_build_object('operation','replace','document',payload||jsonb_build_object('split',10),'expected_revision',source_revision)),1) from migration.source_documents where legacy_sanity_id='fixture-referral-prepared';")
 statements.append("select public.roo_consume_rate_limit(repeat('9',64),now(),now()+interval '1 hour',3);")
 statements.append("select public.roo_apply_document_mutations("+j([{'operation':'create','document':{'_id':'hot-general','_type':'review','title':'Hot'}}])+');')
 h='f'*64;statements.append('select public.roo_apply_cms_publish_command('+','.join([q('cms:'+h),q(h),"'sanity:hot-editor'",j([{'operation':'create','document':{'_id':'hot-cms','_type':'review','title':'Old Studio'}}])])+');')
 statements.append('rollback;');raw=sql('\n'.join(statements)).stdout
 return [json.loads(line) for line in raw.splitlines() if line.strip()]

def extra_credential_cases():
 row=value("select to_jsonb(o) from accounts.credential_operations o where operation_key='fixture-cred-auth-source';")
 result=rpc('roo_prepare_credential_operation_v2',[q(row['operation_key']),q(row['user_id'])+'::uuid',q(row['password_hash']),"'supabase'",q(row['source_document_id']),q(row['source_expected_revision']),j(row['source_preconditions']),j(row['source_mutation'])]);check('legacy prepare identity normalizes without reapplying Auth',result['idempotent'])
 auth=value('select to_jsonb(u) from auth.users u where id='+q(row['user_id'])+'::uuid;')
 result=rpc('roo_apply_credential_source_operation_v2',[q(row['operation_key'])]);check('legacy sanity source applies authoritative local document',result['status'],'source_applied')
 check('source credential mutation matches stored operation',all(source_payload(row['source_document_id']).get(k)==v for k,v in row['source_mutation']['set'].items()))
 check('Auth unchanged by source application',value('select to_jsonb(u) from auth.users u where id='+q(row['user_id'])+'::uuid;'),auth)
 check('source application replay returns identical revision',rpc('roo_apply_credential_source_operation_v2',[q(row['operation_key'])])['source_revision'],result['source_revision'])
 check('source checkpoint completion',rpc('roo_complete_credential_operation_v2',[q(row['operation_key'])])['status'],'mirrored')
 row=value("select to_jsonb(o) from accounts.credential_operations o where operation_key='fixture-cred-auth-revocation';")
 rpc('roo_mark_credential_operation_v2',[q(row['operation_key']),"'auth_applied'",'null'])
 sql('update migration.source_documents set payload=jsonb_set(payload,\'{creatorPassword}\',\'"changed-precondition"\') where legacy_sanity_id='+q(row['source_document_id'])+';')
 unchanged=source(row['source_document_id']);failure=rpc('roo_apply_credential_source_operation_v2',[q(row['operation_key'])]);check('exact genuine precondition failure retained',failure['error_code'],'CREDENTIAL_SOURCE_PRECONDITION_CHANGED')
 for _ in range(3):
  sql('update accounts.credential_operations set next_retry_at=null where operation_key='+q(row['operation_key'])+';');failure=rpc('roo_apply_credential_source_operation_v2',[q(row['operation_key'])])
 check('genuine precondition failure bounded and parked',failure['parked']);check('wrong source credential never written',source(row['source_document_id']),unchanged)
 check('genuine precondition remains visible in ops',value('select to_jsonb(count(*)>0) from ops.credential_failures where "operationKey"='+q(row['operation_key'])+';'))

def capture_catalog_diff(before,after):
 changes=[]
 for kind,key in [('functions','signature'),('tables','table')]:
  old={r[key]:r for r in before[kind]};new={r[key]:r for r in after[kind]}
  for id in sorted(set(old)|set(new)):
   if old.get(id)!=new.get(id):changes.append({'kind':kind,'id':id,'fields':[f for f in sorted(set(old.get(id,{}) )|set(new.get(id,{}))) if old.get(id,{}).get(f)!=new.get(id,{}).get(f)]})
 save('catalog-diff.json',changes)
 old={r['signature']:r for r in before['functions']};new={r['signature']:r for r in after['functions']}
 check('no pre-existing function dropped',set(old)<=set(new))
 check('all existing function ACLs and owners preserved',all((r['acl'],r['owner'],r['config'])==(new[k]['acl'],new[k]['owner'],new[k]['config']) for k,r in old.items()))
 old_tables={r['table']:r for r in before['tables']};new_tables={r['table']:r for r in after['tables']}
 check('no pre-existing table dropped',set(old_tables)<=set(new_tables))
 check('all existing table ACLs preserved',all(r['acl']==new_tables[k]['acl'] for k,r in old_tables.items()))
 allowed_functions={'refresh_creator_fallback_authority','refresh_creator_fallback_authority_trigger','terminalize_stale_provider_recoveries','roo_admin_update_creator_terms','roo_apply_commerce_document_mutations','roo_apply_credential_source_operation','roo_enqueue_referral_email_mutation','roo_apply_document_mutations','roo_apply_commerce_document_mutations_unbounded','apply_cms_commerce_mutation','roo_claim_commerce_mirror_events','roo_claim_document_mutation_mirror_events','roo_complete_commerce_mirror_event','roo_complete_document_mutation_mirror_event','roo_requeue_commerce_mirror_event','roo_requeue_document_mutation_mirror_event','roo_supersede_commerce_mirror_event','roo_commerce_mirror_backlog','roo_document_mutation_mirror_backlog','roo_commerce_mirror_status_for_ids','roo_document_mutation_mirror_status_for_ids','roo_fetch_recovery_payment_documents','roo_cleanup_expired_supabase_holds','roo_cleanup_commerce_rate_limits','roo_cms_publish_command_result','roo_apply_cms_publish_command','roo_prepare_credential_operation_v2','roo_apply_credential_source_operation_v2','roo_complete_credential_operation_v2','roo_get_credential_operation_v2','roo_list_credential_recovery_v2','roo_commerce_readiness','roo_commerce_integrity_readiness','roo_supabase_port_readiness','roo_cms_publish_readiness'}
 check('only intended pre-existing functions changed',all(id.split('(')[0].split('.')[-1] in allowed_functions for id,r in old.items() if r!=new[id]))
 allowed_tables={'migration.commerce_mirror_outbox','migration.document_mutation_mirror_outbox','migration.cms_publish_commands','accounts.principals','accounts.creator_profiles','accounts.account_roles'}
 for id,r in old_tables.items():
  if r!=new_tables[id] and id not in allowed_tables:
   different=[f for f in r if r[f]!=new_tables[id][f]]
   assert different==['columns'],(id,different)
   for a,b in zip(r['columns'],new_tables[id]['columns']):
    if a!=b:assert a['name'] in ['source_backend','backend_owner'] and a['default']=="'sanity'::text" and b['default']=="'supabase'::text" and {k:v for k,v in a.items() if k!='default'}=={k:v for k,v in b.items() if k!='default'},(id,a,b)
 check('only intended table changes and routing defaults',True)


def rollback_release(before,after):
 old_functions={r['signature']:r for r in before['functions']};new_functions={r['signature']:r for r in after['functions']}
 old_tables={r['table']:r for r in before['tables']};new_tables={r['table']:r for r in after['tables']}
 def object_order(identifier):
  qualified,_,arguments=identifier.partition('(')
  schema,_,name=qualified.rpartition('.')
  return (schema or 'public',name,arguments)
 release=ROOT/'supabase/release/sanity-removal';release.mkdir(parents=True,exist_ok=True)
 body=['begin;',"set local lock_timeout='5s';set local statement_timeout='120s';","create schema if not exists sanity_rollback_archive;"]
 for id in sorted(old_functions,key=object_order):
  r=old_functions[id]
  if r!=new_functions[id]:body.append(r['definition'].rstrip().rstrip(';')+';')
 body.append("create table sanity_rollback_archive.retired_outbox_rows as select 'commerce_mirror_outbox' outbox,to_jsonb(o) document from migration.commerce_mirror_outbox o where retired_at is not null union all select 'document_mutation_mirror_outbox',to_jsonb(o) from migration.document_mutation_mirror_outbox o where retired_at is not null;")
 body.append("create table sanity_rollback_archive.admin_publish_commands as select * from migration.cms_publish_commands where actor like 'admin:%'; delete from migration.cms_publish_commands where actor like 'admin:%';")
 for table in sorted(['commerce_mirror_outbox','document_mutation_mirror_outbox']):
  fields=['status','next_attempt_at','lease_id','lease_expires_at','last_error_code']+(['updated_at'] if table=='document_mutation_mirror_outbox' else [])
  assigns=','.join(f+'=original.'+f for f in fields)
  body.append('update migration.'+table+' current set '+assigns+' from migration.sanity_outbox_retirement archive cross join lateral jsonb_populate_record(null::migration.'+table+',archive.previous_state) original where archive.outbox='+q(table)+' and current.event_key::text=archive.event_key and current.status=\'retired\';')
 for id in sorted(old_tables,key=object_order):
  r=old_tables[id]
  after_table=new_tables[id]
  cons_before={x['name']:x['def'] for x in r['constraints'] or []};cons_after={x['name']:x['def'] for x in after_table['constraints'] or []}
  for name,definition in sorted(cons_before.items()):
   if cons_after.get(name)!=definition:body.extend(['alter table '+id+' drop constraint '+name+';','alter table '+id+' add constraint '+name+' '+definition+';'])
  cols_before={x['name']:x for x in r['columns']};cols_after={x['name']:x for x in after_table['columns']}
  old_column_order={col['name']:index for index,col in enumerate(r['columns'])}
  new_column_order={col['name']:index for index,col in enumerate(after_table['columns'])}
  for name in sorted(cols_before,key=lambda name:(old_column_order[name],name)):
   col=cols_before[name]
   new=cols_after[name]
   if col['default']!=new['default']:body.append('alter table '+id+' alter column '+name+(' set default '+col['default'] if col['default'] is not None else ' drop default')+';')
   if col['notnull']!=new['notnull']:body.append('alter table '+id+' alter column '+name+(' set not null' if col['notnull'] else ' drop not null')+';')
  for name in sorted(set(cols_after)-set(cols_before),key=lambda name:(new_column_order[name],name)):body.append('alter table '+id+' drop column '+name+';')
  old_triggers={x['name']:x['def'] for x in r['triggers'] or []};new_triggers={x['name']:x['def'] for x in after_table['triggers'] or []}
  for name in sorted(set(new_triggers)-set(old_triggers)):body.append('drop trigger '+name+' on '+id+';')
  for name,definition in sorted(old_triggers.items()):
   if new_triggers.get(name)!=definition:body.append(definition+';')
 new_signatures=sorted(set(new_functions)-set(old_functions),key=object_order)
 for id in new_signatures:
  if not id.startswith('migration.'):body.append('drop function '+id+';')
 for id in new_signatures:
  if id.startswith('migration.'):body.append('drop function '+id+';')
 for id in sorted(set(new_tables)-set(old_tables),key=object_order):body.append('alter table '+id+' set schema sanity_rollback_archive;')
 body.append('commit;');rollback='\n'.join(body)+'\n';(release/'rollback-captured-local.sql').write_text(rollback)
 revisions=value('select to_jsonb(count(*)) from cms.document_revisions;');uploads=value('select to_jsonb(count(*)) from cms.uploads;');content=source_payload('fixture-package')
 apply(rollback)
 restored=catalog();save('catalog-rollback.json',restored)
 check('rollback returns exact pre-migration application catalog',restored,before)
 check('rollback preserves new revisions in archive',value('select to_jsonb(count(*)) from sanity_rollback_archive.document_revisions;'),revisions)
 check('rollback preserves upload records in archive',value('select to_jsonb(count(*)) from sanity_rollback_archive.uploads;'),uploads)
 check('rollback preserves intervening published content',source_payload('fixture-package'),content)
 check('rollback archives retirement evidence',value('select to_jsonb(count(*)>0) from sanity_rollback_archive.retired_outbox_rows;'))
 report['rollback']={'path':str(release/'rollback-captured-local.sql'),'archivedRevisions':revisions,'archivedUploads':uploads,'interveningContentPreserved':True,'applicationCatalogExact':True,'archiveSchemaRetained':True,'stagingBucketRetained':True}

def upload_sql_cases():
 sha1='1'*40;sha256='2'*64;id='image-'+sha1+'-1x1-png';url='http://127.0.0.1:65534/storage/v1/object/public/site-content-public/images/'+sha1+'.png'
 asset={'legacy_sanity_asset_id':id,'source_url':url,'storage_bucket':'site-content-public','storage_path':'images/'+sha1+'.png','mime_type':'image/png','byte_size':68,'sha256':sha256,'width':1,'height':1}
 doc={'_id':id,'_type':'sanity.imageAsset','sha1hash':sha1,'size':68,'mimeType':'image/png','extension':'png','url':url,'metadata':{'dimensions':{'width':1,'height':1}}}
 registered=rpc('roo_register_verified_cms_asset',[j(asset),j(doc)]);check('server measured asset registered',registered['verified']);check('asset creates compatible local source document',source_payload(id)['_type'],'sanity.imageAsset')
 check('identical registered asset replay',rpc('roo_register_verified_cms_asset',[j(asset),j(doc)])['replayed'])
 before=value('select to_jsonb(a) from cms.assets a where legacy_sanity_asset_id='+q(id)+';')
 refused('same SHA1 identity differing SHA256 refuses','select public.roo_register_verified_cms_asset('+j({**asset,'sha256':'3'*64})+','+j(doc)+');','CMS_ASSET_COLLISION')
 check('collision keeps manifest unchanged',value('select to_jsonb(a) from cms.assets a where legacy_sanity_asset_id='+q(id)+';'),before)
 review={'_id':'fixture-verified-review','_type':'review','image':{'asset':{'_ref':id}}};publish(review)
 check('SQL derives omitted image link',value("select to_jsonb(count(*)=1) from cms.document_assets l join cms.documents d on d.id=l.document_id where d.legacy_sanity_id='fixture-verified-review';"))
 upload_id=str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-durable-upload'))
 declaration={'uploadId':upload_id,'kind':'image','fileName':'fixture.png','mimeType':'image/png','byteSize':68,'sha1':sha1,'sha256':sha256,'width':1,'height':1,'expiresAt':'2099-01-01T00:00:00Z'}
 declaration.pop('expiresAt');arg='('+j(declaration)+"||jsonb_build_object('expiresAt',now()+interval '1 hour'))"
 issued=rpc('roo_create_cms_upload',[arg]);check('dimensions durably stored',(issued['declared_width'],issued['declared_height']),(1,1))
 refused('upload same identity changed dimension','select public.roo_create_cms_upload(('+j({**declaration,'width':2})+"||jsonb_build_object('expiresAt',now()+interval '1 hour')));",'CMS_UPLOAD_IDENTITY_CONFLICT')
 result={'asset':{'_type':'reference','_ref':id},'url':url,'width':1,'height':1,'mimeType':'image/png','byteSize':68}
 wrong_mime={**declaration,'uploadId':str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-upload-wrong-mime')),'mimeType':'image/gif'}
 issued_wrong=rpc('roo_create_cms_upload',['('+j(wrong_mime)+"||jsonb_build_object('expiresAt',now()+interval '1 hour'))"])
 refused('upload registered type must agree with original declaration','select public.roo_complete_cms_upload('+q(wrong_mime['uploadId'])+'::uuid,'+j(result)+');','CMS_UPLOAD_ASSET_MISMATCH')
 rpc('roo_refuse_cms_upload',[q(wrong_mime['uploadId'])+'::uuid',"'ASSET_VERIFICATION_FAILED'"])
 completed=rpc('roo_complete_cms_upload',[q(upload_id)+'::uuid',j(result)]);check('registered matching upload completes',completed['status'],'completed')
 check('completed upload exact replay',rpc('roo_complete_cms_upload',[q(upload_id)+'::uuid',j(result)])['result'],result)
 refused('completed upload changed result','select public.roo_complete_cms_upload('+q(upload_id)+'::uuid,'+j({**result,'width':2})+');','CMS_UPLOAD_IDENTITY_CONFLICT')
 refused('unexpired staging cannot be marked cleaned','select public.roo_mark_cms_upload_staging_cleaned('+q(upload_id)+'::uuid);','CMS_UPLOAD_CLEANUP_NOT_ELIGIBLE')
 for i in range(21):
  u={**declaration,'uploadId':str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-expired-'+str(i)))}
  rpc('roo_create_cms_upload',['('+j(u)+"||jsonb_build_object('expiresAt',now()+interval '1 hour'))"])
 sql("update cms.uploads set expires_at=now()-interval '2 days' where status='issued';")
 first=rpc('roo_expired_cms_uploads',['20']);check('first cleanup batch bounded',len(first),20)
 for row in first:rpc('roo_mark_cms_upload_staging_cleaned',[q(row['uploadId'])+'::uuid'])
 second=rpc('roo_expired_cms_uploads',['20']);check('cleanup proceeds to row 21',len(second),1)
 rpc('roo_mark_cms_upload_staging_cleaned',[q(second[0]['uploadId'])+'::uuid']);check('cleaned staging no longer selected',rpc('roo_expired_cms_uploads',['20']),[])
 failure_id=str(uuid.uuid5(uuid.NAMESPACE_DNS,'fixture-transient-upload'));u={**declaration,'uploadId':failure_id}
 rpc('roo_create_cms_upload',['('+j(u)+"||jsonb_build_object('expiresAt',now()+interval '1 hour'))"])
 for i in range(6):failed=rpc('roo_record_cms_upload_failure',[q(failure_id)+'::uuid',"'STORAGE_TRANSIENT_FAILURE'"]);check('upload retry count '+str(i+1),failed['attempt_count'],i+1)
 check('six transient failures terminal with data retained',failed['status'],'refused')
 check('retry give-up retains original declaration',failed['sha256'],sha256)

def projection_owner_cases():
 tables={'payment_records':'paymentRecord','bookings':'booking','slot_holds':'slotHold'}
 parts=[]
 for table,typ in tables.items():
  parts.append(q(table)+",(select jsonb_agg(to_jsonb(t)-'updated_at'-'imported_at' order by legacy_sanity_id) from commerce."+table+" t where legacy_sanity_id like 'fixture-"+typ+"-%')")
 parts.append("'sources',(select jsonb_agg(to_jsonb(s) order by legacy_sanity_id) from migration.source_documents s where legacy_sanity_id like 'fixture-paymentRecord-%' or legacy_sanity_id like 'fixture-booking-%' or legacy_sanity_id like 'fixture-slotHold-%')")
 snapshot='select jsonb_build_object('+','.join(parts)+');'
 ids="array(select legacy_sanity_id from migration.source_documents where legacy_sanity_id like 'fixture-paymentRecord-%' or legacy_sanity_id like 'fixture-booking-%' or legacy_sanity_id like 'fixture-slotHold-%')"
 body="begin;update migration.source_documents set payload=jsonb_set(payload,'{expiresAt}','\"2099-12-31T00:00:00Z\"'::jsonb) where legacy_sanity_id like 'fixture-slotHold-%';update commerce.slot_holds set expires_at='2099-12-31T00:00:00Z',payload=jsonb_set(payload,'{expiresAt}','\"2099-12-31T00:00:00Z\"'::jsonb) where legacy_sanity_id like 'fixture-slotHold-%';"+snapshot+'select migration.project_commerce_document_ids('+ids+');select migration.project_commerce_extensions('+ids+');select migration.restore_commerce_owners('+ids+');'+snapshot+'select public.roo_refresh_operational_shadow();'+snapshot+'rollback;'
 records=[json.loads(line) for line in sql(body).stdout.splitlines() if line.strip()]
 original,incremental,full=[row for row in records if isinstance(row,dict) and 'sources' in row]
 save('mixed-owner-projection.json',{'before':original,'incremental':incremental,'full':full,'excludedMetadataColumns':['updated_at','imported_at']})
 check('mixed-owner incremental source and all typed columns preserved',incremental,original)
 check('mixed-owner full source and all typed columns preserved',full,original)

def start_inflight_writer():
 args=[str(BIN/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(RUN),'-p',PORT,'-U','serviroo','-d','postgres']
 locker=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV)
 locker.stdin.write("set application_name='inflight-release-locker';begin;select pg_advisory_xact_lock(hashtextextended('inflight-prerelease',0));\n");locker.stdin.flush()
 for _ in range(100):
  if value("select to_jsonb(exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name='inflight-release-locker' and l.locktype='advisory' and l.granted));"):break
  time.sleep(.01)
 else:raise AssertionError('inflight locker unavailable')
 writer=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV)
 doc={'_id':'inflight-prerelease-hold','_type':'slotHold','phase':'active','packageTitle':'In-flight old body','startTimeUTC':'2099-11-01T00:00:00Z','expiresAt':'2099-10-01T00:00:00Z'}
 writer.stdin.write("set application_name='inflight-old-writer';select public.roo_apply_commerce_document_mutations('inflight-prerelease',"+j([{'operation':'create','document':doc}])+",1);\n");writer.stdin.close()
 for _ in range(100):
  if value("select to_jsonb(exists(select 1 from pg_stat_activity where application_name='inflight-old-writer' and wait_event='advisory'));"):break
  time.sleep(.01)
 else:raise AssertionError('old function did not reach advisory barrier')
 return locker,writer

def finish_inflight_writer(locker,writer):
 counts=value("select jsonb_build_array((select count(*) from migration.commerce_mirror_outbox),(select count(*) from migration.document_mutation_mirror_outbox));")
 locker.stdin.write('commit;\n');locker.stdin.close();locker.wait(timeout=10);writer.wait(timeout=10)
 error=writer.stderr.read();check('old in-flight body returns successful authoritative write',writer.returncode,0)
 check('old in-flight body source commits after retirement',source_payload('inflight-prerelease-hold')['phase'],'active')
 check('old compiled producer cannot insert after retirement',value("select jsonb_build_array((select count(*) from migration.commerce_mirror_outbox),(select count(*) from migration.document_mutation_mirror_outbox));"),counts)
 report['inflightOldWriter']={'barrier':'old original function entered command advisory lock before migration, resumed after all release files','nativeResult':json.loads(writer.stdout.read().strip()),'stderr':error,'sourceCommitted':True,'outboxCountsUnchanged':True}

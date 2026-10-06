set lock_timeout = '5s';
set statement_timeout = '120s';

do $writers$
declare v record; v_definition text; v_changed text; v_count integer:=0; v_start integer; v_length integer;
begin
 for v in select p.oid, n.nspname||'.'||p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname,p.proname) in (('public','roo_apply_document_mutations'),('migration','roo_apply_commerce_document_mutations_unbounded'),('migration','apply_cms_commerce_mutation')) loop
  v_definition:=pg_get_functiondef(v.oid);
  v_start:=position('insert into migration.commerce_mirror_outbox' in lower(v_definition));
  if v_start=0 then v_start:=position('insert into migration.document_mutation_mirror_outbox' in lower(v_definition)); end if;
  if v_start=0 then raise exception 'missing expected writer: %',v.name; end if;
  v_length:=position(';' in substring(v_definition from v_start));
  v_changed:=overlay(v_definition placing '' from v_start for v_length);
  if v_changed=v_definition then raise exception 'missing expected writer: %',v.name; end if;
  v_changed:=regexp_replace(v_changed,E'begin\n',E'begin\n  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''cms-reference-integrity'', 0));\n','i');
  execute v_changed; v_count:=v_count+1;
 end loop;
 if v_count<>3 then raise exception 'expected three outbox producers, got %',v_count; end if;
end;
$writers$;

create or replace function migration.suppress_retired_sanity_outbox_insert()
returns trigger language plpgsql set search_path='' as $$ begin return null; end; $$;
revoke all on function migration.suppress_retired_sanity_outbox_insert() from public,anon,authenticated,service_role;
create trigger suppress_retired_sanity_outbox_insert before insert on migration.commerce_mirror_outbox for each row execute function migration.suppress_retired_sanity_outbox_insert();
create trigger suppress_retired_sanity_outbox_insert before insert on migration.document_mutation_mirror_outbox for each row execute function migration.suppress_retired_sanity_outbox_insert();

drop trigger if exists principals_refresh_creator_fallback_authority on accounts.principals;
drop trigger if exists creator_profiles_refresh_creator_fallback_authority on accounts.creator_profiles;
drop trigger if exists account_roles_refresh_creator_fallback_authority on accounts.account_roles;
create table migration.sanity_outbox_retirement (
 outbox text not null, event_key text not null, previous_state jsonb not null, retired_at timestamptz not null default now(),primary key(outbox,event_key)
);
alter table migration.sanity_outbox_retirement enable row level security;
revoke all on migration.sanity_outbox_retirement from public,anon,authenticated,service_role;
insert into migration.sanity_outbox_retirement(outbox,event_key,previous_state)
 select 'commerce_mirror_outbox',event_key,to_jsonb(o)-'documents'-'document_ids'-'deleted_ids' from migration.commerce_mirror_outbox o where status in ('pending','retry','processing')
 union all select 'document_mutation_mirror_outbox',event_key::text,to_jsonb(o)-'documents'-'document_ids'-'deleted_documents' from migration.document_mutation_mirror_outbox o where status in ('pending','retry','processing');
alter table migration.commerce_mirror_outbox add column retired_at timestamptz, add column retirement_reason text;
alter table migration.document_mutation_mirror_outbox add column retired_at timestamptz, add column retirement_reason text;
alter table migration.document_mutation_mirror_outbox alter column next_attempt_at drop not null;
do $$
declare v record;
begin
 for v in select conrelid::regclass as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid in ('migration.commerce_mirror_outbox'::regclass,'migration.document_mutation_mirror_outbox'::regclass) and contype='c' and pg_get_constraintdef(oid) like '%status = ANY%' loop
  execute format('alter table %s drop constraint %I',v.rel,v.conname);
  execute format('alter table %s add constraint %I %s',v.rel,v.conname,replace(v.def,'''pending''::text', '''retired''::text, ''pending''::text'));
 end loop;
end;
$$;
update migration.commerce_mirror_outbox set status='retired', retired_at=now(), retirement_reason='sanity_vendor_retired', lease_id=null, lease_expires_at=null, next_attempt_at=null, last_error_code='SANITY_VENDOR_RETIRED' where status in ('pending','retry','processing');
update migration.document_mutation_mirror_outbox set status='retired', retired_at=now(), retirement_reason='sanity_vendor_retired', lease_id=null, lease_expires_at=null, next_attempt_at=null, last_error_code='SANITY_VENDOR_RETIRED',updated_at=now() where status in ('pending','retry','processing');


do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_claim_commerce_mirror_events';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return ''[]''::jsonb; end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_claim_document_mutation_mirror_events';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return ''[]''::jsonb; end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_complete_commerce_mirror_event';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return jsonb_build_object(''event_key'',p_event_key,''status'',''retired'',''idempotent'',true); end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_complete_document_mutation_mirror_event';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return jsonb_build_object(''event_key'',p_event_key,''status'',''retired'',''idempotent'',true); end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_requeue_commerce_mirror_event';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return jsonb_build_object(''event_key'',p_event_key,''status'',''retired'',''requeued'',false); end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_requeue_document_mutation_mirror_event';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return jsonb_build_object(''event_key'',p_event_key,''status'',''retired'',''requeued'',false); end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_supersede_commerce_mirror_event';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return jsonb_build_object(''event_key'',p_event_key,''status'',''retired'',''superseded'',false); end;$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_commerce_mirror_backlog';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$select jsonb_build_object(''pending'',0,''actionable'',0,''processing'',0,''retry'',0,''dead_letters'',0,''superseded'',0,''overdue'',0,''expired_leases'',0,''oldest_created_at'',null,''oldest_age_seconds'',0,''checkpoint'',null,''ready'',true,''retired'',true);$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_document_mutation_mirror_backlog';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$select jsonb_build_object(''pending'',0,''actionable'',0,''processing'',0,''retry'',0,''dead_letters'',0,''superseded'',0,''overdue'',0,''expired_leases'',0,''oldest_created_at'',null,''oldest_age_seconds'',0,''checkpoint'',null,''ready'',true,''retired'',true);$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_commerce_mirror_status_for_ids';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$select jsonb_build_object(''pending'',0,''actionable'',0,''processing'',0,''retry'',0,''dead_letters'',0,''superseded'',0,''overdue'',0,''expired_leases'',0,''oldest_created_at'',null,''oldest_age_seconds'',0,''checkpoint'',null,''ready'',true,''retired'',true);$function$');
end;
$retire$;

do $retire$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_document_mutation_mirror_status_for_ids';
 execute regexp_replace(v,'AS \$function\$[\s\S]*\$function\$', 'AS $function$begin return jsonb_build_object(''pending'',0,''actionable'',0,''processing'',0,''retry'',0,''dead_letters'',0,''superseded'',0,''overdue'',0,''expired_leases'',0,''oldest_created_at'',null,''oldest_age_seconds'',0,''checkpoint'',null,''ready'',true,''retired'',true); end;$function$');
end;
$retire$;

do $edit$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_fetch_recovery_payment_documents';
 if position($old$      and payment.backend_owner = case
        when lower(p_backend) = 'supabase' then 'supabase' else 'sanity' end
$old$ in v)=0 then raise exception 'unexpected contract: roo_fetch_recovery_payment_documents'; end if;
 execute replace(v,$old$      and payment.backend_owner = case
        when lower(p_backend) = 'supabase' then 'supabase' else 'sanity' end
$old$,$new$$new$);
end;
$edit$;

do $edit$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_cleanup_expired_supabase_holds';
 if position($old$where hold.backend_owner = 'supabase'
      and hold.cutover_generation$old$ in v)=0 then raise exception 'unexpected contract: roo_cleanup_expired_supabase_holds'; end if;
 execute replace(v,$old$where hold.backend_owner = 'supabase'
      and hold.cutover_generation$old$,$new$where hold.cutover_generation$new$);
end;
$edit$;

do $edit$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_cleanup_expired_supabase_holds';
 if position($old$      and source.backend_owner = 'supabase'
$old$ in v)=0 then raise exception 'unexpected contract: roo_cleanup_expired_supabase_holds'; end if;
 v:=replace(v,$old$      and source.backend_owner = 'supabase'
$old$,$new$$new$);
 if position('limit p_limit' in v)=0 then raise exception 'unexpected cleanup batch contract'; end if;
 execute replace(v,'limit p_limit','limit least(p_limit,25)');
end;
$edit$;

do $edit$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_cleanup_expired_supabase_holds';
 if position($old$if nullif(v_mutation_result->>'event_key', '') is not null then$old$ in v)=0 then raise exception 'unexpected contract: roo_cleanup_expired_supabase_holds'; end if;
 execute replace(v,$old$if nullif(v_mutation_result->>'event_key', '') is not null then$old$,$new$if false then$new$);
end;
$edit$;

do $edit$
declare v text;
begin
 select pg_get_functiondef(p.oid) into strict v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_cleanup_commerce_rate_limits';
 if position($old$where backend_owner = 'supabase' and reset_at$old$ in v)=0 then raise exception 'unexpected contract: roo_cleanup_commerce_rate_limits'; end if;
 execute replace(v,$old$where backend_owner = 'supabase' and reset_at$old$,$new$where reset_at$new$);
end;
$edit$;

do $$
declare v record;
begin
 for v in select n.nspname,c.relname,a.attname from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname in ('migration','commerce','accounts','public','licensing','cms') and c.relkind='r' and a.attname in ('backend_owner','source_backend') and pg_get_expr(d.adbin,d.adrelid)='''sanity''::text' loop
  execute format('alter table %I.%I alter column %I set default %L',v.nspname,v.relname,v.attname,'supabase');
 end loop;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','migration','accounts','cms','commerce') and p.prokind='f' and pg_get_functiondef(p.oid) ~* 'insert[[:space:]]+into[[:space:]]+migration[.](commerce_mirror_outbox|document_mutation_mirror_outbox)') then raise exception 'Sanity outbox producer remains'; end if;
end;
$$;

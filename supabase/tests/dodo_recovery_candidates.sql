\set ON_ERROR_STOP on
begin;
create role anon; create role authenticated; create role service_role;
create schema commerce; create schema migration;
create table commerce.payment_records(id text primary key,legacy_sanity_id text,status text,provider text,backend_owner text,updated_at timestamptz,next_recovery_at timestamptz,refund_requires_booking_sync boolean default false,email_dispatch_required boolean default false,resource_release_pending boolean default false,late_capture_watch_until timestamptz);
create table migration.source_documents(legacy_sanity_id text primary key,payload jsonb,tombstoned boolean default false);
insert into commerce.payment_records(id,legacy_sanity_id,status,provider,backend_owner,updated_at)
select 'dodo-'||n,'dodo-'||n,'needs_recovery','dodo','supabase','2026-09-09T00:00:00Z' from generate_series(1,50) n;
insert into commerce.payment_records(id,legacy_sanity_id,status,provider,backend_owner,updated_at,next_recovery_at)
values ('paypal-eligible','paypal-eligible','needs_recovery','paypal','supabase','2026-09-10T00:00:00Z','2026-09-10T00:00:00Z');
insert into migration.source_documents(legacy_sanity_id,payload)
select legacy_sanity_id,jsonb_build_object('_id',legacy_sanity_id,'providerRecoveryTerminal',provider='dodo') from commerce.payment_records;

\ir ../migrations/20260910100000_filter_dodo_recovery_candidates.sql
\ir ../migrations/20260910110000_recover_dodo_partial_refunds.sql



do $$ declare result jsonb; enabled boolean; begin
foreach enabled in array array[true,false] loop
update migration.source_documents set payload=jsonb_set(payload,'{providerRecoveryTerminal}',to_jsonb(enabled)) where legacy_sanity_id like 'dodo-%';
result:=public.roo_fetch_recovery_payment_documents('supabase',array['needs_recovery','email_partial'],'refunded','booked','abandoned','2026-09-10T12:00:00Z',50,enabled);
if result<>'[{"_id":"paypal-eligible","providerRecoveryTerminal":false}]'::jsonb then raise exception 'Eligible payment starved: %',result; end if;
end loop;
update migration.source_documents set payload=jsonb_set(payload,'{providerRecoveryTerminal}','true') where legacy_sanity_id like 'dodo-%';
if jsonb_array_length(public.roo_fetch_recovery_payment_documents('supabase',array['needs_recovery'],'refunded','booked','abandoned','2026-09-10T12:00:00Z',50))<>1 then raise exception 'Legacy named arguments incompatible'; end if;
end $$;
insert into commerce.payment_records(id,legacy_sanity_id,status,provider,backend_owner,updated_at,refund_requires_booking_sync,email_dispatch_required,resource_release_pending)
values ('refund-sync','refund-sync','refunded','dodo','supabase',now(),true,false,false),
('partial-sync','partial-sync','booked','dodo','supabase',now(),true,false,false),
('release-sync','release-sync','abandoned','dodo','supabase',now(),false,false,true),
('email-sync','email-sync','booked','dodo','supabase',now(),false,true,false),
('reschedule-sync','reschedule-sync','email_partial','dodo','supabase',now(),false,false,false);
insert into migration.source_documents(legacy_sanity_id,payload)
select legacy_sanity_id,jsonb_build_object('_id',legacy_sanity_id,'providerRecoveryTerminal',true,'requiresReschedule',id='reschedule-sync') from commerce.payment_records where id in ('refund-sync','partial-sync','release-sync','email-sync','reschedule-sync');
do $$ declare result jsonb; begin
result:=public.roo_fetch_recovery_payment_documents('supabase',array['needs_recovery','email_partial'],'refunded','booked','abandoned','2026-09-10T12:00:00Z',50,false);
if jsonb_array_length(result)<>6 or not result @> '[{"_id":"paypal-eligible"},{"_id":"refund-sync"},{"_id":"partial-sync"},{"_id":"release-sync"},{"_id":"email-sync"},{"_id":"reschedule-sync"}]' then raise exception 'Local recovery was lost: %',result; end if;
if has_function_privilege('anon','public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)','execute') or has_function_privilege('authenticated','public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)','execute') then raise exception 'RPC privileges widened'; end if;
if not has_function_privilege('service_role','public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)','execute') then raise exception 'Service role cannot recover'; end if;
end $$;
select 'Dodo recovery migration checks passed' as result;

rollback;

\set ON_ERROR_STOP on
begin;
create role anon; create role authenticated; create role service_role;
create schema commerce; create schema migration;
create table commerce.payment_records(id text primary key,legacy_sanity_id text,booking_id text,status text,provider text,backend_owner text,updated_at timestamptz,next_recovery_at timestamptz,refund_requires_booking_sync boolean default false,email_dispatch_required boolean default false,resource_release_pending boolean default false,late_capture_watch_until timestamptz);
create table commerce.bookings(id text primary key,legacy_sanity_id text);
create table commerce.slot_holds(id uuid primary key,legacy_sanity_id text,backend_owner text,cutover_generation integer,phase text,expires_at timestamptz,payment_record_id text);
create table commerce.slot_claims(hold_id uuid);
create table migration.source_documents(legacy_sanity_id text primary key,document_type text default 'paymentRecord',backend_owner text default 'supabase',cutover_generation integer default 0,source_revision text default 'r1',payload jsonb,tombstoned boolean default false);
create function commerce.booking_confirmation_is_inactive(p_booking_id text) returns boolean language sql immutable as $$ select false; $$;
create function migration.assert_commerce_write_fence(p_gen integer) returns void language sql immutable as $$ select; $$;
create function public.roo_apply_commerce_document_mutations(p_cmd text,p_muts jsonb,p_gen integer) returns jsonb language sql immutable as $$ select '{}'::jsonb; $$;
insert into commerce.payment_records(id,legacy_sanity_id,status,provider,backend_owner,updated_at)
select 'dodo-'||n,'dodo-'||n,'needs_recovery','dodo','supabase','2026-09-09T00:00:00Z' from generate_series(1,50) n;
insert into commerce.payment_records(id,legacy_sanity_id,status,provider,backend_owner,updated_at,next_recovery_at)
values ('paypal-eligible','paypal-eligible','needs_recovery','paypal','supabase','2026-09-10T00:00:00Z','2026-09-10T00:00:00Z');
insert into migration.source_documents(legacy_sanity_id,payload)
select legacy_sanity_id,jsonb_build_object('_id',legacy_sanity_id,'providerRecoveryTerminal',provider='dodo') from commerce.payment_records;

\ir ../migrations/20260910100000_filter_dodo_recovery_candidates.sql
\ir ../migrations/20260910110000_recover_dodo_partial_refunds.sql
\ir ../migrations/20261013000000_skip_review_only_recovery_rows.sql
\ir ../migrations/20261109000000_resume_exhausted_late_capture_watches.sql
\ir ../migrations/20261118000000_harden_payment_recovery_and_hold_cleanup.sql

do $$ declare result jsonb; enabled boolean; begin
foreach enabled in array array[true,false] loop
update migration.source_documents set payload=jsonb_set(payload,'{providerRecoveryTerminal}',to_jsonb(enabled)) where legacy_sanity_id like 'dodo-%';
result:=public.roo_fetch_recovery_payment_documents('supabase',array['needs_recovery','email_partial'],'refunded','booked','abandoned','2026-09-10T12:00:00Z',50,enabled);
if result is null or jsonb_array_length(result)<>1 or ((result->0)-'_rev')<>'{"_id":"paypal-eligible","providerRecoveryTerminal":false}'::jsonb then raise exception 'Eligible payment starved: %',result; end if;
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
if result is null or jsonb_array_length(result)<>6 or not result @> '[{"_id":"paypal-eligible"},{"_id":"refund-sync"},{"_id":"partial-sync"},{"_id":"release-sync"},{"_id":"email-sync"},{"_id":"reschedule-sync"}]' then raise exception 'Local recovery was lost: %',result; end if;
if has_function_privilege('anon','public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean,uuid)','execute') or has_function_privilege('authenticated','public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean,uuid)','execute') then raise exception 'RPC privileges widened'; end if;
if not has_function_privilege('service_role','public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean,uuid)','execute') then raise exception 'Service role cannot recover'; end if;
if commerce.payment_protects_expired_hold('started', '{}'::jsonb) is distinct from false then raise exception 'Unpaid missing fields must return explicit false'; end if;
if commerce.payment_protects_expired_hold('started', '{"providerPaymentState":"partially_captured"}'::jsonb) is distinct from true then raise exception 'partially_captured must protect hold'; end if;
if commerce.payment_protects_expired_hold('started', '{"providerPaymentState":"processing"}'::jsonb) is distinct from true then raise exception 'processing must protect hold'; end if;
if commerce.payment_protects_expired_hold('started', '{"providerPaymentState":"requires_capture"}'::jsonb) is distinct from true then raise exception 'requires_capture must protect hold'; end if;
if commerce.payment_protects_expired_hold('started', '{"providerPaymentState":"requires_customer_action"}'::jsonb) is distinct from false then raise exception 'requires_customer_action must not protect hold past 24h'; end if;
if commerce.payment_protects_expired_hold('needs_recovery', '{"providerPaymentState":"refunded","providerReversalVerified":true,"recoveryOwnerReviewRequired":true}'::jsonb) is distinct from true then raise exception 'owner review must protect hold even when verified refunded'; end if;
if commerce.payment_protects_expired_hold('needs_recovery', '{"providerPaymentState":"refunded"}'::jsonb) is distinct from true then raise exception 'legacy unverified reversal must protect hold'; end if;
if commerce.payment_protects_expired_hold('needs_recovery', '{"providerPaymentState":"refunded","providerReversalVerified":true}'::jsonb) is distinct from false then raise exception 'verified reversal without review should not protect hold'; end if;
if commerce.payment_protects_expired_hold('needs_recovery', '{"provider":"dodo","resourceReleasePending":true,"recoveryReason":"resource_release_exhausted"}'::jsonb) is distinct from true then raise exception 'exhausted cleanup must protect hold'; end if;
if commerce.has_active_late_capture_watch('{"lateCaptureWatchUntil":false}'::jsonb) is distinct from false then raise exception 'JSON false watch admitted'; end if;
if commerce.has_active_late_capture_watch('{"lateCaptureWatchUntil":"\t\r\n "}'::jsonb) is distinct from false then raise exception 'Whitespace watch admitted'; end if;
if commerce.has_active_late_capture_watch('{"lateCaptureWatchUntil":"-infinity"}'::jsonb) is distinct from false then raise exception 'Negative infinity watch admitted'; end if;
if commerce.has_active_late_capture_watch('{"lateCaptureWatchUntil":"infinity"}'::jsonb) is distinct from false then raise exception 'Infinity watch admitted'; end if;
if commerce.has_active_late_capture_watch('{"lateCaptureWatchUntil":"now"}'::jsonb) is distinct from false then raise exception 'Relative now watch admitted'; end if;
if commerce.has_active_late_capture_watch('{"lateCaptureWatchUntil":"2026-10-01T00:00:00Z"}'::jsonb) is distinct from true then raise exception 'Valid watch rejected'; end if;
end $$;
insert into commerce.payment_records(id,legacy_sanity_id,status,provider,backend_owner,updated_at,next_recovery_at,resource_release_pending)
values ('ex-cleanup','ex-cleanup','needs_recovery','dodo','supabase','2026-09-11T00:00:00Z','9999-12-31T23:59:59.999Z',true),
('ex-live','ex-live','needs_recovery','dodo','supabase','2026-09-11T00:00:00Z','9999-12-31T23:59:59.999Z',false),
('ex-overlap','ex-overlap','needs_recovery','dodo','supabase','2026-09-11T00:00:00Z','9999-12-31T23:59:59.999Z',true);
insert into migration.source_documents(legacy_sanity_id,payload) values
('ex-cleanup','{"_id":"ex-cleanup","provider":"dodo","reconciliationRecoveryTerminal":true,"resourceReleasePending":true,"providerPaymentState":"failed","providerRecoveryTerminal":false}'::jsonb),
('ex-live','{"_id":"ex-live","provider":"dodo","reconciliationRecoveryTerminal":true,"providerPaymentState":"processing","providerRecoveryTerminal":false}'::jsonb),
('ex-overlap','{"_id":"ex-overlap","provider":"dodo","reconciliationRecoveryTerminal":true,"resourceReleasePending":true,"providerPaymentState":"processing","providerRecoveryTerminal":false}'::jsonb);
do $$ declare result jsonb; begin
result:=public.roo_fetch_recovery_payment_documents('supabase',array['needs_recovery','email_partial'],'refunded','booked','abandoned','2026-09-10T12:00:00Z',50,false);
if result is null or not (result @> '[{"_id":"ex-cleanup"}]') then raise exception 'Dodo-disabled exhausted cleanup lost: %',result; end if;
if result @> '[{"_id":"ex-live"}]' then raise exception 'Dodo-disabled must exclude exhausted live state: %',result; end if;
if result @> '[{"_id":"ex-overlap"}]' then raise exception 'Dodo-disabled must exclude non-deadline pending cleanup: %',result; end if;
result:=public.roo_fetch_recovery_payment_documents('supabase',array['needs_recovery','email_partial'],'refunded','booked','abandoned','2026-09-10T12:00:00Z',50,true);
if result is null or not (result @> '[{"_id":"ex-cleanup"}]' and result @> '[{"_id":"ex-live"}]' and result @> '[{"_id":"ex-overlap"}]') then raise exception 'Dodo-enabled exhausted resume lost: %',result; end if;
end $$;
select 'Dodo recovery migration checks passed' as result;

rollback;

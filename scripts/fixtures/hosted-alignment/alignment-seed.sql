begin;
insert into auth.users(id,email) select ('11111111-0000-0000-0000-00000000000'||n)::uuid,'alignment-'||n||'@example.test' from generate_series(1,5)n;
insert into accounts.principals(id,status) select ('22222222-0000-0000-0000-00000000000'||n)::uuid,case n when 2 then 'disabled' when 3 then 'deleted' else 'active' end from generate_series(1,3)n;
insert into accounts.principal_auth_users(principal_id,user_id) select ('22222222-0000-0000-0000-00000000000'||n)::uuid,('11111111-0000-0000-0000-00000000000'||n)::uuid from generate_series(1,3)n;
insert into accounts.principal_auth_users(principal_id,user_id) values('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000005');
insert into auth.sessions(id,user_id,created_at,updated_at) select ('77777777-0000-0000-0000-00000000000'||n)::uuid,('11111111-0000-0000-0000-00000000000'||n)::uuid,'2026-01-01','2026-01-01' from generate_series(1,5)n;
insert into auth.refresh_tokens(id,user_id,token,session_id,created_at,updated_at) select n,('11111111-0000-0000-0000-00000000000'||((n-1)%5+1)), 'fixture-refresh-'||n,('77777777-0000-0000-0000-00000000000'||((n-1)%5+1))::uuid,'2026-01-01','2026-01-01' from generate_series(1,10)n;
insert into licensing.products(id,sku,name) values ('33333333-0000-0000-0000-000000000001','alignment-fixture','Alignment fixture');
insert into licensing.entitlements(id,product_id,user_id,buyer_email,purchase_backend,purchase_reference,status,principal_id)
select ('44444444-0000-0000-0000-00000000000'||n)::uuid,'33333333-0000-0000-0000-000000000001',('11111111-0000-0000-0000-00000000000'||n)::uuid,'alignment-'||n||'@example.test','manual','alignment-'||n,'active',case when n<=3 then ('22222222-0000-0000-0000-00000000000'||n)::uuid end from generate_series(1,4)n;
insert into licensing.device_activations(entitlement_id,device_fingerprint_hmac) select ('44444444-0000-0000-0000-00000000000'||n)::uuid,repeat(n::text,64) from generate_series(1,4)n;
insert into licensing.device_activations(entitlement_id,device_fingerprint_hmac,status,revoked_at) values ('44444444-0000-0000-0000-000000000001',repeat('5',64),'revoked','2026-01-01');
insert into accounts.oauth_intents(token_hash,flow,action,provider,target_user_id,return_path,expires_at,reauth_purpose,status)
select repeat(n::text,64),case when n=2 then 'tourney' else 'referral' end,case n when 1 then 'signin' when 2 then 'signup' when 3 then 'link' when 4 then 'reauth' else 'merge' end,'google',case when n>=3 then '11111111-0000-0000-0000-000000000001'::uuid end,'/ref/dashboard','2099-01-01',case when n=4 then 'link_identity' end,case when n=5 then 'failed' else 'pending' end from generate_series(1,5)n;
insert into accounts.reauth_grants(token_hash,user_id,principal_id,purpose,provider,expires_at)
select repeat((n+5)::text,64),'11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','link_identity',case n when 1 then null when 2 then 'google' else 'discord' end,'2099-01-01' from generate_series(1,3)n;
insert into commerce.bookings(id,legacy_sanity_id,status,package_title,amount_subunits,currency) values
(migration.document_uuid('booking','alignment-booking'),'alignment-booking','captured','Fixture',999,'USD'),
(migration.document_uuid('booking','alignment-unknown'),'alignment-unknown','captured','Unknown delivery',999,'USD');
insert into commerce.slot_holds(id,legacy_sanity_id,start_time_utc,package_title,phase,expires_at,released_at)
select ('55555555-0000-0000-0000-00000000000'||n)::uuid,'alignment-hold-'||n,'2099-02-01'::timestamptz+n*interval '1 day','Fixture',case n when 1 then 'active' when 2 then 'payment' when 3 then 'released' else 'expired' end,'2099-01-01',case when n>=3 then '2026-01-01'::timestamptz end from generate_series(1,4)n;
insert into commerce.booking_slots(booking_id,start_time_utc) values(migration.document_uuid('booking','alignment-booking'),'2099-03-01');
insert into commerce.slot_claims(start_time_utc,claim_type,booking_id) values('2099-03-01','booking',migration.document_uuid('booking','alignment-booking'));
insert into commerce.slot_claims(start_time_utc,claim_type,hold_id,expires_at) select start_time_utc,'hold',id,expires_at from commerce.slot_holds where phase in ('active','payment');
insert into commerce.payment_records(id,legacy_sanity_id,provider,status,session_scope,quote_fingerprint,provider_idempotency_key,amount_subunits,currency,booking_id,session_expires_at) values
('66666666-0000-0000-0000-000000000001','alignment-payment','razorpay','booked','alignment','alignment','alignment-key',999,'USD',migration.document_uuid('booking','alignment-booking'),'2099-01-01');
insert into commerce.refunds(payment_record_id,booking_id,provider,provider_refund_id,event_type,status,amount_subunits,currency,occurred_at) values
('66666666-0000-0000-0000-000000000001',migration.document_uuid('booking','alignment-booking'),'razorpay','alignment-refund','refund.processed','completed',499,'USD','2026-01-01');
insert into commerce.email_dispatches(booking_id,recipient_type,recipient_email_hash,idempotency_key,status,sent_at,provider_message_id)
select migration.document_uuid('booking','alignment-booking'),'customer',repeat('f',64),'alignment-email-'||n,case n when 1 then 'pending' when 2 then 'sent' else 'historical_unknown' end,case when n=2 then '2026-01-01'::timestamptz end,case when n=2 then 'alignment-provider' end from generate_series(1,3)n;
insert into migration.source_documents(legacy_sanity_id,document_type,source_hash,payload) values('alignment-unknown','booking',repeat('f',64),jsonb_build_object('_id','alignment-unknown','_type','booking','email','alignment-unknown@example.test','emailDispatchStatus','delivery_unknown','recoveryNotificationStatus','delivery_unknown','netAmount',9.99,'currency','USD','packageTitle','Unknown delivery'));
delete from accounts.principal_auth_users where user_id='11111111-0000-0000-0000-000000000004';
delete from accounts.principals where id='11111111-0000-0000-0000-000000000004';
commit;

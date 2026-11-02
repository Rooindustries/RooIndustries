set lock_timeout = '5s';
set statement_timeout = '120s';

do $edit$
declare
  v text;
  v_owner_pattern constant text :=
    $re$hold\.phase in \('active', 'payment'\)(\s+)and hold\.expires_at > pg_catalog\.clock_timestamp\(\)$re$;
  v_owner_replacement constant text :=
    $re$(hold.phase = 'payment' or (hold.phase = 'active'\1and hold.expires_at > pg_catalog.clock_timestamp()))$re$;
begin
  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'migration' and p.proname = 'reconcile_slot_claims_for_times';
  if pg_catalog.regexp_count(v, v_owner_pattern) <> 2 then
    raise exception 'unexpected contract: migration.reconcile_slot_claims_for_times';
  end if;
  execute pg_catalog.regexp_replace(v, v_owner_pattern, v_owner_replacement, 'g');

  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'migration' and p.proname = 'assert_slot_claim_integrity';
  if pg_catalog.regexp_count(v, v_owner_pattern) <> 1 then
    raise exception 'unexpected contract: migration.assert_slot_claim_integrity';
  end if;
  execute pg_catalog.regexp_replace(v, v_owner_pattern, v_owner_replacement, 'g');
end;
$edit$;

do $edit$
declare
  v text;
  v_pattern constant text :=
    $re$(and hold\.phase not in \('released', 'consumed', 'expired'\)\s+and )hold\.expires_at > now\(\)$re$;
begin
  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'roo_fetch_commerce_availability';
  if pg_catalog.regexp_count(v, v_pattern) <> 1 then
    raise exception 'unexpected contract: public.roo_fetch_commerce_availability';
  end if;
  execute pg_catalog.regexp_replace(v, v_pattern,
    $re$\1(hold.phase = 'payment' or hold.expires_at > now())$re$);
end;
$edit$;

do $edit$
declare
  v text;
  v_phase_pattern constant text :=
    $re$and hold\.phase in \('active', 'payment'\)\s+and hold\.expires_at <= v_now$re$;
  v_phase_replacement constant text := $re$and (
        (hold.phase = 'active' and hold.expires_at <= v_now)
        or (
          hold.phase = 'payment'
          and hold.expires_at <= v_now - interval '24 hours'
          and not exists (
            select 1
            from commerce.payment_records payment
            left join migration.source_documents payment_source
              on payment_source.legacy_sanity_id = payment.legacy_sanity_id
              and payment_source.document_type = 'paymentRecord'
              and not payment_source.tombstoned
            where payment.id = hold.payment_record_id
              and (
                payment.status in ('captured', 'finalizing', 'booked', 'email_partial')
                or payment_source.payload->>'providerPaymentState' = 'succeeded'
                or payment_source.payload->>'verificationState' = 'server_verified'
              )
          )
        )
      )$re$;
begin
  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'roo_cleanup_expired_supabase_holds';
  if pg_catalog.regexp_count(v, v_phase_pattern) <> 1 then
    raise exception 'unexpected contract: public.roo_cleanup_expired_supabase_holds';
  end if;
  execute pg_catalog.regexp_replace(v, v_phase_pattern, v_phase_replacement);
end;
$edit$;

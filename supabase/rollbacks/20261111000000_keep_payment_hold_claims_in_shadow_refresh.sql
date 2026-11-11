set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
declare
  v text;
  v_name text;
  v_schema text;
  v_count integer;
  v_holds bigint;
  v_sources bigint;
  v_clock_pattern constant text :=
    $re$\(hold\.phase = 'payment' or \(hold\.phase = 'active'(\s+)and hold\.expires_at > pg_catalog\.clock_timestamp\(\)\)\)$re$;
  v_clock_original constant text :=
    $re$hold.phase in ('active', 'payment')\1and hold.expires_at > pg_catalog.clock_timestamp()$re$;
  v_owner_pattern constant text :=
    $re$\(hold\.phase = 'payment' or \(hold\.phase = 'active'(\s+)and hold\.expires_at > now\(\)\)\)$re$;
  v_owner_original constant text :=
    $re$hold.phase in ('active', 'payment')\1and hold.expires_at > now()$re$;
  v_expiry_pattern constant text :=
    $re$hold\.phase = 'active'(\s+)and hold\.expires_at <= now\(\)$re$;
  v_expiry_original constant text :=
    $re$hold.phase in ('active', 'payment')\1and hold.expires_at <= now()$re$;
  v_claim_new constant text := $new$and (
      (
        claim.hold_id is not null$new$;
  v_claim_old constant text := $old$and (
      claim.expires_at <= now()
      or (
        claim.hold_id is not null$old$;
  v_availability_new constant text := $new$(hold.phase = 'payment' or hold.expires_at > now())$new$;
  v_availability_old constant text := $old$hold.expires_at > now()$old$;
  v_cleanup_new constant text := $new$and (
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
              and coalesce(payment_source.payload->>'providerPaymentState', '') not in ('refunded', 'disputed')
              and (
                payment.status in ('captured', 'finalizing', 'booked', 'email_partial')
                or payment_source.payload->>'providerPaymentState' = 'succeeded'
                or payment_source.payload->>'verificationState' = 'server_verified'
              )
          )
        )
      )$new$;
  v_cleanup_old constant text := $old$and hold.phase in ('active', 'payment')
      and hold.expires_at <= v_now$old$;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  lock table commerce.slot_holds in share row exclusive mode;
  lock table commerce.booking_slots, commerce.slot_claims, migration.source_documents in share row exclusive mode nowait;

  select count(*) into v_holds from commerce.slot_holds where phase = 'payment';
  select count(*) into v_sources from migration.source_documents
  where document_type = 'slotHold' and not tombstoned
    and lower(coalesce(payload->>'phase', 'active')) in ('payment', 'payment_pending')
    and migration.try_timestamptz(payload->>'startTimeUTC') is not null
    and migration.try_timestamptz(payload->>'expiresAt') is not null;
  if v_holds > 0 or v_sources > 0 then
    raise exception 'payment holds are present (slot holds: %, source documents: %); fix forward', v_holds, v_sources;
  end if;

  for v_name, v_count in values ('reconcile_slot_claims_for_times', 2), ('assert_slot_claim_integrity', 1) loop
    select pg_get_functiondef(p.oid) into strict v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'migration' and p.proname = v_name;
    if pg_catalog.regexp_count(v, v_clock_pattern) <> v_count then
      raise exception 'unexpected contract: migration.%', v_name;
    end if;
    execute pg_catalog.regexp_replace(v, v_clock_pattern, v_clock_original, 'g');
  end loop;

  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'roo_fetch_commerce_availability';
  if array_length(string_to_array(v, v_availability_new), 1) is distinct from 2 then
    raise exception 'unexpected contract: public.roo_fetch_commerce_availability';
  end if;
  execute replace(v, v_availability_new, v_availability_old);

  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'roo_cleanup_expired_supabase_holds';
  if array_length(string_to_array(v, v_cleanup_new), 1) is distinct from 2 then
    raise exception 'unexpected contract: public.roo_cleanup_expired_supabase_holds';
  end if;
  execute replace(v, v_cleanup_new, v_cleanup_old);

  for v_schema, v_name in values
    ('public', 'roo_project_operational_shadow'),
    ('public', 'roo_cleanup_operational_shadow'),
    ('migration', 'project_commerce_document_ids_unserialized') loop
    select pg_get_functiondef(p.oid) into strict v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = v_schema and p.proname = v_name;
    if pg_catalog.regexp_count(v, v_owner_pattern) <> 1 then
      raise exception 'unexpected contract: %.%', v_schema, v_name;
    end if;
    if v_name = 'roo_cleanup_operational_shadow' then
      if pg_catalog.regexp_count(v, v_expiry_pattern) <> 1
        or array_length(string_to_array(v, v_claim_new), 1) is distinct from 2 then
        raise exception 'unexpected contract: %.%', v_schema, v_name;
      end if;
      v := pg_catalog.regexp_replace(v, v_expiry_pattern, v_expiry_original);
      v := replace(v, v_claim_new, v_claim_old);
    end if;
    execute pg_catalog.regexp_replace(v, v_owner_pattern, v_owner_original);
  end loop;
end;
$rollback$;

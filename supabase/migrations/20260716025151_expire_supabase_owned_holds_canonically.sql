set lock_timeout = '5s';
set statement_timeout = '120s';

-- Expire Supabase-owned holds through the canonical mutation path so the
-- document, typed projection, slot claim, and Sanity mirror outbox remain one
-- atomic state transition.

create or replace function public.roo_cleanup_expired_supabase_holds(
  p_cutover_generation integer,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_claim_existed boolean;
  v_expired_holds integer := 0;
  v_removed_slot_claims integer := 0;
  v_mirror_events_enqueued integer := 0;
  v_mutation_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 500 then
    raise exception 'cleanup limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  perform migration.assert_commerce_write_fence(p_cutover_generation);

  for v_candidate in
    select
      hold.id hold_id,
      source.legacy_sanity_id document_id,
      source.source_revision,
      source.payload
    from commerce.slot_holds hold
    join migration.source_documents source
      on source.legacy_sanity_id = hold.legacy_sanity_id
    where hold.backend_owner = 'supabase'
      and hold.cutover_generation = p_cutover_generation
      and hold.phase in ('active', 'payment')
      and hold.expires_at <= v_now
      and source.backend_owner = 'supabase'
      and source.cutover_generation = p_cutover_generation
      and source.document_type = 'slotHold'
      and not source.tombstoned
      and lower(coalesce(source.payload->>'phase', 'active'))
        in ('active', 'holding', 'payment', 'payment_pending')
    order by hold.expires_at, source.legacy_sanity_id
    for update of source skip locked
    limit p_limit
  loop
    select exists (
      select 1
      from commerce.slot_claims claim
      where claim.hold_id = v_candidate.hold_id
    ) into v_claim_existed;

    select public.roo_apply_commerce_document_mutations(
      'cleanup.expired-hold.' || encode(
        extensions.digest(
          v_candidate.document_id || ':' || v_candidate.source_revision,
          'sha256'
        ),
        'hex'
      ),
      jsonb_build_array(jsonb_build_object(
        'operation', 'replace',
        'expected_revision', v_candidate.source_revision,
        'document', v_candidate.payload || jsonb_build_object(
          'phase', 'expired',
          'releasedAt', v_now,
          'releaseReason', 'expired_by_operational_cleanup',
          'holdNonce', gen_random_uuid()::text
        )
      )),
      p_cutover_generation
    ) into v_mutation_result;

    v_expired_holds := v_expired_holds + 1;
    if nullif(v_mutation_result->>'event_key', '') is not null then
      v_mirror_events_enqueued := v_mirror_events_enqueued + 1;
    end if;
    if v_claim_existed and not exists (
      select 1
      from commerce.slot_claims claim
      where claim.hold_id = v_candidate.hold_id
    ) then
      v_removed_slot_claims := v_removed_slot_claims + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'expired_holds', v_expired_holds,
    'removed_slot_claims', v_removed_slot_claims,
    'mirror_events_enqueued', v_mirror_events_enqueued,
    'cutover_generation', p_cutover_generation
  );
end;
$$;

revoke all on function public.roo_cleanup_expired_supabase_holds(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.roo_cleanup_expired_supabase_holds(integer, integer)
  to service_role;

set lock_timeout = '5s';
set statement_timeout = '120s';

-- Expose narrowly scoped, service-role-only evidence for referral accounting
-- recovery and namespaced mirror reconciliation without exposing credentials.

create index if not exists commerce_mirror_outbox_document_ids_gin
  on migration.commerce_mirror_outbox using gin (document_ids);

create or replace function migration.referral_accounting_patch(p_payload jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
  from jsonb_each(p_payload) field
  where field.key = any(array[
    'successfulReferrals',
    'isFirstTime',
    'xocPayments',
    'vertexPayments',
    'earnedXoc',
    'earnedVertex',
    'earnedTotal',
    'paidXoc',
    'paidVertex',
    'paidTotal',
    'owedXoc',
    'owedVertex',
    'owedTotal',
    'notes'
  ]::text[]);
$$;

create or replace function public.roo_referral_recovery_snapshot(
  p_referral_id text,
  p_domain text,
  p_sequence_no bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_referral_id text := btrim(coalesce(p_referral_id, ''));
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_document jsonb;
  v_event_key text;
  v_status text;
  v_created_at timestamptz;
  v_accounting jsonb;
begin
  if v_referral_id !~ '^referral[.][A-Za-z0-9_-]{1,120}$'
    or v_domain not in ('global', 'commerce')
    or coalesce(p_sequence_no, 0) < 1 then
    raise exception 'invalid referral recovery snapshot request'
      using errcode = '22023';
  end if;

  if v_domain = 'global' then
    select
      item.value,
      event.event_key::text,
      event.status,
      event.created_at
    into v_document, v_event_key, v_status, v_created_at
    from migration.document_mutation_mirror_outbox event
    cross join lateral jsonb_array_elements(event.documents) item(value)
    where event.sequence_no = p_sequence_no
      and item.value->>'_id' = v_referral_id
      and item.value->>'_type' = 'referral'
    limit 1;
  else
    select
      item.value,
      event.event_key,
      event.status,
      event.created_at
    into v_document, v_event_key, v_status, v_created_at
    from migration.commerce_mirror_outbox event
    cross join lateral jsonb_array_elements(event.documents) item(value)
    where event.sequence_no = p_sequence_no
      and item.value->>'_id' = v_referral_id
      and item.value->>'_type' = 'referral'
    limit 1;
  end if;

  if v_document is null then
    raise exception 'referral recovery snapshot not found'
      using errcode = 'P0002';
  end if;

  v_accounting := migration.referral_accounting_patch(v_document);
  return jsonb_build_object(
    'referral_id', v_referral_id,
    'domain', v_domain,
    'sequence_no', p_sequence_no::text,
    'event_key', v_event_key,
    'event_status', v_status,
    'event_created_at', v_created_at,
    'source_revision', nullif(v_document->>'_rev', ''),
    'accounting', v_accounting,
    'accounting_keys', coalesce((
      select jsonb_agg(key order by key)
      from jsonb_object_keys(v_accounting) key
    ), '[]'::jsonb),
    'accounting_digest', encode(
      extensions.digest(v_accounting::text, 'sha256'),
      'hex'
    )
  );
end;
$$;

create or replace function public.roo_referral_accounting_loss_candidates()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with historical as materialized (
    select
      item.value->>'_id' referral_id,
      'global'::text domain,
      event.sequence_no,
      event.event_key::text event_key,
      event.status,
      event.created_at,
      migration.referral_accounting_patch(item.value) accounting,
      (
        select count(*)::integer
        from jsonb_object_keys(
          migration.referral_accounting_patch(item.value)
        )
      ) accounting_key_count
    from migration.document_mutation_mirror_outbox event
    cross join lateral jsonb_array_elements(event.documents) item(value)
    where event.status = 'applied'
      and item.value->>'_type' = 'referral'
    union all
    select
      item.value->>'_id' referral_id,
      'commerce'::text domain,
      event.sequence_no,
      event.event_key,
      event.status,
      event.created_at,
      migration.referral_accounting_patch(item.value) accounting,
      (
        select count(*)::integer
        from jsonb_object_keys(
          migration.referral_accounting_patch(item.value)
        )
      ) accounting_key_count
    from migration.commerce_mirror_outbox event
    cross join lateral jsonb_array_elements(event.documents) item(value)
    where event.status in ('mirrored', 'superseded')
      and item.value->>'_type' = 'referral'
  ), ranked_history as materialized (
    select
      history.*,
      row_number() over (
        partition by history.referral_id
        order by history.accounting_key_count desc,
          history.created_at desc,
          history.sequence_no desc,
          history.domain,
          history.event_key
      ) history_rank
    from historical history
  ), current_referrals as (
    select
      source.legacy_sanity_id referral_id,
      source.source_revision,
      migration.referral_accounting_patch(source.payload) accounting
    from migration.source_documents source
    where source.document_type = 'referral'
      and not source.tombstoned
  ), ranked as (
    select
      current.referral_id,
      current.source_revision,
      current.accounting current_accounting,
      snapshot.domain,
      snapshot.sequence_no,
      snapshot.event_key,
      snapshot.status,
      snapshot.created_at,
      snapshot.accounting snapshot_accounting,
      snapshot.accounting_key_count
    from current_referrals current
    join ranked_history snapshot
      on snapshot.referral_id = current.referral_id
     and snapshot.history_rank = 1
  ), candidates as (
    select
      ranked.referral_id,
      ranked.source_revision,
      ranked.current_accounting,
      ranked.domain,
      ranked.sequence_no,
      ranked.event_key,
      ranked.status,
      ranked.created_at,
      ranked.snapshot_accounting,
      ranked.accounting_key_count,
      missing.missing_keys,
      count(later.sequence_no) filter (
        where exists (
          select 1
          from jsonb_each(later.accounting) field
          where ranked.snapshot_accounting ? field.key
            and field.value is distinct from
              ranked.snapshot_accounting->field.key
        )
      )::integer later_accounting_change_count
    from ranked
    cross join lateral (
      select coalesce(array_agg(key order by key), '{}'::text[]) missing_keys
      from jsonb_object_keys(ranked.snapshot_accounting) key
      where not (ranked.current_accounting ? key)
    ) missing
    left join historical later
      on later.referral_id = ranked.referral_id
     and later.created_at >= ranked.created_at
     and (later.domain, later.sequence_no)
       is distinct from (ranked.domain, ranked.sequence_no)
    group by
      ranked.referral_id,
      ranked.source_revision,
      ranked.current_accounting,
      ranked.domain,
      ranked.sequence_no,
      ranked.event_key,
      ranked.status,
      ranked.created_at,
      ranked.snapshot_accounting,
      ranked.accounting_key_count,
      missing.missing_keys
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'referral_id', candidate.referral_id,
    'current_revision', candidate.source_revision,
    'missing_accounting_keys', to_jsonb(candidate.missing_keys),
    'suggested_domain', candidate.domain,
    'suggested_sequence_no', candidate.sequence_no::text,
    'suggested_event_key', candidate.event_key,
    'suggested_event_status', candidate.status,
    'suggested_event_created_at', candidate.created_at,
    'suggested_accounting_key_count', candidate.accounting_key_count,
    'later_accounting_change_count', candidate.later_accounting_change_count,
    'unambiguous', candidate.later_accounting_change_count = 0,
    'suggested_accounting_digest', encode(
      extensions.digest(candidate.snapshot_accounting::text, 'sha256'),
      'hex'
    )
  ) order by candidate.referral_id), '[]'::jsonb)
  from candidates candidate
  where cardinality(candidate.missing_keys) > 0;
$$;

create or replace function public.roo_referral_mirror_domain_state(
  p_referral_ids text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids text[];
  v_result jsonb;
begin
  if p_referral_ids is not null then
    select coalesce(array_agg(distinct btrim(value) order by btrim(value)), '{}')
    into v_ids
    from unnest(p_referral_ids) value
    where btrim(coalesce(value, '')) ~ '^referral[.][A-Za-z0-9_-]{1,120}$';
    if cardinality(v_ids) <> cardinality(p_referral_ids)
      or cardinality(v_ids) > 500 then
      raise exception 'invalid referral mirror state request'
        using errcode = '22023';
    end if;
  else
    select coalesce(array_agg(candidate.referral_id order by candidate.referral_id), '{}')
    into v_ids
    from (
      select source.legacy_sanity_id referral_id
      from migration.source_documents source
      where source.document_type = 'referral'
        and not source.tombstoned
      order by source.legacy_sanity_id
      limit 501
    ) candidate;
    if cardinality(v_ids) > 500 then
      raise exception 'referral mirror state exceeds the 500-document limit'
        using errcode = '54000';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'referral_id', source.legacy_sanity_id,
    'source_revision', source.source_revision,
    'source_hash', source.source_hash,
    'global_sequence', coalesce(global_event.sequence_no, 0)::text,
    'commerce_sequence', coalesce(commerce_event.sequence_no, 0)::text
  ) order by source.legacy_sanity_id), '[]'::jsonb)
  into v_result
  from migration.source_documents source
  left join lateral (
    select event.sequence_no
    from migration.document_mutation_mirror_outbox event
    where event.status = 'applied'
      and event.document_ids @> array[source.legacy_sanity_id]
    order by event.sequence_no desc
    limit 1
  ) global_event on true
  left join lateral (
    select event.sequence_no
    from migration.commerce_mirror_outbox event
    where event.status in ('mirrored', 'superseded')
      and event.document_ids @> array[source.legacy_sanity_id]
    order by event.sequence_no desc
    limit 1
  ) commerce_event on true
  where source.document_type = 'referral'
    and not source.tombstoned
    and source.legacy_sanity_id = any(v_ids);

  return v_result;
end;
$$;

revoke all on function migration.referral_accounting_patch(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.roo_referral_recovery_snapshot(text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.roo_referral_accounting_loss_candidates()
  from public, anon, authenticated;
revoke all on function public.roo_referral_mirror_domain_state(text[])
  from public, anon, authenticated;

grant execute on function public.roo_referral_recovery_snapshot(text, text, bigint)
  to service_role;
grant execute on function public.roo_referral_accounting_loss_candidates()
  to service_role;
grant execute on function public.roo_referral_mirror_domain_state(text[])
  to service_role;

notify pgrst, 'reload schema';

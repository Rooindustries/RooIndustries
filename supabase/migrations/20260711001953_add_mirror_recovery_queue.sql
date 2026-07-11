create or replace function public.roo_record_mirror_failure(
  p_event_key text,
  p_operation text,
  p_ids text[],
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_operation text := btrim(coalesce(p_operation, ''));
  v_ids text[];
  v_attempt_count integer;
begin
  select coalesce(array_agg(distinct btrim(value) order by btrim(value)), '{}')
  into v_ids
  from unnest(coalesce(p_ids, '{}')) value
  where btrim(value) <> '';

  if v_event_key !~ '^mirror:[0-9a-f]{64}$'
     or v_operation not in (
       'sanity_to_supabase_sync',
       'supabase_to_sanity_upsert',
       'supabase_to_sanity_delete'
     )
     or cardinality(v_ids) < 1 then
    raise exception 'mirror failure metadata is invalid'
      using errcode = '22023';
  end if;

  insert into migration.dead_letters (
    event_key,
    legacy_sanity_id,
    operation,
    payload,
    attempt_count,
    last_error_code,
    last_error_message,
    first_failed_at,
    last_failed_at,
    resolved_at
  )
  values (
    v_event_key,
    v_ids[1],
    v_operation,
    jsonb_build_object('ids', to_jsonb(v_ids)),
    1,
    left(nullif(btrim(coalesce(p_error_code, '')), ''), 128),
    'Backend mirror request failed.',
    now(),
    now(),
    null
  )
  on conflict (event_key) do update
  set
    legacy_sanity_id = excluded.legacy_sanity_id,
    operation = excluded.operation,
    payload = excluded.payload,
    attempt_count = migration.dead_letters.attempt_count + 1,
    last_error_code = excluded.last_error_code,
    last_error_message = excluded.last_error_message,
    last_failed_at = now(),
    resolved_at = null
  returning attempt_count into v_attempt_count;

  return jsonb_build_object(
    'event_key', v_event_key,
    'queued', true,
    'attempt_count', v_attempt_count
  );
end;
$$;

create or replace function public.roo_resolve_mirror_failure(
  p_event_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_resolved integer;
begin
  if v_event_key !~ '^mirror:[0-9a-f]{64}$' then
    raise exception 'mirror event key is invalid'
      using errcode = '22023';
  end if;

  update migration.dead_letters
  set resolved_at = coalesce(resolved_at, now())
  where event_key = v_event_key
    and resolved_at is null;
  get diagnostics v_resolved = row_count;

  return jsonb_build_object(
    'event_key', v_event_key,
    'resolved', v_resolved > 0
  );
end;
$$;

create or replace function public.roo_list_reverse_mirror_failures(
  p_limit integer default 25
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'event_key', queued.event_key,
        'operation', queued.operation,
        'ids', queued.payload->'ids',
        'attempt_count', queued.attempt_count,
        'last_failed_at', queued.last_failed_at
      )
      order by queued.last_failed_at, queued.event_key
    ),
    '[]'::jsonb
  )
  from (
    select
      event_key,
      operation,
      payload,
      attempt_count,
      last_failed_at
    from migration.dead_letters
    where resolved_at is null
      and operation in (
        'supabase_to_sanity_upsert',
        'supabase_to_sanity_delete'
      )
    order by last_failed_at, event_key
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ) queued;
$$;

revoke all on function public.roo_record_mirror_failure(text, text, text[], text)
  from public, anon, authenticated;
revoke all on function public.roo_resolve_mirror_failure(text)
  from public, anon, authenticated;
revoke all on function public.roo_list_reverse_mirror_failures(integer)
  from public, anon, authenticated;

grant execute on function public.roo_record_mirror_failure(text, text, text[], text)
  to service_role;
grant execute on function public.roo_resolve_mirror_failure(text)
  to service_role;
grant execute on function public.roo_list_reverse_mirror_failures(integer)
  to service_role;

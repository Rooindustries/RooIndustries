alter table migration.commerce_mirror_outbox
  add column if not exists delete_guards jsonb not null default '{}'::jsonb;

alter table migration.commerce_mirror_outbox
  drop constraint if exists commerce_mirror_outbox_delete_guards_object;
alter table migration.commerce_mirror_outbox
  add constraint commerce_mirror_outbox_delete_guards_object
  check (jsonb_typeof(delete_guards) = 'object');

create or replace function migration.populate_commerce_mirror_delete_guards()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  select coalesce(jsonb_object_agg(
    deleted_id,
    jsonb_build_object(
      'source_revision', source.source_revision,
      'canonical_hash', migration.canonical_business_hash(source.payload),
      'cutover_generation', source.cutover_generation
    )
  ), '{}'::jsonb)
  into new.delete_guards
  from unnest(coalesce(new.deleted_ids, '{}'::text[])) deleted_id
  join migration.source_documents source
    on source.legacy_sanity_id = deleted_id;
  return new;
end;
$$;

drop trigger if exists commerce_mirror_outbox_delete_guards
  on migration.commerce_mirror_outbox;
create trigger commerce_mirror_outbox_delete_guards
before insert or update of deleted_ids
on migration.commerce_mirror_outbox
for each row
execute function migration.populate_commerce_mirror_delete_guards();

update migration.commerce_mirror_outbox outbox
set deleted_ids = outbox.deleted_ids
where cardinality(outbox.deleted_ids) > 0;

create or replace function public.roo_claim_commerce_mirror_events(
  p_lease_id text,
  p_limit integer default 25,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if nullif(btrim(coalesce(p_lease_id, '')), '') is null then
    raise exception 'mirror lease id is required' using errcode = '22023';
  end if;
  with candidates as (
    select id
    from migration.commerce_mirror_outbox
    where (
      status in ('pending', 'retry')
      and (
        coalesce(p_force, false)
        or coalesce(next_attempt_at, '-infinity'::timestamptz) <= now()
      )
    ) or (
      status = 'processing' and lease_expires_at <= now()
    )
    order by created_at, id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update migration.commerce_mirror_outbox outbox
    set
      status = 'processing',
      lease_id = p_lease_id,
      lease_expires_at = now() + interval '2 minutes',
      attempt_count = attempt_count + 1
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_key', claimed.event_key,
    'documents', coalesce((
      select jsonb_agg(
        document.value || jsonb_build_object(
          '_supabaseCanonicalHash',
          migration.canonical_business_hash(document.value)
        )
        order by document.value->>'_id'
      )
      from jsonb_array_elements(claimed.documents) document(value)
    ), '[]'::jsonb),
    'deleted_ids', to_jsonb(claimed.deleted_ids),
    'delete_guards', claimed.delete_guards,
    'canonical_hash', claimed.canonical_hash,
    'cutover_generation', claimed.cutover_generation,
    'attempt_count', claimed.attempt_count
  ) order by claimed.created_at, claimed.id), '[]'::jsonb)
  into v_result
  from claimed;
  return v_result;
end;
$$;

revoke all on function migration.populate_commerce_mirror_delete_guards()
  from public, anon, authenticated;
revoke all on function public.roo_claim_commerce_mirror_events(text, integer, boolean)
  from public, anon, authenticated;

grant execute on function public.roo_claim_commerce_mirror_events(text, integer, boolean)
  to service_role;

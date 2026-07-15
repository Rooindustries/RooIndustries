set lock_timeout = '5s';
set statement_timeout = '120s';

create table migration.document_mutation_mirror_outbox (
  sequence_no bigint generated always as identity primary key,
  event_key uuid not null default gen_random_uuid() unique,
  document_ids text[] not null,
  documents jsonb not null default '[]'::jsonb,
  deleted_documents jsonb not null default '[]'::jsonb,
  canonical_hash text not null check (canonical_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'applied', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  requeue_count integer not null default 0 check (requeue_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  dead_lettered_at timestamptz,
  check (cardinality(document_ids) > 0),
  check (jsonb_typeof(documents) = 'array'),
  check (jsonb_typeof(deleted_documents) = 'array'),
  check (
    (status = 'processing' and lease_id is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_id is null and lease_expires_at is null)
  ),
  check ((status = 'applied') = (applied_at is not null)),
  check ((status = 'dead_letter') = (dead_lettered_at is not null))
);

create table migration.document_mutation_mirror_actions (
  id bigint generated always as identity primary key,
  event_key uuid not null
    references migration.document_mutation_mirror_outbox(event_key) on delete restrict,
  action text not null check (action in ('requeue', 'supersede')),
  previous_attempt_count integer not null check (previous_attempt_count >= 0),
  actor text not null check (
    actor ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,79}$'
  ),
  reason text not null check (char_length(reason) between 8 and 240),
  acted_at timestamptz not null default now()
);

create index document_mutation_mirror_claim_idx
  on migration.document_mutation_mirror_outbox (next_attempt_at, sequence_no)
  where status in ('pending', 'retry');

create index document_mutation_mirror_expired_lease_idx
  on migration.document_mutation_mirror_outbox (lease_expires_at, sequence_no)
  where status = 'processing';

create index document_mutation_mirror_dead_letter_idx
  on migration.document_mutation_mirror_outbox (dead_lettered_at desc, sequence_no)
  where status = 'dead_letter';

create index document_mutation_mirror_document_ids_idx
  on migration.document_mutation_mirror_outbox using gin (document_ids)
  where status in ('pending', 'processing', 'retry', 'dead_letter');

create index document_mutation_mirror_actions_event_idx
  on migration.document_mutation_mirror_actions (event_key, acted_at desc);

alter table migration.document_mutation_mirror_outbox enable row level security;
alter table migration.document_mutation_mirror_actions enable row level security;

revoke all on migration.document_mutation_mirror_outbox,
  migration.document_mutation_mirror_actions
  from public, anon, authenticated, service_role;

revoke all on sequence migration.document_mutation_mirror_outbox_sequence_no_seq,
  migration.document_mutation_mirror_actions_id_seq
  from public, anon, authenticated, service_role;

create policy "document_mutation_mirror_outbox_deny_browser"
  on migration.document_mutation_mirror_outbox
  for all to anon, authenticated using (false) with check (false);

create policy "document_mutation_mirror_actions_deny_browser"
  on migration.document_mutation_mirror_actions
  for all to anon, authenticated using (false) with check (false);

create or replace function public.roo_apply_document_mutations(
  p_mutations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutation jsonb;
  v_operation text;
  v_id text;
  v_expected_revision text;
  v_current migration.source_documents%rowtype;
  v_payload jsonb;
  v_type text;
  v_revision text;
  v_hash text;
  v_now timestamptz;
  v_results jsonb := '[]'::jsonb;
  v_changed_ids text[] := '{}'::text[];
  v_deleted_by_id jsonb := '{}'::jsonb;
  v_documents jsonb := '[]'::jsonb;
  v_deleted_documents jsonb := '[]'::jsonb;
  v_canonical_hash text;
  v_applied integer;
begin
  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) > 100 then
    raise exception 'p_mutations must be a JSON array'
      using errcode = '22023';
  end if;

  for v_mutation in
    select value from jsonb_array_elements(p_mutations)
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(
      v_mutation->>'id',
      v_mutation->'document'->>'_id',
      ''
    );
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');

    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation'
        using errcode = '22023';
    end if;

    if v_id = ''
       or v_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in v_id) > 0 then
      raise exception 'document mutation is missing or has an invalid id'
        using errcode = '22023';
    end if;

    select *
    into v_current
    from migration.source_documents
    where legacy_sanity_id = v_id
    for update;

    if v_operation = 'create' and found then
      raise exception 'document already exists: %', v_id
        using errcode = '23505';
    end if;

    if v_operation = 'create_if_missing' and found then
      v_results := v_results || jsonb_build_array(v_current.payload);
      continue;
    end if;

    if v_operation in ('replace', 'delete') and not found then
      raise exception 'document not found: %', v_id
        using errcode = 'P0002';
    end if;

    if v_expected_revision is not null
       and found
       and v_current.source_revision is distinct from v_expected_revision then
      raise exception 'document revision conflict: %', v_id
        using errcode = '40001';
    end if;

    if v_operation = 'delete' then
      v_changed_ids := array_append(v_changed_ids, v_id);
      v_deleted_by_id := jsonb_set(
        v_deleted_by_id,
        array[v_id],
        v_current.payload || jsonb_build_object(
          '_supabaseCanonicalHash', v_current.source_hash,
          '_supabaseRevision', v_current.source_revision
        ),
        true
      );
      delete from cms.documents where legacy_sanity_id = v_id;
      delete from migration.source_documents where legacy_sanity_id = v_id;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('_id', v_id, 'deleted', true)
      );
      continue;
    end if;

    v_payload := v_mutation->'document';
    v_type := nullif(btrim(coalesce(v_payload->>'_type', '')), '');

    if v_payload is null
       or v_type is null
       or char_length(v_type) > 128
       or v_type !~ '^[A-Za-z][A-Za-z0-9_.-]*$' then
      raise exception 'document mutation is missing document type'
        using errcode = '22023';
    end if;

    if v_payload ? '_id'
       and coalesce(v_payload->>'_id', '') <> v_id then
      raise exception 'document mutation identity mismatch'
        using errcode = '22023';
    end if;

    v_now := clock_timestamp();
    v_revision := replace(gen_random_uuid()::text, '-', '');
    v_payload := v_payload || jsonb_build_object(
      '_id', v_id,
      '_type', v_type,
      '_rev', v_revision,
      '_updatedAt', v_now
    );

    if not (v_payload ? '_createdAt') then
      v_payload := v_payload || jsonb_build_object(
        '_createdAt',
        coalesce(v_current.payload->'_createdAt', to_jsonb(v_now))
      );
    end if;

    v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

    insert into migration.source_documents (
      legacy_sanity_id,
      document_type,
      source_revision,
      source_hash,
      payload,
      source_created_at,
      source_updated_at,
      first_seen_at,
      last_seen_at,
      operational_imported,
      cms_imported,
      tombstoned,
      backend_owner
    )
    values (
      v_id,
      v_type,
      v_revision,
      v_hash,
      v_payload,
      nullif(v_payload->>'_createdAt', '')::timestamptz,
      v_now,
      now(),
      now(),
      false,
      false,
      false,
      'supabase'
    )
    on conflict (legacy_sanity_id) do update
    set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      tombstoned = false,
      backend_owner = 'supabase'
    where v_operation = 'replace';
    get diagnostics v_applied = row_count;

    if v_applied = 0 then
      if v_operation = 'create' then
        raise exception 'document already exists: %', v_id
          using errcode = '23505';
      end if;
      select payload into v_payload
      from migration.source_documents
      where legacy_sanity_id = v_id;
      v_results := v_results || jsonb_build_array(v_payload);
      continue;
    end if;

    perform cms.sync_document_from_source(v_payload, v_hash);
    v_changed_ids := array_append(v_changed_ids, v_id);
    v_results := v_results || jsonb_build_array(v_payload);
  end loop;

  v_changed_ids := array(
    select distinct changed_id
    from unnest(v_changed_ids) changed_id
    where nullif(btrim(changed_id), '') is not null
    order by changed_id
  );

  if cardinality(v_changed_ids) > 0 then
    select coalesce(
      jsonb_agg(
        source.payload || jsonb_build_object(
          '_supabaseCanonicalHash', source.source_hash,
          '_supabaseRevision', source.source_revision
        )
        order by source.legacy_sanity_id
      ),
      '[]'::jsonb
    )
    into v_documents
    from migration.source_documents source
    where source.legacy_sanity_id = any(v_changed_ids)
      and not source.tombstoned;

    select coalesce(
      jsonb_agg(v_deleted_by_id->changed_id order by changed_id),
      '[]'::jsonb
    )
    into v_deleted_documents
    from unnest(v_changed_ids) changed_id
    where v_deleted_by_id ? changed_id
      and not exists (
        select 1
        from migration.source_documents source
        where source.legacy_sanity_id = changed_id
          and not source.tombstoned
      );

    v_canonical_hash := encode(
      extensions.digest(
        jsonb_build_object(
          'documents', v_documents,
          'deleted_documents', v_deleted_documents
        )::text,
        'sha256'
      ),
      'hex'
    );

    insert into migration.document_mutation_mirror_outbox (
      document_ids,
      documents,
      deleted_documents,
      canonical_hash
    )
    values (
      v_changed_ids,
      v_documents,
      v_deleted_documents,
      v_canonical_hash
    );
  end if;

  return v_results;
end;
$$;

create or replace function public.roo_claim_document_mutation_mirror_events(
  p_lease_id uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_preferred_document_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_preferred_ids text[] := '{}'::text[];
begin
  if p_lease_id is null
     or coalesce(p_limit, 0) not between 1 and 100
     or coalesce(p_lease_seconds, 0) not between 30 and 300 then
    raise exception 'invalid document mirror claim input'
      using errcode = '22023';
  end if;

  if p_preferred_document_ids is not null then
    if cardinality(p_preferred_document_ids) not between 1 and 100 then
      raise exception 'invalid preferred document mirror input'
        using errcode = '22023';
    end if;
    select coalesce(
      array_agg(distinct id order by id),
      '{}'::text[]
    )
    into v_preferred_ids
    from unnest(p_preferred_document_ids) id
    where id is not null
      and id ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
      and position('..' in id) = 0;
    if cardinality(v_preferred_ids) <> cardinality(array(
      select distinct id from unnest(p_preferred_document_ids) id
    )) then
      raise exception 'invalid preferred document mirror input'
        using errcode = '22023';
    end if;
  end if;

  update migration.document_mutation_mirror_outbox
  set
    status = 'dead_letter',
    lease_id = null,
    lease_expires_at = null,
    last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
    updated_at = now(),
    applied_at = null,
    dead_lettered_at = now()
  where status = 'processing'
    and lease_expires_at <= now()
    and attempt_count >= max_attempts;

  with candidates as (
    select candidate.sequence_no
    from migration.document_mutation_mirror_outbox candidate
    where (
      (
        candidate.status in ('pending', 'retry')
        and candidate.next_attempt_at <= now()
      ) or (
        candidate.status = 'processing'
        and candidate.lease_expires_at <= now()
        and candidate.attempt_count < candidate.max_attempts
      )
    )
    and not exists (
      select 1
      from migration.document_mutation_mirror_outbox prior
      where prior.sequence_no < candidate.sequence_no
        and prior.status in ('pending', 'processing', 'retry')
        and prior.document_ids && candidate.document_ids
    )
    order by (candidate.document_ids && v_preferred_ids) desc,
      candidate.sequence_no
    for update skip locked
    limit p_limit
  ), claimed as (
    update migration.document_mutation_mirror_outbox event
    set
      status = 'processing',
      attempt_count = event.attempt_count + 1,
      lease_id = p_lease_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now(),
      dead_lettered_at = null
    from candidates
    where event.sequence_no = candidates.sequence_no
    returning event.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sequence_no', claimed.sequence_no::text,
        'event_key', claimed.event_key,
        'document_ids', to_jsonb(claimed.document_ids),
        'documents', coalesce((
          select jsonb_agg(
            document.value || jsonb_build_object(
              '_supabaseSequence', claimed.sequence_no::text
            )
            order by document.value->>'_id'
          )
          from jsonb_array_elements(claimed.documents) document(value)
        ), '[]'::jsonb),
        'deleted_documents', coalesce((
          select jsonb_agg(
            document.value || jsonb_build_object(
              '_supabaseSequence', claimed.sequence_no::text
            )
            order by document.value->>'_id'
          )
          from jsonb_array_elements(claimed.deleted_documents) document(value)
        ), '[]'::jsonb),
        'canonical_hash', claimed.canonical_hash,
        'attempt_count', claimed.attempt_count,
        'max_attempts', claimed.max_attempts
      )
      order by claimed.sequence_no
    ),
    '[]'::jsonb
  )
  into v_result
  from claimed;

  return v_result;
end;
$$;

create or replace function public.roo_complete_document_mutation_mirror_event(
  p_event_key uuid,
  p_lease_id uuid,
  p_success boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event migration.document_mutation_mirror_outbox%rowtype;
  v_status text;
  v_resolved integer := 0;
begin
  if p_event_key is null or p_lease_id is null or p_success is null then
    raise exception 'invalid document mirror completion input'
      using errcode = '22023';
  end if;

  select * into v_event
  from migration.document_mutation_mirror_outbox
  where event_key = p_event_key
  for update;

  if not found then
    raise exception 'document mirror event not found'
      using errcode = 'P0002';
  end if;

  if v_event.status = 'applied' then
    return jsonb_build_object(
      'event_key', p_event_key,
      'status', 'applied',
      'idempotent', true
    );
  end if;

  if v_event.status <> 'processing'
     or v_event.lease_id is distinct from p_lease_id then
    raise exception 'document mirror event lease conflict'
      using errcode = '40001';
  end if;

  if p_success then
    update migration.document_mutation_mirror_outbox
    set
      status = 'applied',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_code = null,
      updated_at = now(),
      applied_at = now(),
      dead_lettered_at = null
    where event_key = p_event_key;

    update migration.document_mutation_mirror_outbox older
    set
      status = 'applied',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_code = 'SUPERSEDED_BY_NEWER_SEQUENCE',
      updated_at = now(),
      applied_at = now(),
      dead_lettered_at = null
    where older.status = 'dead_letter'
      and older.sequence_no < v_event.sequence_no
      and not exists (
        select 1
        from unnest(older.document_ids) older_document_id
        where not exists (
          select 1
          from migration.document_mutation_mirror_outbox newer
          where newer.status = 'applied'
            and newer.sequence_no > older.sequence_no
            and newer.document_ids && array[older_document_id]::text[]
        )
      );
    get diagnostics v_resolved = row_count;
    v_status := 'applied';
  else
    v_status := case
      when v_event.attempt_count >= v_event.max_attempts then 'dead_letter'
      else 'retry'
    end;
    update migration.document_mutation_mirror_outbox
    set
      status = v_status,
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = case
        when v_status = 'dead_letter' then now()
        else now() + least(
          interval '5 minutes',
          interval '15 seconds' * power(2, least(v_event.attempt_count - 1, 5))
        )
      end,
      last_error_code = left(
        regexp_replace(
          upper(coalesce(nullif(btrim(p_error_code), ''), 'MIRROR_FAILED')),
          '[^A-Z0-9_:-]',
          '_',
          'g'
        ),
        128
      ),
      updated_at = now(),
      applied_at = null,
      dead_lettered_at = case when v_status = 'dead_letter' then now() else null end
    where event_key = p_event_key;
  end if;

  return jsonb_build_object(
    'event_key', p_event_key,
    'status', v_status,
    'resolved_older_dead_letters', v_resolved
  );
end;
$$;

create or replace function public.roo_requeue_document_mutation_mirror_event(
  p_event_key uuid,
  p_expected_attempt_count integer,
  p_actor text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event migration.document_mutation_mirror_outbox%rowtype;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_event_key is null
     or coalesce(p_expected_attempt_count, -1) < 0
     or v_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,79}$'
     or char_length(v_reason) not between 8 and 240 then
    raise exception 'invalid document mirror requeue input'
      using errcode = '22023';
  end if;

  select * into v_event
  from migration.document_mutation_mirror_outbox
  where event_key = p_event_key
  for update;

  if not found then
    raise exception 'document mirror event not found'
      using errcode = 'P0002';
  end if;

  if v_event.status <> 'dead_letter'
     or v_event.attempt_count <> p_expected_attempt_count then
    raise exception 'document mirror event changed or is not dead-lettered'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from unnest(v_event.document_ids) event_document_id
    where not exists (
      select 1
      from migration.document_mutation_mirror_outbox newer
      where newer.status = 'applied'
        and newer.sequence_no > v_event.sequence_no
        and newer.document_ids && array[event_document_id]::text[]
    )
  ) then
    update migration.document_mutation_mirror_outbox
    set
      status = 'applied',
      last_error_code = 'SUPERSEDED_BY_NEWER_SEQUENCE',
      updated_at = now(),
      applied_at = now(),
      dead_lettered_at = null
    where event_key = p_event_key;

    insert into migration.document_mutation_mirror_actions (
      event_key,
      action,
      previous_attempt_count,
      actor,
      reason
    ) values (
      p_event_key,
      'supersede',
      p_expected_attempt_count,
      v_actor,
      v_reason
    );

    return jsonb_build_object(
      'event_key', p_event_key,
      'status', 'applied',
      'actor', v_actor,
      'superseded', true
    );
  end if;

  if exists (
    select 1
    from migration.document_mutation_mirror_outbox newer
    where newer.status = 'applied'
      and newer.sequence_no > v_event.sequence_no
      and newer.document_ids && v_event.document_ids
  ) then
    raise exception 'document mirror event overlaps newer applied state; create an explicit repair event'
      using errcode = '40001';
  end if;

  update migration.document_mutation_mirror_outbox
  set
    status = 'retry',
    attempt_count = 0,
    requeue_count = requeue_count + 1,
    next_attempt_at = now(),
    last_error_code = null,
    updated_at = now(),
    dead_lettered_at = null
  where event_key = p_event_key;

  insert into migration.document_mutation_mirror_actions (
    event_key,
    action,
    previous_attempt_count,
    actor,
    reason
  )
  values (
    p_event_key,
    'requeue',
    p_expected_attempt_count,
    v_actor,
    v_reason
  );

  return jsonb_build_object(
    'event_key', p_event_key,
    'status', 'retry',
    'actor', v_actor,
    'requeue_count', v_event.requeue_count + 1
  );
end;
$$;

create or replace function public.roo_document_mutation_mirror_backlog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pending', count(*) filter (
      where status in ('pending', 'processing', 'retry', 'dead_letter')
    ),
    'actionable', count(*) filter (where status in ('pending', 'retry')),
    'processing', count(*) filter (where status = 'processing'),
    'retry', count(*) filter (where status = 'retry'),
    'dead_letters', count(*) filter (where status = 'dead_letter'),
    'overdue', count(*) filter (
      where status in ('pending', 'processing', 'retry')
        and created_at < now() - interval '5 minutes'
    ),
    'expired_leases', count(*) filter (
      where status = 'processing' and lease_expires_at <= now()
    ),
    'oldest_created_at', min(created_at) filter (
      where status in ('pending', 'processing', 'retry', 'dead_letter')
    ),
    'oldest_age_seconds', coalesce(
      extract(epoch from now() - min(created_at) filter (
        where status in ('pending', 'processing', 'retry', 'dead_letter')
      ))::bigint,
      0
    ),
    'ready',
      count(*) filter (where status = 'dead_letter') = 0
      and count(*) filter (
        where status in ('pending', 'processing', 'retry')
          and created_at < now() - interval '5 minutes'
      ) = 0
  )
  from migration.document_mutation_mirror_outbox;
$$;

create or replace function public.roo_document_mutation_mirror_status_for_ids(
  p_document_ids text[]
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
  if p_document_ids is null
     or cardinality(p_document_ids) not between 1 and 500 then
    raise exception 'invalid document mirror status input'
      using errcode = '22023';
  end if;

  select coalesce(
    array_agg(distinct id order by id),
    '{}'::text[]
  )
  into v_ids
  from unnest(p_document_ids) id
  where id is not null
    and id ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
    and position('..' in id) = 0;

  if cardinality(v_ids) <> cardinality(array(
    select distinct id from unnest(p_document_ids) id
  )) then
    raise exception 'invalid document mirror status input'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (
      where event.status in ('pending', 'processing', 'retry', 'dead_letter')
    ),
    'dead_letters', count(*) filter (where event.status = 'dead_letter'),
    'oldest_created_at', min(event.created_at) filter (
      where event.status in ('pending', 'processing', 'retry', 'dead_letter')
    )
  )
  into v_result
  from migration.document_mutation_mirror_outbox event
  where event.document_ids && v_ids;

  return v_result;
end;
$$;

create or replace function public.roo_supabase_port_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'documentMutationMirror', public.roo_document_mutation_mirror_backlog(),
    'credentialRecovery', jsonb_build_object(
      'pending', (select count(*) from accounts.credential_operations
        where status in ('prepared', 'auth_applied')),
      'oldestAt', (select min(created_at) from accounts.credential_operations
        where status in ('prepared', 'auth_applied'))
    ),
    'identityDrift', jsonb_build_object(
      'missing', (select count(*)
        from auth.identities identity
        join accounts.principal_auth_users mapping
          on mapping.user_id = identity.user_id
        where identity.provider in ('email', 'google', 'apple', 'discord')
          and not exists (
            select 1 from accounts.identity_links projected
            where projected.provider = identity.provider
              and projected.provider_subject = identity.provider_id
              and projected.principal_id = mapping.principal_id
          )),
      'stale', (select count(*) from accounts.identity_links projected
        where not exists (
          select 1 from auth.identities identity
          where identity.user_id = projected.user_id
            and identity.provider = projected.provider
            and identity.provider_id = projected.provider_subject
        ))
    ),
    'creatorProjectionDrift', (select count(*)
      from migration.source_documents source
      left join accounts.creator_profiles creator
        on creator.legacy_sanity_id = source.legacy_sanity_id
      where source.document_type = 'referral'
        and not source.tombstoned
        and (
          creator.user_id is null
          or source.source_hash is distinct from creator.source_hash
        )),
    'parityAgeSeconds', (
      select case when max(completed_at) is null then null
        else extract(epoch from now() - max(completed_at)) end
      from migration.sync_runs
      where direction = 'compare' and status = 'completed'
    ),
    'staleProviderRecovery', (select count(*)
      from commerce.payment_records payment
      where payment.status = 'needs_recovery'
        and (
          (payment.next_recovery_at is null
            and payment.updated_at < now() - interval '15 minutes')
          or payment.next_recovery_at < now() - interval '15 minutes'
        )),
    'capturedWithoutBooking', (select count(*)
      from commerce.payment_records payment
      where payment.status in ('captured', 'booked', 'email_partial')
        and payment.booking_id is null
        and not coalesce(payment.requires_reschedule, false)
        and not (
          payment.duplicate_payment_record
          and exists (
            select 1
            from commerce.payment_records canonical
            where canonical.id = payment.canonical_payment_record_id
              and canonical.booking_id is not null
          )
        )),
    'reciprocalLinkMismatches', (
      select count(*) from (
        select 'payment' source_kind, payment.id source_id
        from commerce.payment_records payment
        where payment.booking_id is not null
          and not exists (
            select 1 from commerce.bookings booking
            where booking.id = payment.booking_id
              and (
                booking.payment_record_id = payment.id
                or (
                  payment.duplicate_payment_record
                  and booking.payment_record_id =
                    payment.canonical_payment_record_id
                )
              )
          )
        union all
        select 'booking', booking.id
        from commerce.bookings booking
        where booking.payment_record_id is not null
          and not exists (
            select 1 from commerce.payment_records payment
            where payment.id = booking.payment_record_id
              and payment.booking_id = booking.id
          )
      ) mismatch
    ),
    'duplicatePaymentAliases', (select count(*)
      from commerce.payment_records payment
      where payment.duplicate_payment_record
        and payment.canonical_payment_record_id is not null),
    'providerRecoveryCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.case_type = 'payment'
        and recovery.status in ('open', 'retrying')
        and not recovery.requires_reschedule),
    'rescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule and recovery.status <> 'resolved'),
    'discordRetry', jsonb_build_object(
      'pending', (select count(*) from accounts.discord_role_assignments
        where status in ('pending', 'retry', 'processing')),
      'oldestAt', (select min(updated_at) from accounts.discord_role_assignments
        where status in ('pending', 'retry', 'processing'))
    ),
    'oauthIntents', jsonb_build_object(
      'expiredPending', (select count(*) from accounts.oauth_intents
        where status = 'pending' and expires_at <= now()),
      'terminalOlderThanSevenDays', (select count(*) from accounts.oauth_intents
        where status in ('completed', 'failed', 'expired', 'replaced')
          and updated_at < now() - interval '7 days')
    )
  );
$$;

revoke all on function public.roo_apply_document_mutations(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_claim_document_mutation_mirror_events(uuid, integer, integer, text[])
  from public, anon, authenticated;
revoke all on function public.roo_complete_document_mutation_mirror_event(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.roo_requeue_document_mutation_mirror_event(uuid, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_document_mutation_mirror_backlog()
  from public, anon, authenticated;
revoke all on function public.roo_document_mutation_mirror_status_for_ids(text[])
  from public, anon, authenticated;
revoke all on function public.roo_supabase_port_readiness()
  from public, anon, authenticated;

grant execute on function public.roo_apply_document_mutations(jsonb)
  to service_role;
grant execute on function public.roo_claim_document_mutation_mirror_events(uuid, integer, integer, text[])
  to service_role;
grant execute on function public.roo_complete_document_mutation_mirror_event(uuid, uuid, boolean, text)
  to service_role;
grant execute on function public.roo_requeue_document_mutation_mirror_event(uuid, integer, text, text)
  to service_role;
grant execute on function public.roo_document_mutation_mirror_backlog()
  to service_role;
grant execute on function public.roo_document_mutation_mirror_status_for_ids(text[])
  to service_role;
grant execute on function public.roo_supabase_port_readiness()
  to service_role;

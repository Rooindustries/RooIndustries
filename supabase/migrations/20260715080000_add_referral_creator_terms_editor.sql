set lock_timeout = '5s';
set statement_timeout = '120s';

alter table accounts.creator_profiles
  add column if not exists total_basis_points integer not null default 1500,
  add column if not exists bypass_referral_requirement boolean not null default false,
  add column if not exists terms_version bigint not null default 1;

update accounts.creator_profiles creator
set
  total_basis_points = greatest(
    creator.commission_basis_points + creator.discount_basis_points,
    case
      when btrim(coalesce(source.payload->>'maxCommissionPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(
        10000,
        greatest(
          0,
          round((source.payload->>'maxCommissionPercent')::numeric * 100)::integer
        )
      )
      else creator.total_basis_points
    end
  ),
  bypass_referral_requirement = lower(
    coalesce(source.payload->>'bypassUnlock', 'false')
  ) = 'true'
from migration.source_documents source
where source.legacy_sanity_id = creator.legacy_sanity_id
  and source.document_type = 'referral'
  and not source.tombstoned;

update accounts.creator_profiles
set total_basis_points = greatest(
  total_basis_points,
  commission_basis_points + discount_basis_points
);

alter table accounts.creator_profiles
  drop constraint if exists creator_profiles_total_basis_points_check,
  drop constraint if exists creator_profiles_terms_allocation_check,
  drop constraint if exists creator_profiles_terms_version_check;

alter table accounts.creator_profiles
  add constraint creator_profiles_total_basis_points_check
    check (total_basis_points between 0 and 10000) not valid,
  add constraint creator_profiles_terms_allocation_check
    check (commission_basis_points + discount_basis_points <= total_basis_points) not valid,
  add constraint creator_profiles_terms_version_check
    check (terms_version > 0) not valid;

alter table accounts.creator_profiles
  validate constraint creator_profiles_total_basis_points_check;
alter table accounts.creator_profiles
  validate constraint creator_profiles_terms_allocation_check;
alter table accounts.creator_profiles
  validate constraint creator_profiles_terms_version_check;

create or replace function migration.normalize_new_creator_terms_total()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.total_basis_points := greatest(
    new.total_basis_points,
    new.commission_basis_points + new.discount_basis_points
  );
  return new;
end;
$$;

drop trigger if exists creator_profiles_normalize_inserted_terms
  on accounts.creator_profiles;
create trigger creator_profiles_normalize_inserted_terms
  before insert on accounts.creator_profiles
  for each row execute function migration.normalize_new_creator_terms_total();

revoke all on function migration.normalize_new_creator_terms_total()
  from public, anon, authenticated, service_role;

create table if not exists accounts.creator_terms_audit (
  id uuid primary key default gen_random_uuid(),
  command_id text not null unique,
  creator_user_id uuid not null references accounts.creator_profiles(user_id),
  actor text not null check (actor in ('ref_admin_key')),
  reason text not null check (char_length(reason) between 3 and 500),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  old_terms jsonb not null,
  new_terms jsonb not null,
  source_revision text not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(old_terms) = 'object'),
  check (jsonb_typeof(new_terms) = 'object')
);

create index if not exists creator_terms_audit_creator_created_idx
  on accounts.creator_terms_audit (creator_user_id, created_at desc);

alter table accounts.creator_terms_audit enable row level security;
revoke all on table accounts.creator_terms_audit
  from public, anon, authenticated, service_role;

create or replace function migration.reject_creator_terms_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'creator terms audit rows are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists creator_terms_audit_immutable
  on accounts.creator_terms_audit;
create trigger creator_terms_audit_immutable
  before update or delete on accounts.creator_terms_audit
  for each row execute function migration.reject_creator_terms_audit_mutation();

revoke all on function migration.reject_creator_terms_audit_mutation()
  from public, anon, authenticated, service_role;

create or replace function migration.referral_commerce_patch(p_payload jsonb)
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
    'currentCommissionPercent',
    'currentDiscountPercent',
    'maxCommissionPercent',
    'bypassUnlock',
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

create or replace function public.roo_project_referral_account_shadow(
  p_legacy_sanity_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_creators integer := 0;
begin
  update accounts.creator_profiles creator set
    referral_code = coalesce(
      nullif(lower(btrim(source.payload#>>'{slug,current}')), ''), creator.referral_code
    ),
    paypal_email = nullif(lower(btrim(source.payload->>'paypalEmail')), ''),
    contact_discord = nullif(source.payload->>'contactDiscord', ''),
    commission_basis_points = case
      when btrim(coalesce(source.payload->>'currentCommissionPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(10000, greatest(0,
        round((source.payload->>'currentCommissionPercent')::numeric * 100)::integer
      ))
      else creator.commission_basis_points
    end,
    discount_basis_points = case
      when btrim(coalesce(source.payload->>'currentDiscountPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(10000, greatest(0,
        round((source.payload->>'currentDiscountPercent')::numeric * 100)::integer
      ))
      else creator.discount_basis_points
    end,
    total_basis_points = greatest(
      case
        when btrim(coalesce(source.payload->>'maxCommissionPercent', ''))
          ~ '^[0-9]+([.][0-9]+)?$'
        then least(10000, greatest(0,
          round((source.payload->>'maxCommissionPercent')::numeric * 100)::integer
        ))
        else creator.total_basis_points
      end,
      case
        when btrim(coalesce(source.payload->>'currentCommissionPercent', ''))
          ~ '^[0-9]+([.][0-9]+)?$'
        then least(10000, greatest(0,
          round((source.payload->>'currentCommissionPercent')::numeric * 100)::integer
        ))
        else creator.commission_basis_points
      end +
      case
        when btrim(coalesce(source.payload->>'currentDiscountPercent', ''))
          ~ '^[0-9]+([.][0-9]+)?$'
        then least(10000, greatest(0,
          round((source.payload->>'currentDiscountPercent')::numeric * 100)::integer
        ))
        else creator.discount_basis_points
      end
    ),
    bypass_referral_requirement = case
      when lower(btrim(coalesce(source.payload->>'bypassUnlock', '')))
        in ('true', 'false')
      then lower(btrim(source.payload->>'bypassUnlock')) = 'true'
      else creator.bypass_referral_requirement
    end,
    successful_referrals = case
      when btrim(coalesce(source.payload->>'successfulReferrals', '')) ~ '^[0-9]+$'
      then least(
        2147483647::numeric,
        (source.payload->>'successfulReferrals')::numeric
      )::integer
      else creator.successful_referrals
    end,
    payout_details = jsonb_build_object(
      'paypal_email', nullif(lower(btrim(source.payload->>'paypalEmail')), '')
    ),
    accounting_totals = jsonb_build_object(
      'earned_total', coalesce(source.payload->'earnedTotal', '0'::jsonb),
      'owed_total', coalesce(source.payload->'owedTotal', '0'::jsonb),
      'paid_total', coalesce(source.payload->'paidTotal', '0'::jsonb),
      'earned_vertex', coalesce(source.payload->'earnedVertex', '0'::jsonb),
      'earned_xoc', coalesce(source.payload->'earnedXoc', '0'::jsonb),
      'owed_vertex', coalesce(source.payload->'owedVertex', '0'::jsonb),
      'owed_xoc', coalesce(source.payload->'owedXoc', '0'::jsonb),
      'paid_vertex', coalesce(source.payload->'paidVertex', '0'::jsonb),
      'paid_xoc', coalesce(source.payload->'paidXoc', '0'::jsonb)
    ),
    active = not source.tombstoned
      and lower(coalesce(source.payload->>'active', 'true')) <> 'false',
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    backend_owner = source.backend_owner,
    updated_at = now()
  from migration.source_documents source
  where creator.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_creators = row_count;
  return jsonb_build_object('profiles', 0, 'creator_profiles', v_creators);
end;
$$;

create or replace function public.roo_admin_list_creator_terms(
  p_search text default '',
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_result jsonb;
begin
  if char_length(v_search) > 100 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;
  if coalesce(p_offset, -1) < 0 or p_offset > 1000000 then
    raise exception 'offset must be between 0 and 1000000' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(rows) order by rows.referral_code), '[]'::jsonb)
  into v_result
  from (
    select
      creator.user_id as creator_id,
      creator.referral_code,
      coalesce(nullif(source.payload->>'name', ''), creator.referral_code) as name,
      nullif(lower(btrim(source.payload->>'creatorEmail')), '') as creator_email,
      creator.successful_referrals,
      creator.total_basis_points,
      creator.commission_basis_points,
      creator.discount_basis_points,
      creator.bypass_referral_requirement,
      creator.terms_version,
      creator.active,
      creator.source_revision,
      creator.updated_at
    from accounts.creator_profiles creator
    left join migration.source_documents source
      on source.legacy_sanity_id = creator.legacy_sanity_id
      and source.document_type = 'referral'
      and not source.tombstoned
    where creator.active
      and (
        v_search = ''
        or lower(creator.referral_code) like '%' || v_search || '%'
        or lower(coalesce(source.payload->>'name', '')) like '%' || v_search || '%'
        or lower(coalesce(source.payload->>'creatorEmail', '')) like '%' || v_search || '%'
      )
    order by creator.referral_code
    limit p_limit
    offset p_offset
  ) rows;
  return v_result;
end;
$$;

create or replace function public.roo_admin_creator_terms_history(
  p_creator_id uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if p_creator_id is null then
    raise exception 'creator id is required' using errcode = '22023';
  end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(rows) order by rows.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select id, command_id, reason, old_terms, new_terms, source_revision, created_at
    from accounts.creator_terms_audit
    where creator_user_id = p_creator_id
    order by created_at desc
    limit p_limit
  ) rows;
  return v_result;
end;
$$;

create or replace function public.roo_admin_update_creator_terms(
  p_command_id text,
  p_creator_id uuid,
  p_expected_version bigint,
  p_total_basis_points integer,
  p_commission_basis_points integer,
  p_discount_basis_points integer,
  p_bypass_referral_requirement boolean,
  p_reason text,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command_id text := btrim(coalesce(p_command_id, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_request_hash text;
  v_existing accounts.creator_terms_audit%rowtype;
  v_creator accounts.creator_profiles%rowtype;
  v_updated accounts.creator_profiles%rowtype;
  v_source migration.source_documents%rowtype;
  v_starts_paused boolean;
  v_old_terms jsonb;
  v_new_terms jsonb;
  v_apply_result jsonb;
begin
  if v_command_id !~ '^[A-Za-z0-9._:-]{8,120}$' then
    raise exception 'invalid command id' using errcode = '22023';
  end if;
  if p_creator_id is null or coalesce(p_expected_version, 0) < 1 then
    raise exception 'creator id and expected version are required' using errcode = '22023';
  end if;
  if p_total_basis_points is null
    or p_commission_basis_points is null
    or p_discount_basis_points is null
    or p_bypass_referral_requirement is null
    or p_total_basis_points not between 0 and 10000
    or p_commission_basis_points not between 0 and 10000
    or p_discount_basis_points not between 0 and 10000
    or p_commission_basis_points + p_discount_basis_points > p_total_basis_points then
    raise exception 'invalid creator terms allocation' using errcode = '22023';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'reason must be between 3 and 500 characters' using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'creator_id', p_creator_id,
    'expected_version', p_expected_version,
    'total_basis_points', p_total_basis_points,
    'commission_basis_points', p_commission_basis_points,
    'discount_basis_points', p_discount_basis_points,
    'bypass_referral_requirement', p_bypass_referral_requirement,
    'reason', v_reason,
    'cutover_generation', p_cutover_generation
  )::text, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-terms:' || v_command_id, 0)
  );

  select * into v_existing
  from accounts.creator_terms_audit
  where command_id = v_command_id;
  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'command id was reused with different input' using errcode = '23505';
    end if;
    return v_existing.new_terms || jsonb_build_object(
      'command_id', v_existing.command_id,
      'source_revision', v_existing.source_revision,
      'updated_at', v_existing.created_at,
      'replayed', true
    );
  end if;

  select starts_paused into v_starts_paused
  from migration.commerce_control
  where singleton
  for share;
  if not found then
    raise exception 'commerce control is unavailable' using errcode = '55000';
  end if;
  if v_starts_paused then
    raise exception 'creator terms writes are paused' using errcode = '55006';
  end if;

  select * into v_creator
  from accounts.creator_profiles
  where user_id = p_creator_id
  for update;
  if not found or not v_creator.active then
    raise exception 'creator not found' using errcode = 'P0002';
  end if;
  if v_creator.terms_version <> p_expected_version then
    raise exception 'creator terms version conflict' using errcode = '40001';
  end if;
  if nullif(btrim(coalesce(v_creator.legacy_sanity_id, '')), '') is null then
    raise exception 'creator fallback identity is missing' using errcode = '55000';
  end if;

  select * into v_source
  from migration.source_documents
  where legacy_sanity_id = v_creator.legacy_sanity_id
    and document_type = 'referral'
    and not tombstoned
  for update;
  if not found then
    raise exception 'creator fallback document is missing' using errcode = '55000';
  end if;

  v_old_terms := jsonb_build_object(
    'creator_id', v_creator.user_id,
    'total_basis_points', v_creator.total_basis_points,
    'commission_basis_points', v_creator.commission_basis_points,
    'discount_basis_points', v_creator.discount_basis_points,
    'bypass_referral_requirement', v_creator.bypass_referral_requirement,
    'terms_version', v_creator.terms_version
  );

  v_apply_result := public.roo_apply_commerce_document_mutations(
    'referral-terms:' || v_command_id,
    jsonb_build_array(jsonb_build_object(
      'operation', 'replace',
      'document', v_source.payload || jsonb_build_object(
        'maxCommissionPercent', p_total_basis_points::numeric / 100,
        'currentCommissionPercent', p_commission_basis_points::numeric / 100,
        'currentDiscountPercent', p_discount_basis_points::numeric / 100,
        'bypassUnlock', p_bypass_referral_requirement
      ),
      'expected_revision', v_source.source_revision
    )),
    p_cutover_generation
  );

  update accounts.creator_profiles
  set terms_version = v_creator.terms_version + 1,
      updated_at = now()
  where user_id = p_creator_id
  returning * into v_updated;

  select * into v_source
  from migration.source_documents
  where legacy_sanity_id = v_creator.legacy_sanity_id;

  v_new_terms := jsonb_build_object(
    'creator_id', v_updated.user_id,
    'legacy_sanity_id', v_updated.legacy_sanity_id,
    'total_basis_points', v_updated.total_basis_points,
    'commission_basis_points', v_updated.commission_basis_points,
    'discount_basis_points', v_updated.discount_basis_points,
    'bypass_referral_requirement', v_updated.bypass_referral_requirement,
    'terms_version', v_updated.terms_version,
    'mirror_event_key', v_apply_result->>'event_key'
  );

  insert into accounts.creator_terms_audit (
    command_id,
    creator_user_id,
    actor,
    reason,
    request_hash,
    old_terms,
    new_terms,
    source_revision
  ) values (
    v_command_id,
    p_creator_id,
    'ref_admin_key',
    v_reason,
    v_request_hash,
    v_old_terms,
    v_new_terms,
    v_source.source_revision
  );

  return v_new_terms || jsonb_build_object(
    'command_id', v_command_id,
    'source_revision', v_source.source_revision,
    'updated_at', now(),
    'replayed', false
  );
end;
$$;

revoke all on function public.roo_admin_list_creator_terms(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.roo_admin_creator_terms_history(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.roo_admin_update_creator_terms(
  text, uuid, bigint, integer, integer, integer, boolean, text, integer
) from public, anon, authenticated;
revoke all on function public.roo_project_referral_account_shadow(text[])
  from public, anon, authenticated;

grant execute on function public.roo_admin_list_creator_terms(text, integer, integer)
  to service_role;
grant execute on function public.roo_admin_creator_terms_history(uuid, integer)
  to service_role;
grant execute on function public.roo_admin_update_creator_terms(
  text, uuid, bigint, integer, integer, integer, boolean, text, integer
) to service_role;
grant execute on function public.roo_project_referral_account_shadow(text[])
  to service_role;

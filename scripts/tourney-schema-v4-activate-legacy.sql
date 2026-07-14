set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
declare
  v_primary_backend text;
  v_generation integer;
  v_writes_paused boolean;
  v_fallback_read_only boolean;
  v_expanded_version integer;
begin
  select primary_backend, generation, writes_paused, fallback_read_only
  into v_primary_backend, v_generation, v_writes_paused, v_fallback_read_only
  from public.tourney_cutover_metadata
  where id = 'tourney'
  for share;
  select expanded_version into v_expanded_version
  from public.tourney_schema_metadata
  where schema_name = 'tourney';
  if v_primary_backend is null
     or v_primary_backend <> 'supabase'
     or v_generation <> 1
     or not v_writes_paused
     or v_fallback_read_only
     or coalesce(v_expanded_version, 0) < 4
     or to_regclass('public.tourney_mirror_contracts') is null
     or to_regclass('public.tourney_account_snapshots') is null
     or to_regprocedure('public.digest(bytea,text)') is null then
    raise exception 'Legacy Tourney activation safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
end;
$$;

create index if not exists tourney_account_snapshots_supersedes_v4_idx
  on tourney_account_snapshots (supersedes_snapshot_id)
  where supersedes_snapshot_id is not null;

create or replace function public.tourney_mirror_record_key(p_table_name text, p_row jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_contract public.tourney_mirror_contracts%rowtype; v_column text; v_key jsonb := '{}'::jsonb;
begin
  select * into v_contract from public.tourney_mirror_contracts
  where logical_table = p_table_name and enabled;
  if not found then raise exception 'Tourney mirror contract is not registered' using errcode='22023'; end if;
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'Tourney mirror row is invalid' using errcode='22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_row) supplied(column_name)
    where not supplied.column_name = any(v_contract.allowed_columns)) then
    raise exception 'Tourney mirror row contains unsupported columns' using errcode='22023';
  end if;
  foreach v_column in array v_contract.key_columns loop
    if not (p_row ? v_column) or p_row->v_column is null
       or p_row->v_column = 'null'::jsonb or btrim(p_row->>v_column) = '' then
      raise exception 'Tourney mirror key is incomplete' using errcode='23502';
    end if;
    v_key := v_key || jsonb_build_object(v_column,p_row->v_column);
  end loop;
  return v_key;
end;
$$;

create or replace function public.capture_tourney_mirror_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_row jsonb := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_command_id text := nullif(current_setting('roo.tourney_command_id',true),'');
  v_meta public.tourney_cutover_metadata%rowtype;
  v_logical_table text; v_key jsonb; v_data jsonb := case when tg_op='DELETE' then null else v_row end;
  v_hash text;
begin
  if current_setting('roo.tourney_mirror_apply',true)='1' then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  select * into v_meta from public.tourney_cutover_metadata
  where id='tourney' for share;
  if v_meta.id is null or not v_meta.hardened_active
     or v_meta.primary_backend <> 'legacy' or v_meta.generation < 1 then
    raise exception 'Tourney mirror source authority is invalid' using errcode='55000';
  end if;
  if v_command_id is null or pg_catalog.length(v_command_id) not between 3 and 512
     or v_command_id ~ '[[:cntrl:]]' then
    raise exception 'Tourney mirror command context is required' using errcode='22023';
  end if;
  select logical_table into v_logical_table from public.tourney_mirror_contracts
  where legacy_relation=tg_table_name and enabled;
  if v_logical_table is null then raise exception 'Tourney mirror relation is not registered' using errcode='22023'; end if;
  v_key := public.tourney_mirror_record_key(v_logical_table,v_row);
  v_hash := case when v_data is null then null else
    pg_catalog.encode(public.digest(pg_catalog.convert_to(v_data::text,'UTF8'),'sha256'),'hex') end;
  insert into public.tourney_mirror_outbox (
    command_id,source_backend,generation,table_name,operation,record_key,
    record_data,record_hash,status
  ) values (
    v_command_id,'legacy',v_meta.generation,v_logical_table,
    case when tg_op='DELETE' then 'delete' else 'upsert' end,
    v_key,v_data,v_hash,'pending'
  );
  if tg_op='DELETE' then return old; end if; return new;
end;
$$;

do $$
begin
  if exists (
    with expected(logical_table,supabase_relation,legacy_relation,key_columns) as (
      values
        ('tourney_players','tourney.tourney_players','tourney_players',array['id']::text[]),
        ('tourney_player_tokens','tourney.tourney_player_tokens','tourney_player_tokens',array['id']::text[]),
        ('tourney_registration_config','tourney.tourney_registration_config','tourney_registration_config',array['id']::text[]),
        ('tourney_bracket_teams','tourney.tourney_bracket_teams','tourney_bracket_teams',array['id']::text[]),
        ('tourney_bracket_team_members','tourney.tourney_bracket_team_members','tourney_bracket_team_members',array['id']::text[]),
        ('tourney_bracket_meta','tourney.tourney_bracket_meta','tourney_bracket_meta',array['id']::text[]),
        ('tourney_bracket_entities','tourney.tourney_bracket_entities','tourney_bracket_entities',array['entity_type','entity_id']::text[]),
        ('tourney_bracket_counters','tourney.tourney_bracket_counters','tourney_bracket_counters',array['entity_type']::text[]),
        ('tourney_bracket_audit','tourney.tourney_bracket_audit','tourney_bracket_audit',array['id']::text[]),
        ('tourney_bracket_lock','tourney.tourney_bracket_lock','tourney_bracket_lock',array['id']::text[]),
        ('tourney_appeals','tourney.tourney_appeals','tourney_appeals',array['id']::text[]),
        ('tourney_payouts','tourney.tourney_payouts','tourney_payouts',array['id']::text[]),
        ('email_dispatches','tourney.email_dispatches','tourney_email_dispatches',array['id']::text[]),
        ('command_receipts','tourney.command_receipts','tourney_command_receipts',array['command_id']::text[]),
        ('account_snapshots','tourney.account_snapshots','tourney_account_snapshots',array['snapshot_id']::text[]),
        ('external_operations','tourney.external_operations','tourney_external_operations',array['operation_key']::text[]),
        ('discord_role_assignments','accounts.discord_role_assignments','tourney_discord_role_assignments',array['principal_id']::text[])
    )
    select 1 from expected
    full join public.tourney_mirror_contracts contract using(logical_table)
    where expected.logical_table is null or contract.logical_table is null
       or not contract.enabled
       or contract.supabase_relation is distinct from expected.supabase_relation
       or contract.legacy_relation is distinct from expected.legacy_relation
       or contract.key_columns is distinct from expected.key_columns
       or contract.allowed_columns is distinct from (
         select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
         from pg_catalog.pg_attribute attribute
         where attribute.attrelid = expected.legacy_relation::regclass
           and attribute.attnum > 0 and not attribute.attisdropped
       )
  ) then
    raise exception 'Legacy Tourney mirror registry is incomplete or stale'
      using errcode='55000';
  end if;
end;
$$;

do $$ declare v_contract record;
begin
  for v_contract in select logical_table,legacy_relation from public.tourney_mirror_contracts where enabled loop
    execute format('drop trigger if exists capture_tourney_mirror_event on %s',v_contract.legacy_relation::regclass);
    execute format('create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function public.capture_tourney_mirror_event()',v_contract.legacy_relation::regclass);
  end loop;
end;
$$;

create or replace function tourney_history_uuid(p_value text)
returns uuid language sql immutable strict set search_path='' as $$
  select (substr(md5(p_value),1,8)||'-'||substr(md5(p_value),9,4)||'-4'||substr(md5(p_value),14,3)||'-8'||substr(md5(p_value),18,3)||'-'||substr(md5(p_value),21,12))::uuid
$$;

create index if not exists tourney_email_dispatches_history_v4_idx
  on tourney_email_dispatches (dispatch_kind, recipient_hash);

insert into tourney_email_dispatches(
  id,idempotency_key,command_id,dispatch_kind,recipient,recipient_hash,payload,
  status,provider_message_id,sent_at,created_at,updated_at
)
select tourney_history_uuid(candidate.key),candidate.key,candidate.command_id,
  candidate.kind,candidate.recipient,
  encode(digest(convert_to(candidate.recipient,'UTF8'),'sha256'),'hex'),
  candidate.payload,candidate.status,candidate.provider_message_id,candidate.sent_at,
  candidate.occurred_at,candidate.occurred_at
from (
  select 'history:registration:'||token.player_id||':'||lower(token.recipient_email) key,
    'history:registration:'||token.player_id command_id,'registration' kind,
    lower(token.recipient_email) recipient,jsonb_build_object('historical',true,'entityId',token.player_id,'audience','admin') payload,
    'historical_unknown' status,null::text provider_message_id,null::timestamptz sent_at,min(token.created_at) occurred_at
  from tourney_player_tokens token where token.recipient_email is not null and token.purpose in('approve','deny')
  group by token.player_id,lower(token.recipient_email)
  union all select 'history:approval:'||player.id||':'||lower(player.email),'history:approval:'||player.id,
    'approval',lower(player.email),jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),'historical_unknown',null,null,coalesce(player.approved_at,player.updated_at)
  from tourney_players player where player.status='approved'
  union all select 'history:reset:'||token.id||':'||lower(player.email),'history:reset:'||token.id,
    'reset',lower(player.email),jsonb_build_object('historical',true,'entityId',token.id,'audience','player'),'historical_unknown',null,null,token.created_at
  from tourney_player_tokens token join tourney_players player on player.id=token.player_id
  where token.purpose='reset'
  union all select 'history:discord_invite:'||player.id||':'||lower(player.email),'history:discord_invite:'||player.id,
    'discord_invite',lower(player.email),jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),
    'sent',player.discord_invite_email_id,player.discord_invite_sent_at,player.discord_invite_sent_at
  from tourney_players player where player.discord_invite_sent_at is not null
  union all select 'history:appeal:'||appeal.id||':'||lower(player.email),'history:appeal:'||appeal.id,
    'appeal',lower(player.email),jsonb_build_object('historical',true,'entityId',appeal.id,'audience','submitter'),'historical_unknown',null,null,appeal.created_at
  from tourney_appeals appeal join tourney_players player on player.id=appeal.submitter_player_id
  union all select 'history:payout:'||payout.id||':'||payout.status||':'||lower(payout.payout_email),
    'history:payout:'||payout.id||':'||payout.status,'payout',lower(payout.payout_email),
    jsonb_build_object('historical',true,'entityId',payout.id,'audience',payout.status),'historical_unknown',null,null,payout.updated_at
  from tourney_payouts payout where payout.status in('ready','paid','void') and payout.payout_email is not null
) candidate
where candidate.recipient<>'' and not exists(
  select 1 from tourney_email_dispatches existing
  where existing.dispatch_kind=candidate.kind
    and existing.recipient_hash=encode(digest(convert_to(candidate.recipient,'UTF8'),'sha256'),'hex')
    and coalesce(
      existing.payload->>'entityId',
      existing.payload#>>'{player,id}',
      existing.payload#>>'{appeal,id}',
      existing.payload#>>'{payout,id}'
    )=candidate.payload->>'entityId'
    and coalesce(existing.payload->>'audience','')=coalesce(candidate.payload->>'audience','')
)
on conflict(idempotency_key) do nothing;

update tourney_cutover_metadata set
  hardened_active=true,clean_since=null,first_zero_drift_at=null,
  second_zero_drift_at=null,clock_last_reset_reason='fresh_hardening_window',
  updated_at=now()
where id='tourney';
insert into tourney_cutover_gate_events(event_kind,generation,actor,evidence)
select 'hardened_activated',generation,'schema-v4-activation',jsonb_build_object('schema_version',4)
from tourney_cutover_metadata where id='tourney';
update tourney_schema_metadata set schema_version=4,expanded_version=4,updated_at=now()
where schema_name='tourney';

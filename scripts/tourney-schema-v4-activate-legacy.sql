-- Schema-v4 activation phase for legacy Neon. Apply only while writes are paused.
set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function tourney_mirror_record_key(p_table_name text, p_row jsonb)
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

create or replace function capture_tourney_mirror_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_row jsonb := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_enabled boolean := coalesce(nullif(current_setting('roo.tourney_mirror_enabled',true),''),'0') in ('1','true','on');
  v_generation integer := coalesce(nullif(current_setting('roo.tourney_generation',true),''),'0')::integer;
  v_command_id text := nullif(current_setting('roo.tourney_command_id',true),'');
  v_logical_table text; v_key jsonb; v_data jsonb := case when tg_op='DELETE' then null else v_row end;
  v_hash text;
begin
  if not v_enabled or current_setting('roo.tourney_mirror_apply',true)='1' then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  select logical_table into v_logical_table from public.tourney_mirror_contracts
  where legacy_relation=tg_table_name and enabled;
  if v_logical_table is null then raise exception 'Tourney mirror relation is not registered' using errcode='22023'; end if;
  v_key := tourney_mirror_record_key(v_logical_table,v_row);
  v_hash := case when v_data is null then null else encode(digest(convert_to(v_data::text,'UTF8'),'sha256'),'hex') end;
  insert into public.tourney_mirror_outbox (
    command_id,source_backend,generation,table_name,operation,record_key,
    record_data,record_hash,status
  ) values (
    v_command_id,'legacy',v_generation,v_logical_table,
    case when tg_op='DELETE' then 'delete' else 'upsert' end,
    v_key,v_data,v_hash,'pending'
  );
  if tg_op='DELETE' then return old; end if; return new;
end;
$$;

do $$ declare v_contract record;
begin
  for v_contract in select logical_table,legacy_relation from public.tourney_mirror_contracts where enabled loop
    execute format('drop trigger if exists capture_tourney_mirror_event on %s',v_contract.legacy_relation::regclass);
    execute format('create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function capture_tourney_mirror_event()',v_contract.legacy_relation::regclass);
  end loop;
end;
$$;

create or replace function tourney_history_uuid(p_value text)
returns uuid language sql immutable strict set search_path='' as $$
  select (substr(md5(p_value),1,8)||'-'||substr(md5(p_value),9,4)||'-4'||substr(md5(p_value),14,3)||'-8'||substr(md5(p_value),18,3)||'-'||substr(md5(p_value),21,12))::uuid
$$;

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
  select distinct 'history:registration:'||token.player_id||':'||lower(token.recipient_email) key,
    'history:registration:'||token.player_id command_id,'registration' kind,
    lower(token.recipient_email) recipient,jsonb_build_object('historical',true,'entityId',token.player_id,'audience','admin') payload,
    'historical_unknown' status,null::text provider_message_id,null::timestamptz sent_at,token.created_at occurred_at
  from tourney_player_tokens token where token.recipient_email is not null and token.purpose in('approve','deny')
  union all select 'history:approval:'||player.id||':'||lower(player.email),'history:approval:'||player.id,
    'approval',lower(player.email),jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),'historical_unknown',null,null,coalesce(player.approved_at,player.updated_at)
  from tourney_players player where player.status='approved'
  union all select 'history:reset:'||token.id||':'||lower(player.email),'history:reset:'||token.id,
    'reset',lower(player.email),jsonb_build_object('historical',true,'entityId',token.id,'audience','player'),'historical_unknown',null,null,token.used_at
  from tourney_player_tokens token join tourney_players player on player.id=token.player_id
  where token.purpose='reset' and token.used_at is not null
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

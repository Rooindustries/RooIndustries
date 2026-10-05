set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  signature text := 'public.roo_claim_commerce_mirror_events(text,integer,boolean)';
  completion_signature text := 'public.roo_complete_commerce_mirror_event(text,text,boolean,text)';
  definition text;
  completion_definition text;
  anchor text := $anchor$  with candidates as (
    select candidate.id
    from migration.commerce_mirror_outbox candidate$anchor$;
  terminal_guard text := $guard$  update migration.commerce_mirror_outbox
  set status = 'dead_letter',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS'
  where status = 'processing'
    and lease_expires_at <= now()
    and attempt_count >= 12;

$guard$;
  completion_anchor text := $anchor$  select * into v_event from migration.commerce_mirror_outbox
  where event_key = p_event_key for update;$anchor$;
  completion_guard text := $guard$  if nullif(btrim(coalesce(p_event_key, '')), '') is null
    or nullif(btrim(coalesce(p_lease_id, '')), '') is null
    or p_success is null then
    raise exception 'invalid commerce mirror completion' using errcode = '22023';
  end if;

$guard$;
begin
  if to_regclass('migration.commerce_mirror_outbox') is null
    or to_regprocedure(signature) is null
    or to_regprocedure(completion_signature) is null
    or (
      select count(*) from pg_catalog.pg_attribute
      where attrelid = to_regclass('migration.commerce_mirror_outbox')
        and not attisdropped
        and ((attname = 'status' and atttypid = 'text'::regtype and attnotnull)
          or (attname = 'attempt_count' and atttypid = 'integer'::regtype and attnotnull)
          or (attname in ('lease_id', 'last_error_code') and atttypid = 'text'::regtype and not attnotnull)
          or (attname in ('lease_expires_at', 'next_attempt_at') and atttypid = 'timestamptz'::regtype and not attnotnull))
    ) <> 6 then
    raise exception 'mirror lease migration requires the current commerce outbox contract';
  end if;
  if (
    select count(*) from pg_catalog.pg_proc
    where oid in (to_regprocedure(signature), to_regprocedure(completion_signature))
      and prosecdef and proconfig @> array['search_path=""']::text[]
  ) <> 2 or position(
    $bound$case when attempt_count >= 12 then 'dead_letter'$bound$
    in pg_get_functiondef(to_regprocedure(completion_signature))
  ) = 0 then
    raise exception 'mirror lease migration requires the existing twelve-attempt completion bound';
  end if;

  definition := pg_get_functiondef(to_regprocedure(signature));
  completion_definition := pg_get_functiondef(to_regprocedure(completion_signature));
  if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor)
    or position(terminal_guard in definition) <> 0
    or (length(completion_definition) - length(replace(completion_definition, completion_anchor, ''))) <> length(completion_anchor)
    or position(completion_guard in completion_definition) <> 0 then
    raise exception 'mirror lease migration: unexpected current claim contract anchor';
  end if;
  execute replace(definition, anchor, terminal_guard || anchor);
  execute replace(completion_definition, completion_anchor, completion_guard || completion_anchor);
end;
$migration$;

notify pgrst, 'reload schema';

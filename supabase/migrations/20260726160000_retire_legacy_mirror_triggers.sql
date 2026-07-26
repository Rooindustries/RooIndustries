set lock_timeout = '5s';
set statement_timeout = '120s';

-- Neon retirement, step 1 of 2 in the database.
--
-- The legacy Neon project (roo-tourney-production) exhausted its 5 GB monthly
-- network-transfer allowance on 2026-07-21, so every mirror delivery to it has
-- failed since. Nothing reads that backend: every user-facing route resolves
-- policy.primaryBackend, which is 'supabase', and the only legacy readers are two
-- admin/cron endpoints behind REF_ADMIN_KEY. Supabase is authoritative.
--
-- Order matters. tourney.capture_mirror_event_v4 raises when a table has no
-- enabled row in tourney.mirror_contracts:
--
--   raise exception 'Tourney mirror relation is not registered' using errcode = '22023'
--
-- so disabling the contracts while the triggers are still attached would abort
-- every insert and update on the tourney tables -- registrations, sessions,
-- approvals, payouts. The triggers therefore have to be detached first, in this
-- migration, before 20260726160500 disables the contracts.
--
-- The outbox itself is left intact. tourney.mirror_outbox keeps its 4,927 applied
-- rows plus the 15 undelivered ones as an audit trail, and the capture function is
-- left in place so the change is reversible by re-creating the triggers.

do $$
declare
  v_relation text;
begin
  for v_relation in
    select n.nspname || '.' || c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tourney'
      and not t.tgisinternal
      and t.tgname = 'capture_tourney_mirror_event'
    order by 1
  loop
    execute format(
      'drop trigger if exists capture_tourney_mirror_event on %s', v_relation
    );
  end loop;
end;
$$;

-- Fail the migration rather than half-retiring the mirror.
do $$
declare
  v_remaining integer;
begin
  select count(*) into v_remaining
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'tourney'
    and not t.tgisinternal
    and t.tgname = 'capture_tourney_mirror_event';
  if v_remaining <> 0 then
    raise exception 'Mirror capture triggers remain attached: %', v_remaining;
  end if;
end;
$$;

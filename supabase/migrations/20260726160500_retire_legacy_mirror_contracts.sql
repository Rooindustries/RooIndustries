set lock_timeout = '5s';
set statement_timeout = '120s';

-- Neon retirement, step 2 of 2 in the database. Requires 20260726160000, which
-- detached tourney.capture_mirror_event_v4 from every tourney table. With the
-- triggers gone nothing consults tourney.mirror_contracts on the write path, so
-- disabling the rows can no longer abort a registration or a session write.
--
-- The rows are disabled rather than deleted: several readiness and snapshot RPCs
-- select from this table (`from tourney.mirror_contracts where enabled`), and they
-- should see an empty enabled set rather than fail on a missing relation. Keeping
-- the rows also makes the retirement reversible -- flip enabled back to true and
-- re-create the triggers.

update tourney.mirror_contracts
   set enabled = false,
       updated_at = now()
 where enabled;

do $$
declare
  v_enabled integer;
begin
  select count(*) into v_enabled from tourney.mirror_contracts where enabled;
  if v_enabled <> 0 then
    raise exception 'Mirror contracts remain enabled: %', v_enabled;
  end if;
end;
$$;

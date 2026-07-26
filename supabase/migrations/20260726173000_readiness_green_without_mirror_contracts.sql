set lock_timeout = '5s';
set statement_timeout = '120s';

-- Readiness could not return green after the Neon retirement.
--
-- tourney.mirror_trigger_binding_status_v4 asserted `summary.enabled_contracts = 17`,
-- a literal count of the contracts that existed when the mirror was live.
-- 20260726160500 disabled all 17 on purpose, so the function reports
--
--   {"ready": false, "enabled_contracts": 0, "correctly_bound": 0, "drifted_tables": []}
--
-- and no amount of correct configuration can clear it. `ready:false` with an empty
-- drift list is worse than noise: the one signal that is supposed to distinguish
-- "healthy" from "a trigger has come loose" is stuck on the alarming value, so a real
-- drift would land in an alert nobody can act on.
--
-- The replacement asserts what the check is actually for: every contract that is
-- enabled is correctly bound. At 17 enabled that is the same condition as before. At
-- zero enabled it is vacuously satisfied, which is the correct reading of "nothing is
-- mirrored, so nothing can be mis-bound". Re-enabling a contract without its trigger
-- still turns this red, so the retirement stays reversible under a live check.
--
-- The function-integrity checks are deliberately kept. 20260726160000 detached the
-- triggers but left tourney.capture_mirror_event_v4 in place, so its body hash,
-- security_definer, return type, language and empty search_path remain verifiable
-- facts. Dropping them would leave a re-enable silently trusting a function that may
-- have been altered in the meantime.
--
-- `contract_version` is bumped so an operator reading a cached response can tell which
-- rule produced it.

create or replace function tourney.mirror_trigger_binding_status_v4()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with function_state as (
    select function.oid,
      pg_catalog.md5(function.prosrc) = '1be94fec31148130bf7137c33dc45d52' body_matches,
      function.prosecdef security_definer,
      function.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype returns_trigger,
      language.lanname = 'plpgsql' language_matches,
      exists(
        select 1 from pg_catalog.unnest(coalesce(function.proconfig, '{}'::text[])) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
          and pg_catalog.replace(pg_catalog.split_part(setting, '=', 2), '"', '') = ''
      ) empty_search_path,
      pg_catalog.md5(function.prosrc) body_hash
    from pg_catalog.pg_proc function
    join pg_catalog.pg_language language on language.oid = function.prolang
    where function.oid = pg_catalog.to_regprocedure('tourney.capture_mirror_event_v4()')
  ), bindings as (
    select contract.logical_table,
      contract.supabase_relation::pg_catalog.regclass relation_oid,
      trigger.oid trigger_oid,
      trigger.tgfoid,
      trigger.tgtype,
      trigger.tgenabled,
      trigger.tgisinternal
    from tourney.mirror_contracts contract
    left join pg_catalog.pg_trigger trigger
      on trigger.tgrelid = contract.supabase_relation::pg_catalog.regclass
     and trigger.tgname = 'capture_tourney_mirror_event'
    where contract.enabled
  ), summary as (
    select pg_catalog.count(*)::integer enabled_contracts,
      pg_catalog.count(*) filter(
        where binding.trigger_oid is not null
          and binding.tgfoid = function_state.oid
          and binding.tgtype = 29
          and binding.tgenabled = 'O'
          and not binding.tgisinternal
      )::integer correctly_bound,
      coalesce(
        pg_catalog.jsonb_agg(binding.logical_table order by binding.logical_table)
          filter(where binding.trigger_oid is null
            or binding.tgfoid is distinct from function_state.oid
            or binding.tgtype <> 29
            or binding.tgenabled <> 'O'
            or binding.tgisinternal),
        '[]'::jsonb
      ) drifted_tables
    from bindings binding
    cross join function_state
  )
  select pg_catalog.jsonb_build_object(
    'ready', coalesce(
      function_state.body_matches
      and function_state.security_definer
      and function_state.returns_trigger
      and function_state.language_matches
      and function_state.empty_search_path
      -- Every enabled contract is bound, whatever the number of them is. Zero enabled
      -- contracts is the retired state and satisfies this; a partially bound set does
      -- not, and names the offenders in drifted_tables.
      and summary.correctly_bound = summary.enabled_contracts
      and pg_catalog.jsonb_array_length(summary.drifted_tables) = 0,
      false
    ),
    'contract_version', 'v4-optional-contracts-20260726',
    'enabled_contracts', coalesce(summary.enabled_contracts, 0),
    'correctly_bound', coalesce(summary.correctly_bound, 0),
    'drifted_tables', coalesce(summary.drifted_tables, '[]'::jsonb),
    'function_oid', function_state.oid,
    'function_body_hash', function_state.body_hash,
    'function_body_matches', coalesce(function_state.body_matches, false),
    'security_definer', coalesce(function_state.security_definer, false),
    'empty_search_path', coalesce(function_state.empty_search_path, false)
  )
  from summary
  full join function_state on true
$$;

-- Prove the new rule against the live database before this migration commits: the
-- retired state must read green, and it must do so without contracts or drift.
do $$
declare
  v_status jsonb;
  v_enabled integer;
begin
  select count(*) into v_enabled from tourney.mirror_contracts where enabled;
  v_status := tourney.mirror_trigger_binding_status_v4();

  if (v_status->>'contract_version') <> 'v4-optional-contracts-20260726' then
    raise exception 'Unexpected mirror readiness contract version: %',
      v_status->>'contract_version';
  end if;

  if (v_status->>'enabled_contracts')::integer <> v_enabled then
    raise exception 'Readiness reported % enabled contracts, table holds %',
      v_status->>'enabled_contracts', v_enabled;
  end if;

  if jsonb_array_length(v_status->'drifted_tables') <> 0 then
    raise exception 'Mirror bindings have drifted: %', v_status->'drifted_tables';
  end if;

  if (v_status->>'ready')::boolean is not true then
    raise exception 'Mirror readiness is still not green: %', v_status::text;
  end if;
end;
$$;

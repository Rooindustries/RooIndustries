set lock_timeout = '5s';
set statement_timeout = '30s';

-- A stale cutover generation is a deterministic conflict. SQLSTATE 40001 is
-- reserved for serialization failures and may be retried automatically by
-- transaction gateways, turning one rejected mutation into an unbounded loop.
create or replace function migration.assert_commerce_write_fence(
  p_generation integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control migration.commerce_control%rowtype;
begin
  select * into v_control
  from migration.commerce_control
  where singleton
  for share;

  if not found or v_control.primary_backend <> 'supabase' then
    raise exception 'Supabase is not the authoritative commerce writer'
      using errcode = '55000';
  end if;

  if coalesce(p_generation, -1) <> v_control.generation then
    raise exception 'Commerce generation is stale'
      using errcode = 'PT409';
  end if;
end;
$$;

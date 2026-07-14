-- Add durable, independent idempotency markers for write-pause and write-resume
-- operations. The containing control table is private and RLS-protected.
alter table tourney.cutover_metadata
  add column if not exists last_pause_operation_id text,
  add column if not exists last_resume_operation_id text;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'tourney.cutover_metadata'::pg_catalog.regclass
      and conname = 'cutover_metadata_last_pause_operation_id_check'
  ) then
    alter table tourney.cutover_metadata
      add constraint cutover_metadata_last_pause_operation_id_check check (
        last_pause_operation_id is null or (
          last_pause_operation_id = pg_catalog.btrim(last_pause_operation_id)
          and pg_catalog.char_length(last_pause_operation_id) between 8 and 128
          and last_pause_operation_id ~ '^[a-z0-9][a-z0-9:_-]{7,127}$'
        )
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'tourney.cutover_metadata'::pg_catalog.regclass
      and conname = 'cutover_metadata_last_resume_operation_id_check'
  ) then
    alter table tourney.cutover_metadata
      add constraint cutover_metadata_last_resume_operation_id_check check (
        last_resume_operation_id is null or (
          last_resume_operation_id = pg_catalog.btrim(last_resume_operation_id)
          and pg_catalog.char_length(last_resume_operation_id) between 8 and 128
          and last_resume_operation_id ~ '^[a-z0-9][a-z0-9:_-]{7,127}$'
        )
      ) not valid;
  end if;
end;
$$;

alter table tourney.cutover_metadata
  validate constraint cutover_metadata_last_pause_operation_id_check;
alter table tourney.cutover_metadata
  validate constraint cutover_metadata_last_resume_operation_id_check;

create table if not exists tourney.cutover_control_operations (
  operation_kind text not null
    check (operation_kind in ('pause', 'resume')),
  operation_id text not null
    check (operation_id ~ '^[a-z0-9][a-z0-9:_-]{7,127}$'),
  primary_backend text not null
    check (primary_backend in ('legacy', 'supabase')),
  generation integer not null check (generation between 0 and 100),
  target_writes_paused boolean not null,
  actor text not null check (
    actor = pg_catalog.btrim(actor)
    and pg_catalog.char_length(actor) between 3 and 200
    and actor !~ '[[:cntrl:]]'
  ),
  applied_at timestamptz not null default pg_catalog.now(),
  primary key (operation_kind, operation_id),
  check (target_writes_paused = (operation_kind = 'pause'))
);

create or replace function tourney.guard_cutover_control_operation_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('roo.tourney_cutover_compensation', true) = '1' then
    return old;
  end if;
  raise exception 'Tourney cutover control operations are append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists guard_cutover_control_operation_append_only
  on tourney.cutover_control_operations;
create trigger guard_cutover_control_operation_append_only
before update or delete on tourney.cutover_control_operations
for each row execute function tourney.guard_cutover_control_operation_append_only();

alter table tourney.cutover_metadata enable row level security;
revoke all on table tourney.cutover_metadata from public, anon, authenticated;
grant all on table tourney.cutover_metadata to service_role;

alter table tourney.cutover_control_operations enable row level security;
revoke all on table tourney.cutover_control_operations
  from public, anon, authenticated;
grant select, insert on table tourney.cutover_control_operations to service_role;
revoke all on function tourney.guard_cutover_control_operation_append_only()
  from public, anon, authenticated, service_role;

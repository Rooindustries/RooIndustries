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

alter table tourney.cutover_metadata enable row level security;
revoke all on table tourney.cutover_metadata from public, anon, authenticated;
grant all on table tourney.cutover_metadata to service_role;

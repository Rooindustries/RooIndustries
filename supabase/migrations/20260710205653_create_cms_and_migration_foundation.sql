
create table cms.documents (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text not null unique,
  document_type text not null,
  slug text,
  title text,
  publication_status text not null default 'published'
    check (publication_status in ('draft', 'published', 'archived')),
  payload jsonb not null,
  content_hash text not null,
  source_revision text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (content_hash ~ '^[0-9a-f]{64}$')
);

create unique index cms_documents_type_slug_key
  on cms.documents (document_type, slug)
  where slug is not null;

create index cms_documents_type_status_idx
  on cms.documents (document_type, publication_status);

create table cms.assets (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_asset_id text not null unique,
  source_url text not null,
  storage_bucket text not null default 'site-content-public',
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  hotspot jsonb,
  crop jsonb,
  metadata jsonb not null default '{}'::jsonb,
  migration_status text not null default 'pending'
    check (migration_status in ('pending', 'copied', 'verified', 'failed')),
  copied_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cms.document_assets (
  document_id uuid not null references cms.documents(id) on delete cascade,
  asset_id uuid not null references cms.assets(id) on delete restrict,
  field_path text not null,
  created_at timestamptz not null default now(),
  primary key (document_id, asset_id, field_path)
);

create table migration.sync_runs (
  id uuid primary key default gen_random_uuid(),
  direction text not null
    check (direction in ('sanity_to_supabase', 'supabase_to_sanity', 'compare')),
  mode text not null
    check (mode in ('dry_run', 'apply', 'shadow')),
  status text not null
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  source_cursor text,
  counters jsonb not null default '{}'::jsonb,
  error_summary text,
  created_at timestamptz not null default now(),
  check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  )
);

create table migration.source_documents (
  legacy_sanity_id text primary key,
  document_type text not null,
  source_revision text,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  operational_imported boolean not null default false,
  cms_imported boolean not null default false,
  tombstoned boolean not null default false
);

create index source_documents_type_idx
  on migration.source_documents (document_type);

create table migration.sync_cursors (
  stream_name text primary key,
  cursor_value text,
  source_updated_at timestamptz,
  last_successful_run_id uuid references migration.sync_runs(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table migration.shadow_events (
  id uuid primary key default gen_random_uuid(),
  source_event_id text not null unique,
  legacy_sanity_id text not null,
  document_type text not null,
  operation text not null check (operation in ('create', 'update', 'delete')),
  source_revision text,
  source_hash text,
  payload jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'applied', 'retry', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  last_error_code text,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);

create index shadow_events_recovery_idx
  on migration.shadow_events (status, next_attempt_at);

create table migration.drift_findings (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid not null references migration.sync_runs(id) on delete cascade,
  category text not null
    check (category in (
      'missing_source',
      'missing_target',
      'field_mismatch',
      'relationship_mismatch',
      'asset_mismatch',
      'count_mismatch',
      'invariant_failure'
    )),
  severity text not null check (severity in ('info', 'warning', 'error')),
  legacy_sanity_id text,
  document_type text,
  field_path text,
  source_value_hash text,
  target_value_hash text,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'ignored')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index drift_findings_open_idx
  on migration.drift_findings (status, severity, category);

create table migration.dead_letters (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  legacy_sanity_id text,
  document_type text,
  operation text not null,
  payload jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  last_error_message text,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table cms.documents enable row level security;
alter table cms.assets enable row level security;
alter table cms.document_assets enable row level security;
alter table migration.sync_runs enable row level security;
alter table migration.source_documents enable row level security;
alter table migration.sync_cursors enable row level security;
alter table migration.shadow_events enable row level security;
alter table migration.drift_findings enable row level security;
alter table migration.dead_letters enable row level security;

revoke all on all tables in schema cms, migration from public, anon, authenticated;
grant all on all tables in schema cms, migration to service_role;
grant usage, select on all sequences in schema cms, migration to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values
  (
    'site-content-public',
    'site-content-public',
    true,
    20971520,
    array[
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/avif',
      'image/gif',
      'image/svg+xml'
    ]::text[]
  ),
  (
    'optimization-builds-private',
    'optimization-builds-private',
    false,
    2147483648,
    array[
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream',
      'application/vnd.microsoft.portable-executable'
    ]::text[]
  )
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

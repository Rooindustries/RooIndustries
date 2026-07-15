set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists credential_operations_source_recovery_idx
  on accounts.credential_operations (
    source_backend,
    source_document_id,
    updated_at
  )
  where status in ('prepared', 'auth_applied');

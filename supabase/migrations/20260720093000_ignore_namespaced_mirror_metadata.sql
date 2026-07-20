set lock_timeout = '5s';
set statement_timeout = '120s';

-- Namespaced Sanity mirror checkpoints are transport metadata, not business
-- payload. Exclude them from authoritative commerce parity and source hashes.
create or replace function migration.canonical_business_document(p_payload jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_payload->>'_type' = 'referral' then p_payload - array[
      '_rev', '_createdAt', '_updatedAt', '_system',
      '_supabaseRevision', '_supabaseCanonicalHash', '_supabaseSequence',
      '_supabaseSequences', '_commerceCutoverGeneration',
      '_supabaseMirroredAt', 'creatorPassword', 'resetToken',
      'resetTokenHash', 'resetTokenExpiresAt', 'resetDeliveryToken',
      'registrationVerificationTokenHash',
      'registrationVerificationExpiresAt',
      'registrationVerificationDeliveryToken',
      'passwordResetRequired', 'credentialVersion'
    ]
    else p_payload - array[
      '_rev', '_createdAt', '_updatedAt', '_system',
      '_supabaseRevision', '_supabaseCanonicalHash', '_supabaseSequence',
      '_supabaseSequences', '_commerceCutoverGeneration',
      '_supabaseMirroredAt'
    ]
  end;
$$;

revoke all on function migration.canonical_business_document(jsonb)
  from public, anon, authenticated;
grant execute on function migration.canonical_business_document(jsonb)
  to service_role;

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
lock table migration.source_documents in share row exclusive mode;

do $$
declare
  saved record;
  current_doc jsonb;
  current_revision text;
  earnings jsonb;
  doc jsonb;
  bucket text;
  earned numeric;
  paid numeric;
  earned_total numeric;
  paid_total numeric;
begin
  for saved in select * from migration.creator_empty_code_before
    where after_payload is not null and rolled_back_at is null for update loop
    select payload, source_revision into current_doc, current_revision
    from migration.source_documents where legacy_sanity_id = saved.legacy_sanity_id and not tombstoned;
    if current_doc is null then
      raise exception 'Creator % is missing during rollback', saved.legacy_sanity_id;
    end if;
    earnings := public.roo_referral_earnings_summary(saved.legacy_sanity_id, current_doc#>>'{slug,current}');
    doc := current_doc - array['emptyCodeReviewXoc', 'emptyCodeReviewVertex',
      'emptyCodeProtectedPaidXoc', 'emptyCodeProtectedPaidVertex', 'underReviewTotal'];
    if saved.payload ? 'underReviewTotal' then
      doc := doc || jsonb_build_object('underReviewTotal', saved.payload->'underReviewTotal');
    end if;
    earned_total := 0;
    paid_total := 0;
    foreach bucket in array array['Xoc', 'Vertex'] loop
      earned := (earnings->>lower(bucket))::numeric
        + coalesce(case when btrim(coalesce(saved.payload->>('earned' || bucket), ''))
          ~ '^-?[0-9]+([.][0-9]+)?$' then (saved.payload->>('earned' || bucket))::numeric end,
          (saved.previous->>lower(bucket))::numeric)
        - (saved.after_payload->>('earned' || bucket))::numeric;
      select coalesce(sum(case when btrim(coalesce(payment->>'amount', ''))
        ~ '^-?[0-9]+([.][0-9]+)?$' then (payment->>'amount')::numeric else 0 end), 0) into paid
      from jsonb_array_elements(case when jsonb_typeof(current_doc->(lower(bucket) || 'Payments')) = 'array'
        then current_doc->(lower(bucket) || 'Payments') else '[]'::jsonb end) payment;
      doc := doc || jsonb_build_object('earned' || bucket, earned,
        'paid' || bucket, paid, 'owed' || bucket, greatest(0, earned - paid));
      earned_total := earned_total + earned;
      paid_total := paid_total + paid;
    end loop;
    doc := doc || jsonb_build_object('earnedTotal', earned_total, 'paidTotal', paid_total,
      'owedTotal', (doc->>'owedXoc')::numeric + (doc->>'owedVertex')::numeric);
    if current_doc->>'registrationStatus' = 'pending_email' then
      doc := doc || jsonb_build_object('owedXoc', 0, 'owedVertex', 0, 'owedTotal', 0,
        'underReviewTotal', greatest(case when btrim(coalesce(current_doc->>'underReviewTotal', ''))
          ~ '^-?[0-9]+([.][0-9]+)?$' then (current_doc->>'underReviewTotal')::numeric else 0 end,
          (earnings->>'total')::numeric - paid_total, 0));
    end if;
    perform public.roo_apply_document_mutations(jsonb_build_array(jsonb_build_object(
      'operation', 'replace', 'document', doc, 'expected_revision', current_revision)));
    update migration.creator_empty_code_before set rolled_back_at = now()
    where legacy_sanity_id = saved.legacy_sanity_id;
  end loop;
  for saved in select * from migration.creator_money_rule_functions loop
    execute saved.before_definition;
  end loop;
end;
$$;

do $$
begin
  execute replace((select before_definition from migration.creator_money_rule_functions
    where signature = 'public.roo_referral_earnings_summary(text,text)'),
    'public.roo_referral_earnings_summary', 'migration.creator_rollback_earnings_summary');
end;
$$;
revoke all on function migration.creator_rollback_earnings_summary(text,text)
  from public, anon, authenticated, service_role;

create or replace function public.roo_referral_earnings_summary(p_referral_legacy_id text, p_referral_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (
    select 1 from migration.source_documents creator
    where creator.legacy_sanity_id = p_referral_legacy_id and creator.document_type = 'referral'
      and not creator.tombstoned and creator.payload->>'registrationStatus' = 'pending_email'
  ) then jsonb_build_object('xoc', 0, 'vertex', 0, 'total', 0, 'byPackage', '{}'::jsonb)
  else migration.creator_rollback_earnings_summary(p_referral_legacy_id, p_referral_code) end;
$$;

create or replace function migration.creator_rollback_payout_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.document_type = 'creatorPayout' and not new.tombstoned then
    perform 1 from migration.source_documents creator
    where creator.legacy_sanity_id in (new.payload->>'referralId', new.payload#>>'{creator,_ref}')
      and creator.document_type = 'referral' and not creator.tombstoned
      and creator.payload->>'registrationStatus' = 'pending_email'
    for share;
    if found then
      raise exception 'Payout is held until the creator verifies their email.' using errcode = 'PT409';
    end if;
  elsif new.document_type = 'referral' and tg_op = 'UPDATE'
    and new.payload->>'registrationStatus' = 'pending_email'
    and (new.payload->'xocPayments' is distinct from old.payload->'xocPayments'
      or new.payload->'vertexPayments' is distinct from old.payload->'vertexPayments') then
    raise exception 'Payout is held until the creator verifies their email.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke all on function migration.creator_rollback_payout_hold() from public, anon, authenticated, service_role;
create or replace trigger creator_rollback_payout_hold
before insert or update on migration.source_documents
for each row execute function migration.creator_rollback_payout_hold();
commit;

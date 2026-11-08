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
        + coalesce((saved.payload->>('earned' || bucket))::numeric,
          (saved.previous->>lower(bucket))::numeric)
        - (saved.after_payload->>('earned' || bucket))::numeric;
      select coalesce(sum((payment->>'amount')::numeric), 0) into paid
      from jsonb_array_elements(coalesce(current_doc->(lower(bucket) || 'Payments'), '[]'::jsonb)) payment;
      doc := doc || jsonb_build_object('earned' || bucket, earned,
        'paid' || bucket, paid, 'owed' || bucket, greatest(0, earned - paid));
      earned_total := earned_total + earned;
      paid_total := paid_total + paid;
    end loop;
    doc := doc || jsonb_build_object('earnedTotal', earned_total, 'paidTotal', paid_total,
      'owedTotal', (doc->>'owedXoc')::numeric + (doc->>'owedVertex')::numeric);
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
commit;

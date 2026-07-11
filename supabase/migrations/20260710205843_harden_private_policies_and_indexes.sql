
do $$
declare
  table_row record;
begin
  for table_row in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('accounts', 'commerce', 'licensing', 'cms', 'migration')
      and c.relkind in ('r', 'p')
  loop
    execute format(
      'create policy deny_browser_access on %I.%I for all to anon, authenticated using (false) with check (false)',
      table_row.schema_name,
      table_row.table_name
    );
  end loop;
end
$$;

create index account_roles_granted_by_idx
  on accounts.account_roles (granted_by);
create index identity_links_user_id_idx
  on accounts.identity_links (user_id);
create index login_aliases_user_id_idx
  on accounts.login_aliases (user_id);

create index document_assets_asset_id_idx
  on cms.document_assets (asset_id);

create index booking_slots_booking_id_idx
  on commerce.booking_slots (booking_id);
create index bookings_payment_record_id_idx
  on commerce.bookings (payment_record_id);
create index bookings_referral_user_id_idx
  on commerce.bookings (referral_user_id);
create index coupon_redemptions_booking_id_idx
  on commerce.coupon_redemptions (booking_id);
create index coupon_redemptions_coupon_id_idx
  on commerce.coupon_redemptions (coupon_id);
create index coupon_redemptions_payment_record_id_idx
  on commerce.coupon_redemptions (payment_record_id);
create index email_dispatches_booking_id_idx
  on commerce.email_dispatches (booking_id);
create index email_dispatches_recovery_case_id_idx
  on commerce.email_dispatches (recovery_case_id);
create index payment_proof_claims_booking_id_idx
  on commerce.payment_proof_claims (booking_id);
create index payment_proof_claims_payment_record_id_idx
  on commerce.payment_proof_claims (payment_record_id);
create index payment_records_booking_id_idx
  on commerce.payment_records (booking_id);
create index payment_records_coupon_redemption_id_idx
  on commerce.payment_records (coupon_redemption_id);
create index payment_records_slot_hold_id_idx
  on commerce.payment_records (slot_hold_id);
create index payment_upgrade_locks_payment_record_id_idx
  on commerce.payment_upgrade_locks (payment_record_id);
create index recovery_cases_booking_id_idx
  on commerce.recovery_cases (booking_id);
create index recovery_cases_payment_record_id_idx
  on commerce.recovery_cases (payment_record_id);
create index referral_ledger_booking_id_idx
  on commerce.referral_ledger (booking_id);
create index referral_ledger_creator_user_id_idx
  on commerce.referral_ledger (creator_user_id);
create index referral_ledger_payment_record_id_idx
  on commerce.referral_ledger (payment_record_id);
create index refunds_booking_id_idx
  on commerce.refunds (booking_id);
create index refunds_payment_record_id_idx
  on commerce.refunds (payment_record_id);
create index slot_claims_booking_id_idx
  on commerce.slot_claims (booking_id);
create index slot_claims_hold_id_idx
  on commerce.slot_claims (hold_id);
create index slot_holds_payment_record_id_idx
  on commerce.slot_holds (payment_record_id);
create index webhook_receipts_payment_record_id_idx
  on commerce.webhook_receipts (payment_record_id);

create index activation_events_activation_id_idx
  on licensing.activation_events (activation_id);
create index activation_events_actor_user_id_idx
  on licensing.activation_events (actor_user_id);
create index activation_events_entitlement_id_idx
  on licensing.activation_events (entitlement_id);
create index device_activations_revoked_by_idx
  on licensing.device_activations (revoked_by);
create index entitlements_user_id_idx
  on licensing.entitlements (user_id);

create index drift_findings_sync_run_id_idx
  on migration.drift_findings (sync_run_id);
create index sync_cursors_last_successful_run_id_idx
  on migration.sync_cursors (last_successful_run_id);

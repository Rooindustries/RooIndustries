begin transaction isolation level repeatable read read only;
set local statement_timeout='30s';
select 'licensing_owners' as check_name,
 count(*) filter(where entitlement.user_id is not null and not exists(select 1 from accounts.principal_auth_users mapping join accounts.principals principal on principal.id=mapping.principal_id where mapping.user_id=entitlement.user_id and principal.status='active')) as owners_without_active_principal,
 count(*) filter(where entitlement.principal_id is not null and not exists(select 1 from accounts.principals principal where principal.id=entitlement.principal_id and principal.status='active')) as inactive_entitlement_principals,
 (select count(*) from licensing.device_activations activation join licensing.entitlements owned on owned.id=activation.entitlement_id where activation.status='active' and (owned.user_id is null or not exists(select 1 from accounts.principal_auth_users mapping join accounts.principals principal on principal.id=mapping.principal_id where mapping.user_id=owned.user_id and principal.status='active'))) as active_devices_without_active_owner
from licensing.entitlements entitlement;
with times as (select start_time_utc from commerce.slot_claims union select start_time_utc from commerce.booking_slots where status='active' union select start_time_utc from commerce.slot_holds where phase in ('active','payment') and expires_at>clock_timestamp()), counts as (
 select times.start_time_utc,
 (select count(*) from commerce.booking_slots slot where slot.start_time_utc=times.start_time_utc and slot.status='active') as booking_count,
 (select count(*) from commerce.slot_holds hold where hold.start_time_utc=times.start_time_utc and (hold.phase in ('active','payment') and hold.expires_at>clock_timestamp())) as hold_count,
 (select count(*) from commerce.slot_claims claim where claim.start_time_utc=times.start_time_utc) as claim_count,
 exists(select 1 from commerce.booking_slots slot left join commerce.slot_claims claim on claim.start_time_utc=slot.start_time_utc and claim.claim_type='booking' and claim.booking_id=slot.booking_id where slot.start_time_utc=times.start_time_utc and slot.status='active' and claim.start_time_utc is null) as wrong_booking_claim,
 exists(select 1 from commerce.slot_holds hold left join commerce.slot_claims claim on claim.start_time_utc=hold.start_time_utc and claim.claim_type='hold' and claim.hold_id=hold.id where hold.start_time_utc=times.start_time_utc and (hold.phase in ('active','payment') and hold.expires_at>clock_timestamp()) and claim.start_time_utc is null) as wrong_hold_claim
 from times)
select 'slot_integrity' as check_name,count(*) filter(where booking_count+hold_count>1) as multi_owner_times,count(*) filter(where wrong_booking_claim) as wrong_booking_claims,count(*) filter(where wrong_hold_claim) as wrong_hold_claims,count(*) filter(where booking_count+hold_count=0 and claim_count>0) as orphan_claims from counts;
select 'oauth_constraints' as check_name,
 count(*) filter(where action not in ('signin','signup','link','reauth','merge','reclaim')) as unexpected_actions,
 count(*) filter(where (action in ('link','reauth','merge','reclaim')) is distinct from (target_user_id is not null)) as target_mismatch,
 (select count(*) from (select target_user_id,provider,action from accounts.oauth_intents where action in ('link','reauth','merge','reclaim') and status='pending' group by target_user_id,provider,action having count(*)>1) duplicates) as duplicate_sensitive_keys,
 (select count(*) from accounts.reauth_grants where expires_at<=created_at) as invalid_reauth_expiry,
 (select count(*) from accounts.account_roles where role not in ('customer','creator','tourney_player','tourney_viewer','tourney_caster','tourney_owner','administrator','tourney_retired')) as invalid_roles
from accounts.oauth_intents;
select 'optional_orphan_columns' as check_name,count(*) as installed_columns from information_schema.columns where (table_schema,table_name,column_name) in (('accounts','oauth_intents','recovery_for_intent_id'),('accounts','reauth_grants','bound_intent_id'),('accounts','reauth_grants','bound_at'));
select 'terminal_email_backfill' as check_name,count(*) as source_bookings,count(*) filter(where lower(coalesce(payload->>'emailDispatchStatus',''))='delivery_unknown') as confirmation_unknown,count(*) filter(where lower(coalesce(payload->>'recoveryNotificationStatus',''))='delivery_unknown') as reschedule_unknown from migration.source_documents where document_type='booking' and not tombstoned and (lower(coalesce(payload->>'emailDispatchStatus',''))='delivery_unknown' or lower(coalesce(payload->>'recoveryNotificationStatus',''))='delivery_unknown');
with selected_sources as (
 select source.* from migration.source_documents source where source.document_type='booking' and not source.tombstoned
 and (lower(coalesce(source.payload->>'emailDispatchStatus',''))='delivery_unknown' or lower(coalesce(source.payload->>'recoveryNotificationStatus',''))='delivery_unknown')
), intended_keys as (
 select source.legacy_sanity_id,booking.id as booking_id,recipient.kind as recipient_kind,'booking_confirmation'::text as dispatch_kind
 from selected_sources source join commerce.bookings booking on booking.legacy_sanity_id=source.legacy_sanity_id cross join (values('customer'),('owner')) recipient(kind)
 union all select source.legacy_sanity_id,booking.id,recipient.kind,'reschedule'
 from selected_sources source join commerce.bookings booking on booking.legacy_sanity_id=source.legacy_sanity_id cross join (values('customer'),('owner')) recipient(kind)
 where coalesce(migration.try_boolean(source.payload->>'requiresReschedule'),false)
)
select 'terminal_email_write_effects' as check_name,intended.dispatch_kind,count(*) as candidate_keys,
 count(*) filter(where dispatch.id is null) as inserted_keys,count(*) filter(where dispatch.id is not null) as updated_keys,
 count(*) filter(where dispatch.status='sent') as existing_sent,count(*) filter(where dispatch.status='historical_unknown') as existing_unknown,
 count(*) filter(where dispatch.id is not null and dispatch.booking_id<>intended.booking_id) as conflicting_booking_bindings
from intended_keys intended left join commerce.email_dispatches dispatch on dispatch.idempotency_key='booking-'||intended.legacy_sanity_id||case when intended.dispatch_kind='reschedule' then '-reschedule-' else '-' end||case when intended.recipient_kind='customer' then 'client' else 'owner' end
group by intended.dispatch_kind;
select 'tourney_trigger_repair' as check_name,count(*) as controls,count(*) filter(where hardened_active) as clock_resets,count(*) filter(where hardened_active and (primary_backend<>'supabase' or generation<>1 or not writes_paused or fallback_read_only or coalesce((select schema_version from tourney.schema_metadata where schema_name='tourney'),0)<4)) as refused_controls from tourney.cutover_metadata where id='tourney';
select 'tourney_release_adaptation' as check_name,
 count(*) as controls,
 (select count(*) from tourney.mirror_contracts where enabled) as enabled_contracts,
 count(*) filter(where not exists(select 1 from tourney.mirror_contracts where enabled)) as retired_controls_skip_active_repair,
 count(*) filter(where exists(select 1 from tourney.mirror_contracts where enabled)) as adapted_refused_controls,
 0::bigint as adapted_clock_resets
from tourney.cutover_metadata where id='tourney';
with current_gate as (select not exists (
    select 1
    from (values
      ('public_roster', 750),
      ('public_bracket', 750),
      ('admin_players', 1000),
      ('appeals', 1000),
      ('payouts', 1000)
    ) required(route, maximum_p95_ms)
    left join lateral (
      select
        count(*)::integer samples,
        count(*) filter (where not (
          sample.shape_match
          and sample.value_match
          and sample.ordering_match
          and sample.error_match
          and coalesce(sample.primary_status between 200 and 299, false)
          and coalesce(sample.shadow_status between 200 and 299, false)
        ))::integer mismatches,
        percentile_cont(0.95) within group (
          order by sample.primary_latency_ms
        )::integer primary_p95_ms,
        percentile_cont(0.95) within group (
          order by sample.shadow_latency_ms
        )::integer shadow_p95_ms
      from (
        select observation.*
        from tourney.shadow_observations observation
        where observation.route = required.route
          and observation.observed_at >= coalesce((
            select metadata.natural_mutation_verified_at
            from tourney.cutover_metadata metadata
            where metadata.id = 'tourney'
          ), 'infinity'::timestamptz)
        order by observation.observed_at desc, observation.id desc
        limit 30
      ) sample
    ) summary on true
    left join tourney.shadow_latency_baselines baseline
      on baseline.route = required.route
    where coalesce(summary.samples, 0) < 30
      or coalesce(summary.mismatches, 0) > 0
      or coalesce(summary.primary_p95_ms, 2147483647) >= required.maximum_p95_ms
      or coalesce(summary.shadow_p95_ms, 2147483647) >= required.maximum_p95_ms
      or baseline.route is null
      or summary.primary_p95_ms > baseline.primary_p95_ms * 1.2
  )) select 'tourney_acceptance_clock_update' as check_name,count(*) filter(where clock_last_reset_reason='shadow_acceptance_gate_failed') as candidate_controls,count(*) filter(where clock_last_reset_reason='shadow_acceptance_gate_failed' and (select * from current_gate)) as changed_controls from tourney.cutover_metadata where id='tourney';
select 'tourney_feedback_constraint' as check_name,count(*) filter(where dispatch_kind not in ('registration','approval','reset','discord_invite','appeal','payout','feedback')) as refused_dispatches from tourney.email_dispatches;
select 'optional_orphan_constraints' as check_name,
 count(*) filter(where ((to_jsonb(grant_row)->>'bound_intent_id') is null) is distinct from ((to_jsonb(grant_row)->>'bound_at') is null)) as bound_pair_conflicts,
 count(*) filter(where to_jsonb(grant_row)->>'bound_intent_id' is not null and not exists(select 1 from accounts.oauth_intents intent where intent.id::text=to_jsonb(grant_row)->>'bound_intent_id')) as missing_bound_intents,
 (select count(*) from (select to_jsonb(g)->>'bound_intent_id' as bound from accounts.reauth_grants g where to_jsonb(g)->>'bound_intent_id' is not null group by to_jsonb(g)->>'bound_intent_id' having count(*)>1) d) as duplicate_bindings,
 (select count(*) from accounts.oauth_intents intent where (intent.action='reclaim') is distinct from (to_jsonb(intent)->>'recovery_for_intent_id' is not null)) as reclaim_source_conflicts,
 (select count(*) from accounts.oauth_intents intent where to_jsonb(intent)->>'recovery_for_intent_id' is not null and not exists(select 1 from accounts.oauth_intents source where source.id::text=to_jsonb(intent)->>'recovery_for_intent_id')) as missing_recovery_sources
from accounts.reauth_grants grant_row;
select 'terminal_email_dependencies' as check_name,count(*) filter(where not exists(select 1 from commerce.bookings booking where booking.legacy_sanity_id=source.legacy_sanity_id)) as unknown_sources_without_typed_booking from migration.source_documents source where source.document_type='booking' and not source.tombstoned and (lower(coalesce(source.payload->>'emailDispatchStatus',''))='delivery_unknown' or lower(coalesce(source.payload->>'recoveryNotificationStatus',''))='delivery_unknown');
with projected_refunds as (
 select payment.id as payment_id,payment.provider,coalesce(nullif(refund->>'providerRefundId',''),refund->>'_key') as provider_refund_id
 from migration.source_documents source join commerce.payment_records payment on payment.legacy_sanity_id=source.legacy_sanity_id
 cross join lateral jsonb_array_elements(case when jsonb_typeof(source.payload->'refunds')='array' then source.payload->'refunds' else '[]'::jsonb end) refund
 where source.document_type='paymentRecord' and not source.tombstoned and coalesce(nullif(refund->>'providerRefundId',''),refund->>'_key') is not null
)
select 'refund_projection_binding' as check_name,count(*) filter(where existing.payment_record_id<>projected.payment_id) as conflicting_existing_bindings,
 (select count(*) from (select provider,provider_refund_id from projected_refunds group by provider,provider_refund_id having count(distinct payment_id)>1) conflicts) as conflicting_source_bindings
from projected_refunds projected left join commerce.refunds existing on existing.provider=projected.provider and existing.provider_refund_id=projected.provider_refund_id;
select 'expired_mirror_leases' as check_name,count(*) as rows_terminalized_on_next_claim from migration.commerce_mirror_outbox where status='processing' and lease_expires_at<=now() and attempt_count>=12;
select 'retired_discord_mirror_binding' as check_name,
 (select count(*) from tourney.mirror_contracts where enabled) as enabled_contracts,
 count(*) filter(where not exists(select 1 from tourney.mirror_contracts where enabled)) as retired_bindings_to_detach
from pg_trigger where tgrelid='accounts.discord_role_assignments'::regclass and tgname='capture_tourney_mirror_event' and not tgisinternal;
rollback;

import crypto from 'node:crypto';
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uuid = (s) => { const h = hex(s); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const commerce = (cmd, mutations) => ({ rpc: 'roo_apply_commerce_document_mutations', body: { p_command_id: cmd, p_mutations: mutations } });
const cms = (t, id, actor, mutation) => { const h = hex(`${t}:${id}`); return { rpc: 'roo_apply_cms_publish_command', body: { p_command_id: `cms:${h}`, p_request_hash: h, p_actor: actor, p_mutations: [mutation], p_assets: [], p_asset_links: [] } }; };
const replica = (body) => ({ sql: `set session_replication_role = replica; ${body}; set session_replication_role = origin;` });
const referralDispatch = (t, id, status, extra) => replica(`insert into accounts.referral_email_dispatches (command_id, idempotency_key, referral_id, dispatch_kind, recipient_email, recipient_hash, token_hash, delivery_payload, expires_at, status${extra.cols}) values ('cmd-${t}-${id}', 'referral-email-${hex(t + id)}', 'referral.${t}-${id}', 'password_reset', 'creator@example.test', '${hex('r' + t + id)}', '${hex('k' + t + id)}', '{}'::jsonb, now() + interval '1 day', '${status}'${extra.vals})`);
export const scenarios = [
  { id: 'S01', fn: 'migration.roo_apply_commerce_document_mutations_unbounded', msg: 'document revision conflict: paymentRecord.',
    seed: [(t) => commerce(`cmd-${t}-s01-seed`, [{ operation: 'create', document: { _id: `paymentRecord.${t}-s01`, _type: 'paymentRecord', status: 'created' } }])],
    call: (t) => commerce(`cmd-${t}-s01-call`, [{ operation: 'replace', id: `paymentRecord.${t}-s01`, expected_revision: 'stale', document: { _id: `paymentRecord.${t}-s01`, _type: 'paymentRecord', status: 'paid' } }]) },
  { id: 'S02', fn: 'commerce.normalize_booking_confirmation_source', msg: 'inactive booking cannot acquire an email transport lease',
    seed: [(t) => commerce(`cmd-${t}-s02-seed`, [{ operation: 'create', document: { _id: `booking.${t}-s02`, _type: 'booking', status: 'cancelled', emailDispatchLeaseId: 'lease-old' } }])],
    call: (t) => commerce(`cmd-${t}-s02-call`, [{ operation: 'replace', id: `booking.${t}-s02`, document: { _id: `booking.${t}-s02`, _type: 'booking', status: 'cancelled', emailDispatchLeaseId: 'lease-new' } }]) },
  { id: 'S04', fn: 'public.roo_apply_document_mutations', msg: 'document revision conflict: rateLimitBucket.',
    seed: [(t) => ({ rpc: 'roo_apply_document_mutations', body: { p_mutations: [{ operation: 'create', document: { _id: `rateLimitBucket.${t}-s04`, _type: 'rateLimitBucket', count: 1 } }] } })],
    call: (t) => ({ rpc: 'roo_apply_document_mutations', body: { p_mutations: [{ operation: 'replace', id: `rateLimitBucket.${t}-s04`, expected_revision: 'stale', document: { _id: `rateLimitBucket.${t}-s04`, _type: 'rateLimitBucket', count: 2 } }] } }) },
  { id: 'S05', fn: 'public.roo_apply_cms_publish_command', msg: 'CMS_REVISION_CONFLICT',
    seed: [(t) => ({ rpc: 'roo_apply_document_mutations', body: { p_mutations: [{ operation: 'create', document: { _id: `rateLimitBucket.${t}-s05`, _type: 'rateLimitBucket', count: 1 } }] } })],
    call: (t) => cms(t, 's05', 'admin:scenario', { operation: 'replace', id: `rateLimitBucket.${t}-s05`, expected_revision: 'stale', document: { _id: `rateLimitBucket.${t}-s05`, _type: 'rateLimitBucket' } }) },
  { id: 'S06', fn: 'public.roo_cms_publish_command_result', msg: 'CMS command identity conflict',
    seed: [(t) => ({ sql: `insert into migration.cms_publish_commands (command_id, request_hash, actor, operation, status, result, committed_at) values ('cms:${hex(t + 's06')}', '${hex(t + 's06')}', 'admin:owner', 'create', 'committed', '{}'::jsonb, now())` })],
    call: (t) => ({ rpc: 'roo_cms_publish_command_result', body: { p_command_id: `cms:${hex(t + 's06')}`, p_request_hash: hex(t + 's06'), p_actor: 'admin:another' } }) },
  { id: 'S07', fn: 'public.roo_admin_update_creator_terms', msg: 'creator terms version conflict',
    seed: [(t) => replica(`insert into accounts.creator_profiles (user_id, referral_code, principal_id, terms_version) values ('${uuid(t + 's07')}', 's07${t}', '${uuid(t + 's07p')}', 2)`)],
    call: (t) => ({ rpc: 'roo_admin_update_creator_terms', body: { p_command_id: `cmd-${t}-s07`, p_creator_id: uuid(t + 's07'), p_expected_version: 1, p_total_basis_points: 1000, p_commission_basis_points: 500, p_discount_basis_points: 500, p_bypass_referral_requirement: false, p_reason: 'scenario', p_cutover_generation: 0 } }) },
  { id: 'S08', fn: 'public.roo_advance_commerce_generation', msg: 'Commerce generation changed',
    call: () => ({ rpc: 'roo_advance_commerce_generation', body: { p_expected_generation: 7, p_primary_backend: 'supabase', p_starts_paused: false, p_reason: 'scenario' } }) },
  { id: 'S09', fn: 'public.roo_set_commerce_starts_paused', msg: 'Commerce generation changed',
    call: () => ({ rpc: 'roo_set_commerce_starts_paused', body: { p_expected_generation: 7, p_paused: false, p_reason: 'scenario' } }) },
  { id: 'S10', fn: 'public.roo_complete_booking_email_dispatch', msg: 'email dispatch lease conflict',
    seed: [(t) => replica(`insert into commerce.email_dispatches (booking_id, recipient_type, recipient_email_hash, idempotency_key, status, lease_id, lease_expires_at) values ('${uuid(t + 's10b')}', 'customer', 'h', 'booking-${t}-s10-client', 'sending', 'lease-held-${t}', now() + interval '10 minutes')`)],
    call: (t) => ({ rpc: 'roo_complete_booking_email_dispatch', body: { p_idempotency_key: `booking-${t}-s10-client`, p_lease_id: `lease-other-${t}`, p_success: true, p_provider_message_id: 'msg-1', p_error_code: null, p_sent_at: null, p_next_attempt_at: null } }) },
  { id: 'S11', fn: 'public.roo_complete_referral_email_dispatch', msg: 'referral email dispatch lease conflict',
    seed: [(t) => referralDispatch(t, 's11', 'sending', { cols: ', lease_id, lease_expires_at', vals: `, '${uuid(t + 's11l')}', now() + interval '10 minutes'` })],
    call: (t) => ({ rpc: 'roo_complete_referral_email_dispatch', body: { p_idempotency_key: `referral-email-${hex(t + 's11')}`, p_lease_id: uuid(t + 's11other'), p_success: true, p_provider_message_id: 'msg-1', p_error_code: null, p_retry_delay_seconds: 60 } }) },
  { id: 'S12', fn: 'public.roo_resolve_referral_email_dispatch', msg: 'referral email dispatch resolution conflict', guard: 'unreachable',
    seed: [(t) => referralDispatch(t, 's12', 'dead_letter', { cols: ', dead_lettered_at', vals: ', now()' }),
      (t) => ({ sql: `create or replace function public.zz_scenario_skip_update() returns trigger language plpgsql as $$ begin if old.referral_id like 'referral.%-s12' then return null; end if; return new; end $$; drop trigger if exists zz_scenario_skip_s12 on accounts.referral_email_dispatches; create trigger zz_scenario_skip_s12 before update on accounts.referral_email_dispatches for each row execute function public.zz_scenario_skip_update()` })],
    call: (t) => ({ rpc: 'roo_resolve_referral_email_dispatch', body: { p_idempotency_key: `referral-email-${hex(t + 's12')}`, p_resolution_code: 'scenario' } }),
    after: { sql: 'drop trigger if exists zz_scenario_skip_s12 on accounts.referral_email_dispatches; drop function if exists public.zz_scenario_skip_update()' } },
];
const credOp = (t, id, cols, vals) => replica(`insert into accounts.principals (id) values ('${uuid(t + id + 'p1')}'), ('${uuid(t + id + 'p2')}'); insert into accounts.credential_operations (operation_key, user_id, principal_id, password_hash${cols}) values ('op-${t}-${id}', '${uuid(t + id + 'u')}', '${uuid(t + id + 'p1')}', '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE'${vals})`);
const principalRace = (id, rpcName, body) => async ({ sql, rpc, tag }) => {
  const b = await sql.reserve();
  let committed = false;
  try {
    await b`begin`;
    await b.unsafe(`select 1 from accounts.principals where id = '${uuid(tag + id + 'p1')}' for update`);
    const pending = rpc(rpcName, body(tag));
    let waiting = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [{ n }] = await sql`select count(*)::int n from pg_stat_activity where application_name like 'PostgREST%' and wait_event_type = 'Lock'`;
      if (n) { waiting = true; break; }
    }
    if (!waiting) throw new Error('PostgREST did not reach the principal lock');
    await b.unsafe(`set local session_replication_role = replica; update accounts.credential_operations set principal_id = '${uuid(tag + id + 'p2')}' where operation_key = 'op-${tag}-${id}'`);
    await b`commit`;
    committed = true;
    return await pending;
  } finally { if (!committed) await b`rollback`; b.release(); }
};
const sourceDoc = (id, type, rev, payload) => replica(`insert into migration.source_documents (legacy_sanity_id, document_type, source_hash, source_revision, payload) values ('${id}', '${type}', '${hex(id)}', '${rev}', '${JSON.stringify({ _id: id, _type: type, _rev: rev, ...payload })}'::jsonb)`);
const reclaimSeed = (t) => {
  const u = (s) => uuid(t + 's16' + s);
  return { sql: `
    insert into auth.users(id,email,raw_app_meta_data) values ('${u('target')}','creator@example.invalid','{"providers":["email"]}'::jsonb), ('${u('owner')}','discord@auth.rooindustries.invalid','{"provider":"discord","providers":["discord"]}'::jsonb);
    insert into accounts.principals(id) values ('${u('tp')}'),('${u('op')}');
    insert into accounts.principal_auth_users(principal_id,user_id,is_primary,source) values ('${u('tp')}','${u('target')}',true,'migration'),('${u('op')}','${u('owner')}',true,'signup');
    insert into accounts.creator_profiles(user_id,principal_id,referral_code,active) values ('${u('target')}','${u('tp')}','creator-${u('target')}',true);
    insert into accounts.account_roles(user_id,principal_id,role) values ('${u('target')}','${u('tp')}','creator');
    insert into auth.identities(user_id,provider,provider_id,identity_data) values ('${u('owner')}','discord','discord-${t}-s16','{"sub":"discord-${t}-s16"}'::jsonb);
    insert into accounts.identity_links(user_id,principal_id,provider,provider_subject,metadata) values ('${u('owner')}','${u('op')}','discord','discord-${t}-s16','{}'::jsonb);
    insert into accounts.oauth_intents(id,token_hash,flow,action,provider,target_user_id,principal_id,domain_subject,return_path,status,expires_at,failure_code,completed_at)
      values ('${u('orig')}','${hex(t + 's16orig')}','referral','link','discord','${u('target')}','${u('tp')}','creator','/referrals/dashboard','failed',now()+interval '10 minutes','identity_already_exists',now());
    insert into accounts.reauth_grants(token_hash,user_id,principal_id,purpose,expires_at) values ('${hex(t + 's16grant')}','${u('target')}','${u('tp')}','link_identity',now()+interval '10 minutes');
    select public.roo_create_oauth_intent(jsonb_build_object('action','reclaim','domain_subject','creator','expires_at',(now()+interval '10 minutes')::text,'flow','referral','provider','discord','reauth_purpose',null,'reauth_token_hash','${hex(t + 's16grant')}','recovery_for_intent_id','${u('orig')}','return_path','/referrals/dashboard','target_user_id','${u('target')}','token_hash','${hex(t + 's16token')}'));
    create or replace function public.zz_scenario_skip_identity() returns trigger language plpgsql as $$ begin if old.provider_id like 'discord-%-s16' then return null; end if; return new; end $$;
    drop trigger if exists zz_scenario_skip_s16 on auth.identities;
    create trigger zz_scenario_skip_s16 before update on auth.identities for each row execute function public.zz_scenario_skip_identity();` };
};
const email = 'creator@example.test';
const expires = new Date(Date.now() + 6 * 3600e3).toISOString();
scenarios.push(
  { id: 'S03', fn: 'migration.apply_cms_commerce_mutation', msg: 'document revision conflict: coupon.',
    seed: [(t) => commerce(`cmd-${t}-s03-seed`, [{ operation: 'create', document: { _id: `coupon.${t}-s03`, _type: 'coupon', code: `S03${t}`.toUpperCase() } }])],
    call: (t) => cms(t, 's03', 'sanity:scenario', { operation: 'replace', id: `coupon.${t}-s03`, expected_revision: 'stale', document: { _id: `coupon.${t}-s03`, _type: 'coupon', code: `S03${t}`.toUpperCase() } }) },
  { id: 'S13', fn: 'public.roo_enqueue_referral_email_mutation', msg: 'referral email source state changed during delivery',
    seed: [(t) => referralDispatch(t, 's13', 'sending', { cols: ', lease_id, lease_expires_at', vals: `, '${uuid(t + 's13l')}', now() + interval '10 minutes'` })],
    call: (t) => ({ rpc: 'roo_enqueue_referral_email_mutation', body: { p_mutations: [{ operation: 'create', document: { _id: `referral.${t}-s13`, _type: 'referral', creatorEmail: email, resetTokenHash: hex(`tok-${t}`), resetTokenExpiresAt: expires } }], p_referral_id: `referral.${t}-s13`, p_dispatch_kind: 'password_reset', p_recipient_email: email, p_recipient_hash: hex(email), p_token_hash: hex(`tok-${t}`), p_delivery_payload: { token: `tok-${t}` }, p_expires_at: expires } }) },
  { id: 'S14', fn: 'public.roo_complete_incremental_commerce_sync', msg: 'commerce sync lease conflict',
    seed: [(t) => ({ sql: `insert into migration.sync_runs (id, direction, mode, status) values ('${uuid(t + 's14run')}', 'sanity_to_supabase', 'apply', 'running'); insert into migration.sync_cursors (stream_name, lease_id, lease_expires_at) values ('stream-${t}-s14', 'lease-held-${t}', now() + interval '10 minutes')` })],
    call: (t) => ({ rpc: 'roo_complete_incremental_commerce_sync', body: { p_stream_name: `stream-${t}-s14`, p_lease_id: `lease-other-${t}`, p_run_id: uuid(t + 's14run'), p_cursor_value: 'c1', p_source_updated_at: new Date().toISOString(), p_counters: {} } }) },
  { id: 'S15', fn: 'public.roo_complete_discord_role_assignment', msg: 'Discord role generation changed',
    seed: [(t) => replica(`insert into accounts.principals (id) values ('${uuid(t + 's15p')}'); insert into accounts.principal_auth_users (principal_id, user_id) values ('${uuid(t + 's15p')}', '${uuid(t + 's15u')}'); insert into accounts.discord_role_assignments (user_id, discord_user_id, guild_id, principal_id, generation) values ('${uuid(t + 's15u')}', '${BigInt('0x' + hex(t + 's15').slice(0, 12))}', '987654321', '${uuid(t + 's15p')}', 2)`)],
    call: (t) => ({ rpc: 'roo_complete_discord_role_assignment', body: { p_user_id: uuid(t + 's15u'), p_generation: 1, p_applied_role: 'participant', p_status: 'applied', p_error: null, p_joined: true } }) },
  { id: 'S16', fn: 'public.roo_reclaim_referral_orphan_identity', msg: 'Orphan identity move lost its row guard', guard: 'unreachable',
    seed: [reclaimSeed],
    call: (t) => ({ rpc: 'roo_reclaim_referral_orphan_identity', body: { p_token_hash: hex(t + 's16token'), p_orphan_user_id: uuid(t + 's16owner'), p_provider: 'discord' } }),
    after: { sql: 'drop trigger if exists zz_scenario_skip_s16 on auth.identities; drop function if exists public.zz_scenario_skip_identity()' } },
  { id: 'S17', fn: 'public.roo_upsert_native_creator_account', msg: 'native creator source state changed',
    seed: [(t) => sourceDoc(`referral.${t}-s17`, 'referral', 'rev-current', { registrationStatus: 'active' })],
    call: (t) => ({ rpc: 'roo_upsert_native_creator_account', body: { p_account: { user_id: uuid(t + 's17u'), primary_email: email, referral_code: `s17${t}`, legacy_sanity_id: `referral.${t}-s17`, source_revision: 'rev-stale', registration_status: 'active' } } }) },
  { id: 'S18', fn: 'public.roo_apply_credential_source_operation', msg: 'Credential source precondition changed',
    seed: [(t) => sourceDoc(`referral.${t}-s18`, 'referral', 'rev-1', { resetTokenHash: 'new' }), (t) => credOp(t, 's18', ', status, source_backend, source_document_id, source_preconditions', `, 'auth_applied', 'supabase', 'referral.${t}-s18', '{"resetTokenHash":"old"}'::jsonb`)],
    call: (t) => ({ rpc: 'roo_apply_credential_source_operation', body: { p_operation_key: `op-${t}-s18` } }) },
  { id: 'S19', fn: 'public.roo_mark_credential_operation', msg: 'Credential operation principal changed', guard: 'race',
    seed: [(t) => credOp(t, 's19', ', status', `, 'prepared'`)],
    race: principalRace('s19', 'roo_mark_credential_operation', (t) => ({ p_operation_key: `op-${t}-s19`, p_status: 'failed', p_error_code: 'SCENARIO' })) },
  { id: 'S20', fn: 'public.roo_mark_credential_source_applied', msg: 'Credential source revision conflicts',
    seed: [(t) => credOp(t, 's20', ', status, source_backend, source_document_id, source_applied_at, source_applied_revision', `, 'auth_applied', 'sanity', 'referral.${t}-s20', now(), 'rev-1'`)],
    call: (t) => ({ rpc: 'roo_mark_credential_source_applied', body: { p_operation_key: `op-${t}-s20`, p_source_revision: 'rev-2' } }) },
  { id: 'S21', fn: 'public.roo_complete_credential_operation', msg: 'Credential operation principal changed', guard: 'race',
    seed: [(t) => credOp(t, 's21', ', status, sessions_revoked_at', `, 'auth_applied', now()`)],
    race: principalRace('s21', 'roo_complete_credential_operation', (t) => ({ p_operation_key: `op-${t}-s21` })) },
  { id: 'S22', fn: 'public.roo_record_credential_recovery_error', msg: 'Credential operation status changed',
    seed: [(t) => credOp(t, 's22', ', status', `, 'failed'`)],
    call: (t) => ({ rpc: 'roo_record_credential_recovery_error', body: { p_operation_key: `op-${t}-s22`, p_expected_status: 'prepared', p_error_code: 'SCENARIO' } }) },
);
export const controls = [
  { id: 'C16', fn: 'public.roo_reclaim_referral_orphan_identity (no forcing trigger)', msg: 'Orphan identity move lost its row guard',
    seed: [reclaimSeed, { sql: 'drop trigger if exists zz_scenario_skip_s16 on auth.identities; drop function if exists public.zz_scenario_skip_identity()' }],
    call: (t) => ({ rpc: 'roo_reclaim_referral_orphan_identity', body: { p_token_hash: hex(t + 's16token'), p_orphan_user_id: uuid(t + 's16owner'), p_provider: 'discord' } }) },
  { id: 'C12', fn: 'public.roo_resolve_referral_email_dispatch (no forcing trigger)', msg: 'referral email dispatch resolution conflict',
    seed: [(t) => referralDispatch(t, 'c12', 'dead_letter', { cols: ', dead_lettered_at', vals: ', now()' })],
    call: (t) => ({ rpc: 'roo_resolve_referral_email_dispatch', body: { p_idempotency_key: `referral-email-${hex(t + 'c12')}`, p_resolution_code: 'scenario' } }) },
  { id: 'C19', fn: 'public.roo_mark_credential_operation_v2 (same race)', msg: 'Credential operation principal changed',
    seed: [(t) => credOp(t, 'c19', ', status', `, 'prepared'`)],
    race: principalRace('c19', 'roo_mark_credential_operation_v2', (t) => ({ p_operation_key: `op-${t}-c19`, p_status: 'failed', p_error_code: 'SCENARIO' })) },
  { id: 'C21', fn: 'public.roo_complete_credential_operation_v2 (same race)', msg: 'Credential operation principal changed',
    seed: [(t) => credOp(t, 'c21', ', status, sessions_revoked_at', `, 'auth_applied', now()`)],
    race: principalRace('c21', 'roo_complete_credential_operation_v2', (t) => ({ p_operation_key: `op-${t}-c21` })) },
];
scenarios.sort((a, b) => a.id.localeCompare(b.id));

begin;
set local search_path=public,extensions;
do $guard$ begin
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer)') is distinct from '{"md5": "2c785bbf3aad5ad12a86495d460a1d13", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer)' using errcode='55000'; end if;
end $guard$;
do $guard$ begin
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='migration.roo_apply_commerce_document_mutations_unbounded(p_command_id text, p_mutations jsonb, p_cutover_generation integer)') is distinct from '{"md5": "01d6894ccbb6f0973b1c07b8eb218cbb", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','migration.roo_apply_commerce_document_mutations_unbounded(p_command_id text, p_mutations jsonb, p_cutover_generation integer)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_activate_tourney_schema_v4(p_actor text)') is distinct from '{"md5": "93852147903a00038ffbc267c877a61a", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_activate_tourney_schema_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)') is distinct from '{"md5": "c898d168d482fd3a5ef9168e461b377a", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer)') is distinct from '{"md5": "2c785bbf3aad5ad12a86495d460a1d13", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_backfill_tourney_email_history_v4(p_actor text)') is distinct from '{"md5": "d604950f01bf32269bf281cb4fc3a61e", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_backfill_tourney_email_history_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_tourney_readiness()') is distinct from '{"md5": "bfa80fe5a52ce9cd0067caedb5d39dcc", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_tourney_readiness()' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_tourney_readiness_before_trigger_binding_v4()') is distinct from '{"md5": "0cf64ec1347ea6459153b6976cb96421", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_tourney_readiness_before_trigger_binding_v4()' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='tourney.capture_mirror_event()') is distinct from '{"md5": "4e010836e313d4aab7f6858992e98852", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','tourney.capture_mirror_event()' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='tourney.capture_mirror_event_v4()') is distinct from '{"md5": "650f71e8a35b68b9cb27cb7bd8974519", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','tourney.capture_mirror_event_v4()' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='tourney.mirror_trigger_binding_status_v4()') is distinct from '{"md5": "ed9bf747ddb0f1571cbab30e667bd20f", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','tourney.mirror_trigger_binding_status_v4()' using errcode='55000'; end if;
end $guard$;
do $adapted$ begin
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('commerce.bookings')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX bookings_payment_record_id_idx ON commerce.bookings USING btree (payment_record_id)", "CREATE INDEX bookings_referral_user_id_idx ON commerce.bookings USING btree (referral_user_id)", "CREATE UNIQUE INDEX bookings_legacy_sanity_id_key ON commerce.bookings USING btree (legacy_sanity_id)", "CREATE UNIQUE INDEX bookings_pkey ON commerce.bookings USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": ["commerce_bookings_skip_unchanged_projection O CREATE TRIGGER commerce_bookings_skip_unchanged_projection BEFORE UPDATE ON commerce.bookings FOR EACH ROW EXECUTE FUNCTION migration.skip_unchanged_commerce_projection()"], "cols": ["amount_subunits bigint NN D:0", "backend_owner text NN D:''supabase''::text", "booking_payload jsonb NN D:''{}''::jsonb", "cancelled_at timestamp with time zone", "completed_at timestamp with time zone", "coupon_code text", "created_at timestamp with time zone NN D:now()", "currency text NN D:''USD''::text", "customer_email text", "customer_name text", "customer_timezone text", "cutover_generation integer NN D:0", "id uuid NN D:gen_random_uuid()", "imported_at timestamp with time zone", "legacy_sanity_id text", "package_legacy_id text", "package_title text NN", "payer_email text", "payment_record_id uuid", "referral_user_id uuid", "refunded_at timestamp with time zone", "requires_reschedule boolean NN D:false", "source_backend text NN D:''sanity''::text", "source_created_at timestamp with time zone", "source_hash text", "source_revision text", "source_updated_at timestamp with time zone", "start_time_utc timestamp with time zone", "status text NN", "updated_at timestamp with time zone NN D:now()"], "cons": ["bookings_amount_subunits_check CHECK ((amount_subunits >= 0))", "bookings_currency_check CHECK ((currency ~ ''^[A-Z]{3}$''::text))", "bookings_customer_email_check CHECK (((customer_email IS NULL) OR (customer_email = lower(btrim(customer_email)))))", "bookings_legacy_sanity_id_key UNIQUE (legacy_sanity_id)", "bookings_payer_email_check CHECK (((payer_email IS NULL) OR (payer_email = lower(btrim(payer_email)))))", "bookings_payment_record_fkey FOREIGN KEY (payment_record_id) REFERENCES commerce.payment_records(id) ON DELETE SET NULL", "bookings_pkey PRIMARY KEY (id)", "bookings_referral_user_id_fkey FOREIGN KEY (referral_user_id) REFERENCES auth.users(id) ON DELETE SET NULL", "bookings_source_backend_check CHECK ((source_backend = ANY (ARRAY[''sanity''::text, ''supabase''::text])))", "bookings_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''captured''::text, ''completed''::text, ''failed''::text, ''refunded''::text, ''cancelled''::text])))", "commerce_bookings_backend_owner_check CHECK ((backend_owner = ANY (ARRAY[''sanity''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','commerce.bookings' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('commerce.slot_claims')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX slot_claims_booking_id_idx ON commerce.slot_claims USING btree (booking_id)", "CREATE INDEX slot_claims_hold_id_idx ON commerce.slot_claims USING btree (hold_id)", "CREATE UNIQUE INDEX slot_claims_pkey ON commerce.slot_claims USING btree (start_time_utc)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": ["slot_claims_integrity O CREATE CONSTRAINT TRIGGER slot_claims_integrity AFTER INSERT OR DELETE OR UPDATE ON commerce.slot_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION migration.check_slot_claim_integrity_trigger()"], "cols": ["backend_owner text NN D:''supabase''::text", "booking_id uuid", "claim_type text NN", "claimed_at timestamp with time zone NN D:now()", "expires_at timestamp with time zone", "hold_id uuid", "legacy_sanity_id text", "source_hash text", "source_revision text", "start_time_utc timestamp with time zone NN"], "cons": ["commerce_slot_claims_backend_owner_check CHECK ((backend_owner = ANY (ARRAY[''sanity''::text, ''supabase''::text])))", "slot_claims_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES commerce.bookings(id) ON DELETE RESTRICT", "slot_claims_check CHECK ((((claim_type = ''hold''::text) AND (hold_id IS NOT NULL) AND (booking_id IS NULL) AND (expires_at IS NOT NULL)) OR ((claim_type = ''booking''::text) AND (booking_id IS NOT NULL) AND (hold_id IS NULL) AND (expires_at IS NULL))))", "slot_claims_claim_type_check CHECK ((claim_type = ANY (ARRAY[''hold''::text, ''booking''::text])))", "slot_claims_hold_id_fkey FOREIGN KEY (hold_id) REFERENCES commerce.slot_holds(id) ON DELETE RESTRICT", "slot_claims_integrity TRIGGER DEFERRABLE INITIALLY DEFERRED", "slot_claims_pkey PRIMARY KEY (start_time_utc)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','commerce.slot_claims' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('commerce.slot_holds')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX slot_holds_payment_record_id_idx ON commerce.slot_holds USING btree (payment_record_id)", "CREATE UNIQUE INDEX slot_holds_legacy_sanity_id_key ON commerce.slot_holds USING btree (legacy_sanity_id)", "CREATE UNIQUE INDEX slot_holds_pkey ON commerce.slot_holds USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": ["commerce_slot_holds_skip_unchanged_projection O CREATE TRIGGER commerce_slot_holds_skip_unchanged_projection BEFORE UPDATE ON commerce.slot_holds FOR EACH ROW EXECUTE FUNCTION migration.skip_unchanged_commerce_projection()", "slot_holds_claim_integrity O CREATE CONSTRAINT TRIGGER slot_holds_claim_integrity AFTER INSERT OR DELETE OR UPDATE ON commerce.slot_holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION migration.check_slot_claim_integrity_trigger()", "slot_holds_require_payment_claim O CREATE TRIGGER slot_holds_require_payment_claim BEFORE INSERT OR UPDATE ON commerce.slot_holds FOR EACH ROW EXECUTE FUNCTION migration.require_payment_hold_claim()"], "cols": ["backend_owner text NN D:''supabase''::text", "created_at timestamp with time zone NN D:now()", "cutover_generation integer NN D:0", "expires_at timestamp with time zone NN", "id uuid NN D:gen_random_uuid()", "imported_at timestamp with time zone", "legacy_sanity_id text", "owner_token_hash text", "package_legacy_id text", "package_title text NN", "payload jsonb NN D:''{}''::jsonb", "payment_record_id uuid", "phase text NN", "release_reason text", "released_at timestamp with time zone", "source_backend text NN D:''sanity''::text", "source_created_at timestamp with time zone", "source_hash text", "source_revision text", "source_updated_at timestamp with time zone", "start_time_utc timestamp with time zone NN", "updated_at timestamp with time zone NN D:now()"], "cons": ["commerce_slot_holds_backend_owner_check CHECK ((backend_owner = ANY (ARRAY[''sanity''::text, ''supabase''::text])))", "slot_holds_check CHECK (((phase <> ALL (ARRAY[''released''::text, ''expired''::text])) OR (released_at IS NOT NULL)))", "slot_holds_claim_integrity TRIGGER DEFERRABLE INITIALLY DEFERRED", "slot_holds_legacy_sanity_id_key UNIQUE (legacy_sanity_id)", "slot_holds_payment_record_fkey FOREIGN KEY (payment_record_id) REFERENCES commerce.payment_records(id) ON DELETE SET NULL", "slot_holds_phase_check CHECK ((phase = ANY (ARRAY[''active''::text, ''payment''::text, ''consumed''::text, ''released''::text, ''expired''::text])))", "slot_holds_pkey PRIMARY KEY (id)", "slot_holds_source_backend_check CHECK ((source_backend = ANY (ARRAY[''sanity''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','commerce.slot_holds' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('migration.commerce_commands')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX commerce_commands_pkey ON migration.commerce_commands USING btree (command_id)"], "pol": ["commerce_commands_deny_browser * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["command_id text NN", "completed_at timestamp with time zone NN D:now()", "created_at timestamp with time zone NN D:now()", "cutover_generation integer NN", "operation text NN D:''document_mutation''::text", "request_hash text NN", "result jsonb NN"], "cons": ["commerce_commands_command_id_check CHECK ((command_id ~ ''^[A-Za-z0-9._:-]{8,160}$''::text))", "commerce_commands_pkey PRIMARY KEY (command_id)", "commerce_commands_request_hash_check CHECK ((request_hash ~ ''^[0-9a-f]{64}$''::text))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','migration.commerce_commands' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('migration.source_documents')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX source_documents_booking_paypal_order_idx ON migration.source_documents USING btree (((payload -> ''paypalOrderId''::text)), legacy_sanity_id) WHERE ((document_type = ''booking''::text) AND (NOT tombstoned))", "CREATE INDEX source_documents_type_idx ON migration.source_documents USING btree (document_type)", "CREATE UNIQUE INDEX source_documents_pkey ON migration.source_documents USING btree (legacy_sanity_id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": ["source_documents_project_referral O CREATE TRIGGER source_documents_project_referral AFTER INSERT OR UPDATE OF payload, source_hash, tombstoned ON migration.source_documents FOR EACH ROW EXECUTE FUNCTION migration.project_referral_source_change()"], "cols": ["backend_owner text NN D:''sanity''::text", "cms_imported boolean NN D:false", "cutover_generation integer NN D:0", "document_type text NN", "first_seen_at timestamp with time zone NN D:now()", "last_seen_at timestamp with time zone NN D:now()", "legacy_sanity_id text NN", "operational_imported boolean NN D:false", "payload jsonb NN", "source_created_at timestamp with time zone", "source_hash text NN", "source_revision text", "source_updated_at timestamp with time zone", "tombstoned boolean NN D:false", "tombstoned_at timestamp with time zone"], "cons": ["source_documents_backend_owner_check CHECK ((backend_owner = ANY (ARRAY[''sanity''::text, ''supabase''::text])))", "source_documents_pkey PRIMARY KEY (legacy_sanity_id)", "source_documents_source_hash_check CHECK ((source_hash ~ ''^[0-9a-f]{64}$''::text))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','migration.source_documents' using errcode='55000'; end if;
end $adapted$;
do $guard$ begin
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.rls_auto_enable()') is distinct from '{"md5": "6998ea6b4c2480f5d2e34b5dcf3f8d36", "owner": "postgres", "secdef": true, "config": ["search_path=pg_catalog"], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.rls_auto_enable()' using errcode='55000'; end if;
end $guard$;
do $platform$ begin
if (select coalesce(jsonb_agg(jsonb_build_object('name',evtname,'owner',pg_get_userbyid(evtowner),'event',evtevent,'tags',evttags,'enabled',evtenabled,'function',evtfoid::regprocedure::text) order by evtname),'[]'::jsonb) from pg_event_trigger) is distinct from '[{"enabled": "O", "event": "ddl_command_end", "function": "rls_auto_enable()", "name": "ensure_rls", "owner": "postgres", "tags": ["CREATE TABLE", "CREATE TABLE AS", "SELECT INTO"]}, {"enabled": "O", "event": "sql_drop", "function": "set_graphql_placeholder()", "name": "issue_graphql_placeholder", "owner": "supabase_admin", "tags": ["DROP EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "grant_pg_cron_access()", "name": "issue_pg_cron_access", "owner": "supabase_admin", "tags": ["CREATE EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "grant_pg_graphql_access()", "name": "issue_pg_graphql_access", "owner": "supabase_admin", "tags": ["CREATE EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "grant_pg_net_access()", "name": "issue_pg_net_access", "owner": "supabase_admin", "tags": ["CREATE EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "pgrst_ddl_watch()", "name": "pgrst_ddl_watch", "owner": "supabase_admin", "tags": null}, {"enabled": "O", "event": "sql_drop", "function": "pgrst_drop_watch()", "name": "pgrst_drop_watch", "owner": "supabase_admin", "tags": null}]'::jsonb then raise exception 'Unknown platform event-trigger preimage' using errcode='55000'; end if;
if (select jsonb_build_object('name','ops.bookings_overview','owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass('ops.bookings_overview')) is distinct from '{"acl": "{postgres=arwdDxtm/postgres,service_role=r/postgres}", "name": "ops.bookings_overview", "options": ["security_invoker=true"], "owner": "postgres", "md5": "8aa3513bf4cff2d9254ff90e81966a94"}'::jsonb then raise exception 'Unknown protected ops view preimage: %','ops.bookings_overview' using errcode='55000'; end if;
if (select jsonb_build_object('name','ops.recent_holds','owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass('ops.recent_holds')) is distinct from '{"acl": "{postgres=arwdDxtm/postgres,service_role=r/postgres}", "name": "ops.recent_holds", "options": ["security_invoker=true"], "owner": "postgres", "md5": "1794aca37d067940bd104fcac8de45c8"}'::jsonb then raise exception 'Unknown protected ops view preimage: %','ops.recent_holds' using errcode='55000'; end if;
if (select jsonb_build_object('name','ops.payments_overview','owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass('ops.payments_overview')) is distinct from '{"acl": "{postgres=arwdDxtm/postgres,service_role=r/postgres}", "name": "ops.payments_overview", "options": ["security_invoker=true"], "owner": "postgres", "md5": "d1ccab5d81b2311bbfe4c29a615080b1"}'::jsonb then raise exception 'Unknown protected ops view preimage: %','ops.payments_overview' using errcode='55000'; end if;
end $platform$;
do $version$ begin if current_user<>'postgres' then raise exception 'Apply role must match captured object owner postgres' using errcode='55000'; end if; if to_regclass('supabase_migrations.schema_migrations') is not null then if exists(select 1 from supabase_migrations.schema_migrations where version='20260718011000') then raise exception 'Migration version already recorded: %','20260718011000' using errcode='55000'; end if; end if; end $version$;
set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_apply_commerce_document_mutations(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutation jsonb;
  v_document jsonb;
  v_operation text;
  v_id text;
  v_type text;
  v_expected_revision text;
begin
  if btrim(coalesce(p_command_id, '')) !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid commerce command id' using errcode = '22023';
  end if;
  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) < 1
     or jsonb_array_length(p_mutations) > 100 then
    raise exception 'p_mutations must contain between 1 and 100 mutations'
      using errcode = '22023';
  end if;
  if pg_catalog.octet_length(p_mutations::text) > 1048576 then
    raise exception 'commerce mutation payload exceeds 1 MiB'
      using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  for v_mutation in
    select value from jsonb_array_elements(p_mutations)
  loop
    if jsonb_typeof(v_mutation) <> 'object' then
      raise exception 'commerce mutations must be JSON objects'
        using errcode = '22023';
    end if;

    v_operation := v_mutation->>'operation';
    v_document := v_mutation->'document';
    v_id := coalesce(v_mutation->>'id', v_document->>'_id', '');
    v_type := nullif(btrim(coalesce(v_document->>'_type', '')), '');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');

    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation'
        using errcode = '22023';
    end if;
    if v_id = ''
       or v_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in v_id) > 0 then
      raise exception 'document mutation is missing or has an invalid id'
        using errcode = '22023';
    end if;
    if v_expected_revision is not null
       and char_length(v_expected_revision) > 256 then
      raise exception 'document mutation revision is too long'
        using errcode = '22023';
    end if;

    if v_operation <> 'delete' then
      if jsonb_typeof(v_document) <> 'object'
         or pg_catalog.octet_length(v_document::text) > 262144
         or v_type is null
         or char_length(v_type) > 128
         or v_type !~ '^[A-Za-z][A-Za-z0-9_.-]*$' then
        raise exception 'document mutation has an invalid document'
          using errcode = '22023';
      end if;
      if v_document ? '_id' and v_document->>'_id' <> v_id then
        raise exception 'document mutation identity mismatch'
          using errcode = '22023';
      end if;
    end if;
  end loop;

  return migration.roo_apply_commerce_document_mutations_unbounded(
    p_command_id,
    p_mutations,
    p_cutover_generation
  );
end;
$$;

revoke all on function migration.roo_apply_commerce_document_mutations_unbounded(
  text,
  jsonb,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.roo_apply_commerce_document_mutations(
  text,
  jsonb,
  integer
) from public, anon, authenticated, service_role;
grant execute on function public.roo_apply_commerce_document_mutations(
  text,
  jsonb,
  integer
) to service_role;

notify pgrst, 'reload schema';

commit;

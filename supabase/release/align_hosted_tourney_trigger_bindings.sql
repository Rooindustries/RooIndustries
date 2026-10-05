begin;
set local search_path=public,extensions;
do $guard$ begin
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)') is distinct from null::jsonb then raise exception 'Unknown function preimage: %','public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_backfill_tourney_email_history_v4(p_actor text)') is distinct from null::jsonb then raise exception 'Unknown function preimage: %','public.roo_backfill_tourney_email_history_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='tourney.capture_mirror_event()') is distinct from '{"md5": "d181275b14111e9824d8689ebd8573d1", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','tourney.capture_mirror_event()' using errcode='55000'; end if;
end $guard$;
do $shape$ begin
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('accounts.discord_role_assignments')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX discord_role_assignments_claim_v4_idx ON accounts.discord_role_assignments USING btree (status, updated_at, principal_id) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text, ''processing''::text]))", "CREATE INDEX discord_role_assignments_pending_age_v4_idx ON accounts.discord_role_assignments USING btree (pending_since, principal_id) WHERE (status = ANY (ARRAY[''pending''::text, ''processing''::text, ''retry''::text]))", "CREATE INDEX discord_role_assignments_retry_idx ON accounts.discord_role_assignments USING btree (status, updated_at) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text]))", "CREATE UNIQUE INDEX discord_role_assignments_discord_user_id_key ON accounts.discord_role_assignments USING btree (discord_user_id)", "CREATE UNIQUE INDEX discord_role_assignments_pkey ON accounts.discord_role_assignments USING btree (user_id)", "CREATE UNIQUE INDEX discord_role_assignments_principal_key ON accounts.discord_role_assignments USING btree (principal_id)"], "pol": ["discord_role_assignments_service_role_only * true | true roles:service_role"], "rls": true, "trg": ["capture_tourney_mirror_event O CREATE TRIGGER capture_tourney_mirror_event AFTER INSERT OR DELETE OR UPDATE ON accounts.discord_role_assignments FOR EACH ROW EXECUTE FUNCTION tourney.capture_mirror_event_v4()", "discord_role_assignments_assign_principal O CREATE TRIGGER discord_role_assignments_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.discord_role_assignments FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id()", "set_discord_assignment_pending_since O CREATE TRIGGER set_discord_assignment_pending_since BEFORE INSERT OR UPDATE ON accounts.discord_role_assignments FOR EACH ROW EXECUTE FUNCTION accounts.set_discord_assignment_pending_since()"], "cols": ["applied_at timestamp with time zone", "applied_generation bigint NN D:0", "applied_role text NN D:''none''::text", "attempt_count integer NN D:0", "blocked_at timestamp with time zone", "created_at timestamp with time zone NN D:now()", "desired_role text NN D:''none''::text", "discord_user_id text NN", "generation bigint NN D:1", "guild_id text NN", "joined_at timestamp with time zone", "last_error text", "lease_expires_at timestamp with time zone", "lease_id uuid", "max_attempts integer NN D:12", "pending_since timestamp with time zone", "player_id text", "previous_discord_user_id text", "principal_id uuid NN", "stale_discord_user_ids text[] NN D:''{}''::text[]", "status text NN D:''pending''::text", "tourney_role text", "updated_at timestamp with time zone NN D:now()", "user_id uuid NN"], "cons": ["discord_role_assignments_applied_generation_check CHECK ((applied_generation >= 0))", "discord_role_assignments_applied_role_check CHECK ((applied_role = ANY (ARRAY[''none''::text, ''participant''::text, ''host''::text])))", "discord_role_assignments_attempt_count_check CHECK ((attempt_count >= 0))", "discord_role_assignments_desired_role_check CHECK ((desired_role = ANY (ARRAY[''none''::text, ''participant''::text, ''host''::text])))", "discord_role_assignments_discord_user_id_check CHECK ((discord_user_id ~ ''^[0-9]{5,30}$''::text))", "discord_role_assignments_discord_user_id_key UNIQUE (discord_user_id)", "discord_role_assignments_generation_check CHECK ((generation > 0))", "discord_role_assignments_guild_id_check CHECK ((guild_id ~ ''^[0-9]{5,30}$''::text))", "discord_role_assignments_pkey PRIMARY KEY (user_id)", "discord_role_assignments_previous_discord_user_id_check CHECK (((previous_discord_user_id IS NULL) OR (previous_discord_user_id ~ ''^[0-9]{5,30}$''::text)))", "discord_role_assignments_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE", "discord_role_assignments_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''processing''::text, ''applied''::text, ''retry''::text, ''blocked''::text, ''blocked_reauth''::text, ''dead_letter''::text])))", "discord_role_assignments_tourney_role_check CHECK (((tourney_role IS NULL) OR (tourney_role = ANY (ARRAY[''tourney_player''::text, ''tourney_viewer''::text, ''tourney_caster''::text, ''tourney_owner''::text]))))", "discord_role_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown relation preimage: %','accounts.discord_role_assignments' using errcode='55000'; end if;
end $shape$;
do $guard$ begin
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='migration.roo_apply_commerce_document_mutations_unbounded(p_command_id text, p_mutations jsonb, p_cutover_generation integer)') is distinct from '{"md5": "01d6894ccbb6f0973b1c07b8eb218cbb", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','migration.roo_apply_commerce_document_mutations_unbounded(p_command_id text, p_mutations jsonb, p_cutover_generation integer)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_activate_tourney_schema_v4(p_actor text)') is distinct from '{"md5": "93852147903a00038ffbc267c877a61a", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_activate_tourney_schema_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)') is distinct from null::jsonb then raise exception 'Unknown function preimage: %','public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer)') is distinct from '{"md5": "2c785bbf3aad5ad12a86495d460a1d13", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_backfill_tourney_email_history_v4(p_actor text)') is distinct from null::jsonb then raise exception 'Unknown function preimage: %','public.roo_backfill_tourney_email_history_v4(p_actor text)' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_tourney_readiness()') is distinct from '{"md5": "bfa80fe5a52ce9cd0067caedb5d39dcc", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_tourney_readiness()' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.roo_tourney_readiness_before_trigger_binding_v4()') is distinct from '{"md5": "0cf64ec1347ea6459153b6976cb96421", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.roo_tourney_readiness_before_trigger_binding_v4()' using errcode='55000'; end if;
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='tourney.capture_mirror_event()') is distinct from '{"md5": "d181275b14111e9824d8689ebd8573d1", "owner": "postgres", "secdef": true, "config": ["search_path=\"\""], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','tourney.capture_mirror_event()' using errcode='55000'; end if;
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
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('accounts.discord_role_assignments')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX discord_role_assignments_claim_v4_idx ON accounts.discord_role_assignments USING btree (status, updated_at, principal_id) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text, ''processing''::text]))", "CREATE INDEX discord_role_assignments_pending_age_v4_idx ON accounts.discord_role_assignments USING btree (pending_since, principal_id) WHERE (status = ANY (ARRAY[''pending''::text, ''processing''::text, ''retry''::text]))", "CREATE INDEX discord_role_assignments_retry_idx ON accounts.discord_role_assignments USING btree (status, updated_at) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text]))", "CREATE UNIQUE INDEX discord_role_assignments_discord_user_id_key ON accounts.discord_role_assignments USING btree (discord_user_id)", "CREATE UNIQUE INDEX discord_role_assignments_pkey ON accounts.discord_role_assignments USING btree (user_id)", "CREATE UNIQUE INDEX discord_role_assignments_principal_key ON accounts.discord_role_assignments USING btree (principal_id)"], "pol": ["discord_role_assignments_service_role_only * true | true roles:service_role"], "rls": true, "trg": ["capture_tourney_mirror_event O CREATE TRIGGER capture_tourney_mirror_event AFTER INSERT OR DELETE OR UPDATE ON accounts.discord_role_assignments FOR EACH ROW EXECUTE FUNCTION tourney.capture_mirror_event_v4()", "discord_role_assignments_assign_principal O CREATE TRIGGER discord_role_assignments_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.discord_role_assignments FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id()", "set_discord_assignment_pending_since O CREATE TRIGGER set_discord_assignment_pending_since BEFORE INSERT OR UPDATE ON accounts.discord_role_assignments FOR EACH ROW EXECUTE FUNCTION accounts.set_discord_assignment_pending_since()"], "cols": ["applied_at timestamp with time zone", "applied_generation bigint NN D:0", "applied_role text NN D:''none''::text", "attempt_count integer NN D:0", "blocked_at timestamp with time zone", "created_at timestamp with time zone NN D:now()", "desired_role text NN D:''none''::text", "discord_user_id text NN", "generation bigint NN D:1", "guild_id text NN", "joined_at timestamp with time zone", "last_error text", "lease_expires_at timestamp with time zone", "lease_id uuid", "max_attempts integer NN D:12", "pending_since timestamp with time zone", "player_id text", "previous_discord_user_id text", "principal_id uuid NN", "stale_discord_user_ids text[] NN D:''{}''::text[]", "status text NN D:''pending''::text", "tourney_role text", "updated_at timestamp with time zone NN D:now()", "user_id uuid NN"], "cons": ["discord_role_assignments_applied_generation_check CHECK ((applied_generation >= 0))", "discord_role_assignments_applied_role_check CHECK ((applied_role = ANY (ARRAY[''none''::text, ''participant''::text, ''host''::text])))", "discord_role_assignments_attempt_count_check CHECK ((attempt_count >= 0))", "discord_role_assignments_desired_role_check CHECK ((desired_role = ANY (ARRAY[''none''::text, ''participant''::text, ''host''::text])))", "discord_role_assignments_discord_user_id_check CHECK ((discord_user_id ~ ''^[0-9]{5,30}$''::text))", "discord_role_assignments_discord_user_id_key UNIQUE (discord_user_id)", "discord_role_assignments_generation_check CHECK ((generation > 0))", "discord_role_assignments_guild_id_check CHECK ((guild_id ~ ''^[0-9]{5,30}$''::text))", "discord_role_assignments_pkey PRIMARY KEY (user_id)", "discord_role_assignments_previous_discord_user_id_check CHECK (((previous_discord_user_id IS NULL) OR (previous_discord_user_id ~ ''^[0-9]{5,30}$''::text)))", "discord_role_assignments_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE", "discord_role_assignments_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''processing''::text, ''applied''::text, ''retry''::text, ''blocked''::text, ''blocked_reauth''::text, ''dead_letter''::text])))", "discord_role_assignments_tourney_role_check CHECK (((tourney_role IS NULL) OR (tourney_role = ANY (ARRAY[''tourney_player''::text, ''tourney_viewer''::text, ''tourney_caster''::text, ''tourney_owner''::text]))))", "discord_role_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','accounts.discord_role_assignments' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.account_snapshots')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_account_snapshots_supersedes_v4_idx ON tourney.account_snapshots USING btree (supersedes_snapshot_id) WHERE (supersedes_snapshot_id IS NOT NULL)", "CREATE UNIQUE INDEX account_snapshots_pkey ON tourney.account_snapshots USING btree (snapshot_id)", "CREATE UNIQUE INDEX account_snapshots_version_key ON tourney.account_snapshots USING btree (version)"], "pol": null, "rls": true, "trg": null, "cols": ["accounts_json jsonb NN", "canonical_hash text NN", "created_at timestamp with time zone NN D:now()", "created_by text NN", "generation integer NN D:1", "snapshot_id uuid NN D:gen_random_uuid()", "supersedes_snapshot_id uuid", "version bigint NN"], "cons": ["account_snapshots_accounts_json_check CHECK ((jsonb_typeof(accounts_json) = ANY (ARRAY[''array''::text, ''object''::text])))", "account_snapshots_canonical_hash_check CHECK ((canonical_hash ~ ''^[0-9a-f]{64}$''::text))", "account_snapshots_generation_check CHECK ((generation >= 0))", "account_snapshots_pkey PRIMARY KEY (snapshot_id)", "account_snapshots_supersedes_snapshot_id_fkey FOREIGN KEY (supersedes_snapshot_id) REFERENCES tourney.account_snapshots(snapshot_id)", "account_snapshots_version_check CHECK ((version > 0))", "account_snapshots_version_key UNIQUE (version)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.account_snapshots' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.command_receipts')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_receipts_committed_age_v4_idx ON tourney.command_receipts USING btree (committed_at, command_id) WHERE (status = ''committed''::text)", "CREATE INDEX tourney_receipts_failed_age_v4_idx ON tourney.command_receipts USING btree (failed_at, command_id) WHERE (status = ''failed''::text)", "CREATE UNIQUE INDEX command_receipts_pkey ON tourney.command_receipts USING btree (command_id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["command_id text NN", "committed_at timestamp with time zone", "completed_at timestamp with time zone", "created_at timestamp with time zone NN D:now()", "failed_at timestamp with time zone", "failure_code text", "failure_evidence jsonb NN D:''{}''::jsonb", "generation integer NN D:0", "purpose text NN", "recovered_at timestamp with time zone", "recovery_evidence jsonb NN D:''{}''::jsonb", "request_hash text NN", "result_body jsonb", "result_status integer", "status text NN D:''processing''::text", "updated_at timestamp with time zone NN D:now()"], "cons": ["command_receipts_generation_check CHECK ((generation >= 0))", "command_receipts_pkey PRIMARY KEY (command_id)", "command_receipts_request_hash_check CHECK ((request_hash ~ ''^[0-9a-f]{64}$''::text))", "command_receipts_status_check CHECK ((status = ANY (ARRAY[''processing''::text, ''committed''::text, ''completed''::text, ''failed''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.command_receipts' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.cutover_control_operations')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX cutover_control_operations_pkey ON tourney.cutover_control_operations USING btree (operation_kind, operation_id)"], "pol": null, "rls": true, "trg": ["guard_cutover_control_operation_append_only O CREATE TRIGGER guard_cutover_control_operation_append_only BEFORE DELETE OR UPDATE ON tourney.cutover_control_operations FOR EACH ROW EXECUTE FUNCTION tourney.guard_cutover_control_operation_append_only()"], "cols": ["actor text NN", "applied_at timestamp with time zone NN D:now()", "generation integer NN", "operation_id text NN", "operation_kind text NN", "primary_backend text NN", "target_writes_paused boolean NN"], "cons": ["cutover_control_operations_actor_check CHECK (((actor = btrim(actor)) AND ((char_length(actor) >= 3) AND (char_length(actor) <= 200)) AND (actor !~ ''[[:cntrl:]]''::text)))", "cutover_control_operations_check CHECK ((target_writes_paused = (operation_kind = ''pause''::text)))", "cutover_control_operations_generation_check CHECK (((generation >= 0) AND (generation <= 100)))", "cutover_control_operations_operation_id_check CHECK ((operation_id ~ ''^[a-z0-9][a-z0-9:_-]{7,127}$''::text))", "cutover_control_operations_operation_kind_check CHECK ((operation_kind = ANY (ARRAY[''pause''::text, ''resume''::text])))", "cutover_control_operations_pkey PRIMARY KEY (operation_kind, operation_id)", "cutover_control_operations_primary_backend_check CHECK ((primary_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.cutover_control_operations' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.cutover_gate_events')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_cutover_gate_events_kind_v4_idx ON tourney.cutover_gate_events USING btree (event_kind, created_at DESC)", "CREATE INDEX tourney_gate_event_generation_v4_idx ON tourney.cutover_gate_events USING btree (event_kind, generation, created_at DESC)", "CREATE UNIQUE INDEX cutover_gate_events_pkey ON tourney.cutover_gate_events USING btree (id)"], "pol": null, "rls": true, "trg": null, "cols": ["actor text NN", "created_at timestamp with time zone NN D:now()", "event_kind text NN", "evidence jsonb NN D:''{}''::jsonb", "generation integer NN", "id bigint NN"], "cons": ["cutover_gate_events_event_kind_check CHECK ((event_kind = ANY (ARRAY[''hardened_activated''::text, ''natural_mirror_verified''::text, ''zero_drift_pass''::text, ''clock_started''::text, ''clock_reset''::text, ''legacy_read_only''::text, ''fallback_bootstrap''::text])))", "cutover_gate_events_generation_check CHECK ((generation >= 0))", "cutover_gate_events_pkey PRIMARY KEY (id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.cutover_gate_events' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.cutover_metadata')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX cutover_metadata_pkey ON tourney.cutover_metadata USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["clean_since timestamp with time zone", "clock_last_evaluated_at timestamp with time zone", "clock_last_reset_reason text", "fallback_read_only boolean NN D:false", "first_zero_drift_at timestamp with time zone", "generation integer NN D:0", "hardened_active boolean NN D:false", "id text NN D:''tourney''::text", "last_pause_operation_id text", "last_resume_operation_id text", "natural_mutation_verified_at timestamp with time zone", "primary_backend text NN D:''legacy''::text", "reconciliation_heartbeat_at timestamp with time zone", "reconciliation_lease_expires_at timestamp with time zone", "reconciliation_lease_id uuid", "second_zero_drift_at timestamp with time zone", "updated_at timestamp with time zone NN D:now()", "updated_by text", "writes_paused boolean NN D:false"], "cons": ["cutover_metadata_generation_check CHECK ((generation >= 0))", "cutover_metadata_id_check CHECK ((id = ''tourney''::text))", "cutover_metadata_last_pause_operation_id_check CHECK (((last_pause_operation_id IS NULL) OR ((last_pause_operation_id = btrim(last_pause_operation_id)) AND ((char_length(last_pause_operation_id) >= 8) AND (char_length(last_pause_operation_id) <= 128)) AND (last_pause_operation_id ~ ''^[a-z0-9][a-z0-9:_-]{7,127}$''::text))))", "cutover_metadata_last_resume_operation_id_check CHECK (((last_resume_operation_id IS NULL) OR ((last_resume_operation_id = btrim(last_resume_operation_id)) AND ((char_length(last_resume_operation_id) >= 8) AND (char_length(last_resume_operation_id) <= 128)) AND (last_resume_operation_id ~ ''^[a-z0-9][a-z0-9:_-]{7,127}$''::text))))", "cutover_metadata_pkey PRIMARY KEY (id)", "cutover_metadata_primary_backend_check CHECK ((primary_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.cutover_metadata' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.email_dispatches')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_email_active_age_v4_idx ON tourney.email_dispatches USING btree (created_at, id) WHERE (status = ANY (ARRAY[''pending''::text, ''sending''::text, ''retry''::text]))", "CREATE INDEX tourney_email_dispatches_expired_lease_v4_idx ON tourney.email_dispatches USING btree (lease_expires_at, created_at) WHERE (status = ''sending''::text)", "CREATE INDEX tourney_email_dispatches_history_v4_idx ON tourney.email_dispatches USING btree (dispatch_kind, recipient_hash)", "CREATE INDEX tourney_email_dispatches_recovery_idx ON tourney.email_dispatches USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text, ''sending''::text]))", "CREATE UNIQUE INDEX email_dispatches_idempotency_key_key ON tourney.email_dispatches USING btree (idempotency_key)", "CREATE UNIQUE INDEX email_dispatches_pkey ON tourney.email_dispatches USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": ["guard_email_dispatch_terminal_state O CREATE TRIGGER guard_email_dispatch_terminal_state BEFORE UPDATE ON tourney.email_dispatches FOR EACH ROW EXECUTE FUNCTION tourney.guard_email_dispatch_terminal_state()"], "cols": ["attempt_count integer NN D:0", "audited_override_at timestamp with time zone", "audited_override_by text", "audited_override_reason text", "command_id text", "created_at timestamp with time zone NN D:now()", "dispatch_kind text NN", "id uuid NN D:gen_random_uuid()", "idempotency_key text NN", "last_error_code text", "lease_expires_at timestamp with time zone", "lease_id uuid", "next_attempt_at timestamp with time zone", "payload jsonb NN", "provider_message_id text", "recipient text NN", "recipient_hash text NN", "sent_at timestamp with time zone", "status text NN D:''pending''::text", "updated_at timestamp with time zone NN D:now()"], "cons": ["email_dispatches_dispatch_kind_check CHECK ((dispatch_kind = ANY (ARRAY[''registration''::text, ''approval''::text, ''reset''::text, ''discord_invite''::text, ''appeal''::text, ''payout''::text, ''feedback''::text])))", "email_dispatches_idempotency_key_key UNIQUE (idempotency_key)", "email_dispatches_pkey PRIMARY KEY (id)", "email_dispatches_recipient_hash_check CHECK ((recipient_hash ~ ''^[0-9a-f]{64}$''::text))", "email_dispatches_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''sending''::text, ''retry''::text, ''sent''::text, ''failed''::text, ''dead_letter''::text, ''historical_unknown''::text, ''expired''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.email_dispatches' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.external_operation_secrets')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_external_operation_secrets_expiry_v4_idx ON tourney.external_operation_secrets USING btree (expires_at, operation_key)", "CREATE UNIQUE INDEX external_operation_secrets_pkey ON tourney.external_operation_secrets USING btree (operation_key)"], "pol": null, "rls": true, "trg": null, "cols": ["created_at timestamp with time zone NN D:now()", "encrypted_payload text NN", "expires_at timestamp with time zone NN", "operation_key text NN"], "cons": ["external_operation_secrets_encrypted_payload_check CHECK (((length(encrypted_payload) >= 32) AND (length(encrypted_payload) <= 16384)))", "external_operation_secrets_operation_key_fkey FOREIGN KEY (operation_key) REFERENCES tourney.external_operations(operation_key) ON DELETE CASCADE", "external_operation_secrets_pkey PRIMARY KEY (operation_key)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.external_operation_secrets' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.external_operations')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_external_active_age_v4_idx ON tourney.external_operations USING btree (created_at, operation_key) WHERE (status = ANY (ARRAY[''pending''::text, ''processing''::text, ''retry''::text]))", "CREATE INDEX tourney_external_operations_claim_v4_idx ON tourney.external_operations USING btree (next_attempt_at, created_at, operation_key) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text, ''processing''::text]))", "CREATE INDEX tourney_external_operations_command_v4_idx ON tourney.external_operations USING btree (command_id, status, created_at)", "CREATE INDEX tourney_external_operations_dead_letter_v4_idx ON tourney.external_operations USING btree (updated_at DESC, operation_key) WHERE (status = ''dead_letter''::text)", "CREATE INDEX tourney_external_operations_expired_lease_v4_idx ON tourney.external_operations USING btree (lease_expires_at, operation_key) WHERE (status = ''processing''::text)", "CREATE INDEX tourney_external_operations_serial_v4_idx ON tourney.external_operations USING btree (serialization_key, status, next_attempt_at, created_at, operation_key) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text, ''processing''::text]))", "CREATE UNIQUE INDEX external_operations_pkey ON tourney.external_operations USING btree (operation_key)"], "pol": null, "rls": true, "trg": ["set_external_operation_serialization_key O CREATE TRIGGER set_external_operation_serialization_key BEFORE INSERT OR UPDATE OF operation_kind, entity_type, entity_id, desired_state, serialization_key ON tourney.external_operations FOR EACH ROW EXECUTE FUNCTION tourney.set_external_operation_serialization_key()"], "cols": ["attempt_count integer NN D:0", "command_id text", "completed_at timestamp with time zone", "created_at timestamp with time zone NN D:now()", "desired_state jsonb NN", "desired_state_hash text NN", "entity_id text NN", "entity_type text NN", "last_error_code text", "lease_expires_at timestamp with time zone", "lease_id uuid", "max_attempts integer NN D:12", "next_attempt_at timestamp with time zone NN D:now()", "operation_key text NN", "operation_kind text NN", "serialization_key text NN", "status text NN D:''pending''::text", "updated_at timestamp with time zone NN D:now()"], "cons": ["external_operations_attempt_count_check CHECK ((attempt_count >= 0))", "external_operations_check CHECK ((((status = ''processing''::text) AND (lease_id IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR (status <> ''processing''::text)))", "external_operations_check1 CHECK ((((status = ''applied''::text) AND (completed_at IS NOT NULL)) OR (status <> ''applied''::text)))", "external_operations_command_id_fkey FOREIGN KEY (command_id) REFERENCES tourney.command_receipts(command_id) ON DELETE RESTRICT", "external_operations_desired_state_hash_check CHECK ((desired_state_hash ~ ''^[0-9a-f]{64}$''::text))", "external_operations_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 100)))", "external_operations_operation_kind_check CHECK ((operation_kind = ANY (ARRAY[''supabase_player_auth''::text, ''supabase_admin_auth''::text, ''sanity_account_projection''::text, ''discord_membership''::text, ''discord_role_reconcile''::text, ''supabase_identity_unlink''::text])))", "external_operations_pkey PRIMARY KEY (operation_key)", "external_operations_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''processing''::text, ''retry''::text, ''applied''::text, ''dead_letter''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.external_operations' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.identity_conflicts')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_identity_conflicts_open_v4_idx ON tourney.identity_conflicts USING btree (created_at, id) WHERE (resolved_at IS NULL)", "CREATE UNIQUE INDEX identity_conflicts_pkey ON tourney.identity_conflicts USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["conflict_type text NN", "created_at timestamp with time zone NN D:now()", "details jsonb NN D:''{}''::jsonb", "id uuid NN D:gen_random_uuid()", "legacy_player_id text", "principal_id uuid", "resolved_at timestamp with time zone"], "cons": ["identity_conflicts_pkey PRIMARY KEY (id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.identity_conflicts' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.mirror_checkpoints')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX mirror_checkpoints_pkey ON tourney.mirror_checkpoints USING btree (target_backend, table_name, record_key_hash)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["applied_at timestamp with time zone NN D:now()", "event_id uuid NN", "generation integer NN D:0", "record_key_hash text NN", "source_backend text NN", "source_sequence bigint NN", "table_name text NN", "target_backend text NN"], "cons": ["mirror_checkpoints_pkey PRIMARY KEY (target_backend, table_name, record_key_hash)", "mirror_checkpoints_record_key_hash_check CHECK ((record_key_hash ~ ''^[0-9a-f]{64}$''::text))", "mirror_checkpoints_source_backend_check CHECK ((source_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))", "mirror_checkpoints_target_backend_check CHECK ((target_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.mirror_checkpoints' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.mirror_contracts')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX mirror_contracts_legacy_relation_key ON tourney.mirror_contracts USING btree (legacy_relation)", "CREATE UNIQUE INDEX mirror_contracts_pkey ON tourney.mirror_contracts USING btree (logical_table)", "CREATE UNIQUE INDEX mirror_contracts_supabase_relation_key ON tourney.mirror_contracts USING btree (supabase_relation)"], "pol": null, "rls": true, "trg": null, "cols": ["allowed_columns text[] NN", "created_at timestamp with time zone NN D:now()", "enabled boolean NN D:true", "key_columns text[] NN", "legacy_relation text NN", "logical_table text NN", "supabase_relation text NN", "updated_at timestamp with time zone NN D:now()"], "cons": ["mirror_contracts_check CHECK ((key_columns <@ allowed_columns))", "mirror_contracts_key_columns_check CHECK ((cardinality(key_columns) > 0))", "mirror_contracts_legacy_relation_key UNIQUE (legacy_relation)", "mirror_contracts_pkey PRIMARY KEY (logical_table)", "mirror_contracts_supabase_relation_key UNIQUE (supabase_relation)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.mirror_contracts' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.mirror_outbox')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_mirror_active_age_v4_idx ON tourney.mirror_outbox USING btree (occurred_at, sequence) WHERE (status = ANY (ARRAY[''pending''::text, ''processing''::text, ''retry''::text]))", "CREATE INDEX tourney_mirror_outbox_claim_v4_idx ON tourney.mirror_outbox USING btree (available_at, generation DESC, sequence) WHERE (status = ANY (ARRAY[''pending''::text, ''retry''::text, ''processing''::text]))", "CREATE INDEX tourney_mirror_outbox_dead_letter_v4_idx ON tourney.mirror_outbox USING btree (dead_lettered_at DESC, sequence) WHERE (status = ''dead_letter''::text)", "CREATE INDEX tourney_mirror_outbox_expired_lease_v4_idx ON tourney.mirror_outbox USING btree (lease_expires_at, generation, sequence) WHERE (status = ''processing''::text)", "CREATE UNIQUE INDEX mirror_outbox_event_id_key ON tourney.mirror_outbox USING btree (event_id)", "CREATE UNIQUE INDEX mirror_outbox_pkey ON tourney.mirror_outbox USING btree (sequence)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["applied_at timestamp with time zone", "attempt_count integer NN D:0", "available_at timestamp with time zone NN D:now()", "command_id text", "dead_lettered_at timestamp with time zone", "event_id uuid NN D:gen_random_uuid()", "generation integer NN D:0", "last_error_at timestamp with time zone", "last_error_code text", "lease_expires_at timestamp with time zone", "lease_id uuid", "max_attempts integer NN D:12", "occurred_at timestamp with time zone NN D:now()", "operation text NN", "record_data jsonb", "record_hash text", "record_key jsonb NN", "sequence bigint NN", "source_backend text NN", "status text NN D:''pending''::text", "table_name text NN"], "cons": ["mirror_outbox_event_id_key UNIQUE (event_id)", "mirror_outbox_generation_check CHECK ((generation >= 0))", "mirror_outbox_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 100)))", "mirror_outbox_operation_check CHECK ((operation = ANY (ARRAY[''upsert''::text, ''delete''::text])))", "mirror_outbox_pkey PRIMARY KEY (sequence)", "mirror_outbox_record_hash_check CHECK (((record_hash IS NULL) OR (record_hash ~ ''^[0-9a-f]{64}$''::text)))", "mirror_outbox_source_backend_check CHECK ((source_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))", "mirror_outbox_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''processing''::text, ''retry''::text, ''applied''::text, ''dead_letter''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.mirror_outbox' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.mirror_tombstones')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX mirror_tombstones_pkey ON tourney.mirror_tombstones USING btree (target_backend, table_name, record_key_hash)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["deleted_at timestamp with time zone NN D:now()", "generation integer NN D:0", "record_key jsonb NN", "record_key_hash text NN", "source_sequence bigint NN", "table_name text NN", "target_backend text NN"], "cons": ["mirror_tombstones_pkey PRIMARY KEY (target_backend, table_name, record_key_hash)", "mirror_tombstones_record_key_hash_check CHECK ((record_key_hash ~ ''^[0-9a-f]{64}$''::text))", "mirror_tombstones_target_backend_check CHECK ((target_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.mirror_tombstones' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.parity_runs')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_parity_lookup_v4_idx ON tourney.parity_runs USING btree (source_backend, target_backend, generation, created_at DESC)", "CREATE INDEX tourney_parity_runs_created_idx ON tourney.parity_runs USING btree (created_at DESC)", "CREATE UNIQUE INDEX parity_runs_pkey ON tourney.parity_runs USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["canonical_hashes jsonb NN D:''{}''::jsonb", "counts jsonb NN D:''{}''::jsonb", "created_at timestamp with time zone NN D:now()", "drift jsonb NN D:''{}''::jsonb", "generation integer NN D:0", "id uuid NN D:gen_random_uuid()", "relationships jsonb NN D:''{}''::jsonb", "shadow_results jsonb NN D:''{}''::jsonb", "source_backend text NN", "status text NN", "status_counts jsonb NN D:''{}''::jsonb", "target_backend text NN"], "cons": ["parity_runs_pkey PRIMARY KEY (id)", "parity_runs_source_backend_check CHECK ((source_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))", "parity_runs_status_check CHECK ((status = ANY (ARRAY[''clean''::text, ''drift''::text, ''failed''::text])))", "parity_runs_target_backend_check CHECK ((target_backend = ANY (ARRAY[''legacy''::text, ''supabase''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.parity_runs' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.schema_metadata')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX schema_metadata_pkey ON tourney.schema_metadata USING btree (schema_name)"], "pol": ["tourney_schema_metadata_deny_browser * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["schema_name text NN", "schema_version integer NN", "updated_at timestamp with time zone NN D:now()"], "cons": ["schema_metadata_pkey PRIMARY KEY (schema_name)", "schema_metadata_schema_version_check CHECK ((schema_version > 0))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.schema_metadata' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.shadow_latency_baselines')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX shadow_latency_baselines_pkey ON tourney.shadow_latency_baselines USING btree (route)"], "pol": null, "rls": true, "trg": null, "cols": ["captured_at timestamp with time zone NN D:now()", "captured_by text NN", "primary_p95_ms integer NN", "route text NN", "sample_count integer NN", "source_window_ended_at timestamp with time zone", "source_window_started_at timestamp with time zone"], "cons": ["shadow_latency_baselines_pkey PRIMARY KEY (route)", "shadow_latency_baselines_primary_p95_ms_check CHECK ((primary_p95_ms >= 0))", "shadow_latency_baselines_route_check CHECK ((route = ANY (ARRAY[''public_roster''::text, ''public_bracket''::text, ''admin_players''::text, ''appeals''::text, ''payouts''::text])))", "shadow_latency_baselines_sample_count_check CHECK ((sample_count >= 30))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.shadow_latency_baselines' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.shadow_observations')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_shadow_observations_route_idx ON tourney.shadow_observations USING btree (route, observed_at DESC)", "CREATE UNIQUE INDEX shadow_observations_pkey ON tourney.shadow_observations USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["error_match boolean NN", "id bigint NN", "observed_at timestamp with time zone NN D:now()", "ordering_match boolean NN", "primary_error_code text", "primary_hash text", "primary_latency_ms integer NN D:0", "primary_status integer", "route text NN", "shadow_error_code text", "shadow_hash text", "shadow_latency_ms integer NN D:0", "shadow_status integer", "shape_match boolean NN", "value_match boolean NN"], "cons": ["shadow_observations_pkey PRIMARY KEY (id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.shadow_observations' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_appeals')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_appeals_created_cursor_idx ON tourney.tourney_appeals USING btree (created_at DESC, id DESC)", "CREATE INDEX tourney_appeals_player_cursor_idx ON tourney.tourney_appeals USING btree (submitter_player_id, created_at DESC, id DESC) WHERE (submitter_player_id IS NOT NULL)", "CREATE UNIQUE INDEX tourney_appeals_pkey ON tourney.tourney_appeals USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["captain_name text", "created_at timestamp with time zone NN D:now()", "details text NN", "evidence_url text", "id text NN", "ruling text", "status text NN D:''open''::text", "subject_name text", "subject_player_id text", "submitter_player_id text", "submitter_username text NN", "team_name text", "title text NN", "type text NN", "updated_at timestamp with time zone NN D:now()", "updated_by text"], "cons": ["tourney_appeals_pkey PRIMARY KEY (id)", "tourney_appeals_status_check CHECK ((status = ANY (ARRAY[''open''::text, ''reviewing''::text, ''upheld''::text, ''denied''::text, ''closed''::text])))", "tourney_appeals_type_check CHECK ((type = ANY (ARRAY[''team-appeal''::text, ''captain-complaint''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_appeals' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_audit')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_bracket_audit_created_cursor_idx ON tourney.tourney_bracket_audit USING btree (created_at DESC, id DESC)", "CREATE UNIQUE INDEX tourney_bracket_audit_pkey ON tourney.tourney_bracket_audit USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["action text NN", "actor_username text NN", "created_at timestamp with time zone NN D:now()", "id text NN", "match_id integer", "payload jsonb NN D:''{}''::jsonb", "reason text", "team_id text"], "cons": ["tourney_bracket_audit_pkey PRIMARY KEY (id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_audit' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_counters')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_bracket_counters_pkey ON tourney.tourney_bracket_counters USING btree (entity_type)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["entity_type text NN", "next_id integer NN D:0"], "cons": ["tourney_bracket_counters_entity_type_check CHECK ((entity_type = ANY (ARRAY[''participant''::text, ''stage''::text, ''group''::text, ''round''::text, ''match''::text, ''match_game''::text])))", "tourney_bracket_counters_next_id_check CHECK ((next_id >= 0))", "tourney_bracket_counters_pkey PRIMARY KEY (entity_type)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_counters' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_entities')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_bracket_entities_pkey ON tourney.tourney_bracket_entities USING btree (entity_type, entity_id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["data jsonb NN", "entity_id integer NN", "entity_type text NN", "updated_at timestamp with time zone NN D:now()"], "cons": ["tourney_bracket_entities_entity_type_check CHECK ((entity_type = ANY (ARRAY[''participant''::text, ''stage''::text, ''group''::text, ''round''::text, ''match''::text, ''match_game''::text])))", "tourney_bracket_entities_pkey PRIMARY KEY (entity_type, entity_id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_entities' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_lock')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_bracket_lock_pkey ON tourney.tourney_bracket_lock USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["id text NN", "locked_by text", "locked_until timestamp with time zone NN"], "cons": ["tourney_bracket_lock_pkey PRIMARY KEY (id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_lock' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_meta')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_bracket_meta_pkey ON tourney.tourney_bracket_meta USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["generated_at timestamp with time zone", "id text NN", "published boolean NN D:false", "stage_id integer", "status text NN D:''draft''::text", "updated_at timestamp with time zone NN D:now()", "updated_by text"], "cons": ["tourney_bracket_meta_pkey PRIMARY KEY (id)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_meta' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_team_members')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_bracket_team_members_team_id_idx ON tourney.tourney_bracket_team_members USING btree (team_id)", "CREATE UNIQUE INDEX tourney_bracket_team_members_pkey ON tourney.tourney_bracket_team_members USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["created_at timestamp with time zone NN D:now()", "display_name text NN", "id text NN", "player_id text", "role_play text", "team_id text NN"], "cons": ["tourney_bracket_team_members_pkey PRIMARY KEY (id)", "tourney_bracket_team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES tourney.tourney_bracket_teams(id) ON DELETE CASCADE"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_team_members' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_bracket_teams')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_bracket_teams_name_key ON tourney.tourney_bracket_teams USING btree (name)", "CREATE UNIQUE INDEX tourney_bracket_teams_pkey ON tourney.tourney_bracket_teams USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["created_at timestamp with time zone NN D:now()", "id text NN", "name text NN", "seed_order integer", "status text NN D:''active''::text", "updated_at timestamp with time zone NN D:now()", "updated_by text"], "cons": ["tourney_bracket_teams_name_key UNIQUE (name)", "tourney_bracket_teams_pkey PRIMARY KEY (id)", "tourney_bracket_teams_status_check CHECK ((status = ANY (ARRAY[''active''::text, ''disqualified''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_bracket_teams' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_payouts')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_payouts_created_cursor_idx ON tourney.tourney_payouts USING btree (created_at DESC, id DESC)", "CREATE INDEX tourney_payouts_player_cursor_idx ON tourney.tourney_payouts USING btree (player_id, created_at DESC, id DESC)", "CREATE UNIQUE INDEX tourney_payouts_pkey ON tourney.tourney_payouts USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": ["guard_tourney_payout_transition O CREATE TRIGGER guard_tourney_payout_transition BEFORE UPDATE ON tourney.tourney_payouts FOR EACH ROW EXECUTE FUNCTION tourney.guard_payout_transition()"], "cols": ["amount_usd numeric(10,2) NN D:0", "created_at timestamp with time zone NN D:now()", "display_name text NN", "id text NN", "notes text", "payout_email text", "payout_type text NN", "player_id text NN", "status text NN D:''pending''::text", "team_name text", "updated_at timestamp with time zone NN D:now()", "updated_by text"], "cons": ["tourney_payouts_amount_usd_check CHECK ((amount_usd >= (0)::numeric))", "tourney_payouts_payout_type_check CHECK ((payout_type = ANY (ARRAY[''placement''::text, ''mvp''::text, ''proceeds''::text, ''adjustment''::text])))", "tourney_payouts_pkey PRIMARY KEY (id)", "tourney_payouts_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''ready''::text, ''paid''::text, ''void''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_payouts' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_player_auth_operations')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_auth_active_age_v4_idx ON tourney.tourney_player_auth_operations USING btree (created_at, id) WHERE (operation_status = ANY (ARRAY[''pending''::text, ''processing''::text, ''auth_applied''::text, ''retry''::text]))", "CREATE INDEX tourney_auth_operations_pending_idx ON tourney.tourney_player_auth_operations USING btree (operation_status, next_attempt_at, created_at) WHERE (operation_status = ANY (ARRAY[''pending''::text, ''retry''::text, ''processing''::text, ''auth_applied''::text]))", "CREATE INDEX tourney_auth_operations_player_idx ON tourney.tourney_player_auth_operations USING btree (player_id, created_at DESC)", "CREATE UNIQUE INDEX tourney_auth_operations_one_active_decision ON tourney.tourney_player_auth_operations USING btree (player_id) WHERE ((operation_kind = ''decision''::text) AND (operation_status = ANY (ARRAY[''pending''::text, ''processing''::text, ''auth_applied''::text, ''retry''::text])))", "CREATE UNIQUE INDEX tourney_auth_operations_one_per_token ON tourney.tourney_player_auth_operations USING btree (token_id) WHERE (token_id IS NOT NULL)", "CREATE UNIQUE INDEX tourney_player_auth_operations_operation_key_key ON tourney.tourney_player_auth_operations USING btree (operation_key)", "CREATE UNIQUE INDEX tourney_player_auth_operations_pkey ON tourney.tourney_player_auth_operations USING btree (id)"], "pol": ["tourney_auth_operations_deny_browser * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["attempt_count integer NN D:0", "completed_at timestamp with time zone", "created_at timestamp with time zone NN D:now()", "desired_credential_version text", "desired_registration_pool text", "desired_role text", "desired_status text", "id uuid NN D:gen_random_uuid()", "last_error text", "lease_expires_at timestamp with time zone", "lease_id uuid", "next_attempt_at timestamp with time zone NN D:now()", "operation_key text NN", "operation_kind text NN", "operation_payload jsonb NN D:''{}''::jsonb", "operation_status text NN D:''pending''::text", "password_hash text", "player_id text NN", "token_id text", "updated_at timestamp with time zone NN D:now()"], "cons": ["tourney_player_auth_operations_attempt_count_check CHECK ((attempt_count >= 0))", "tourney_player_auth_operations_check CHECK (((password_hash IS NULL) OR ((operation_kind = ''password_reset''::text) AND (password_hash ~ ''^\\$2[aby]\\$[0-9]{2}\\$''::text))))", "tourney_player_auth_operations_check1 CHECK ((((operation_status = ''processing''::text) AND (lease_id IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR (operation_status <> ''processing''::text)))", "tourney_player_auth_operations_check2 CHECK ((((operation_status = ''completed''::text) AND (completed_at IS NOT NULL)) OR (operation_status <> ''completed''::text)))", "tourney_player_auth_operations_desired_registration_pool_check CHECK (((desired_registration_pool IS NULL) OR (desired_registration_pool = ANY (ARRAY[''main''::text, ''substitute''::text]))))", "tourney_player_auth_operations_desired_role_check CHECK (((desired_role IS NULL) OR (desired_role = ANY (ARRAY[''player''::text, ''viewer''::text, ''caster''::text, ''owner''::text]))))", "tourney_player_auth_operations_desired_status_check CHECK (((desired_status IS NULL) OR (desired_status = ANY (ARRAY[''pending''::text, ''approved''::text, ''denied''::text, ''withdrawn''::text, ''removed''::text]))))", "tourney_player_auth_operations_operation_key_check CHECK (((char_length(operation_key) >= 8) AND (char_length(operation_key) <= 240)))", "tourney_player_auth_operations_operation_key_key UNIQUE (operation_key)", "tourney_player_auth_operations_operation_kind_check CHECK ((operation_kind = ANY (ARRAY[''decision''::text, ''password_reset''::text, ''player_sync''::text])))", "tourney_player_auth_operations_operation_status_check CHECK ((operation_status = ANY (ARRAY[''pending''::text, ''processing''::text, ''auth_applied''::text, ''completed''::text, ''retry''::text])))", "tourney_player_auth_operations_pkey PRIMARY KEY (id)", "tourney_player_auth_operations_player_id_fkey FOREIGN KEY (player_id) REFERENCES tourney.tourney_players(id) ON DELETE CASCADE", "tourney_player_auth_operations_token_id_fkey FOREIGN KEY (token_id) REFERENCES tourney.tourney_player_tokens(id) ON DELETE SET NULL"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_player_auth_operations' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_player_tokens')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_player_tokens_player_id_idx ON tourney.tourney_player_tokens USING btree (player_id)", "CREATE UNIQUE INDEX tourney_player_tokens_pkey ON tourney.tourney_player_tokens USING btree (id)", "CREATE UNIQUE INDEX tourney_player_tokens_token_hash_key ON tourney.tourney_player_tokens USING btree (token_hash)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["created_at timestamp with time zone NN D:now()", "expires_at timestamp with time zone NN", "id text NN", "player_id text NN", "purpose text NN", "recipient_email text", "recipient_role text", "recipient_username text", "recipient_version text", "token_hash text NN", "used_at timestamp with time zone", "used_by text"], "cons": ["tourney_player_tokens_pkey PRIMARY KEY (id)", "tourney_player_tokens_player_id_fkey FOREIGN KEY (player_id) REFERENCES tourney.tourney_players(id) ON DELETE CASCADE", "tourney_player_tokens_purpose_check CHECK ((purpose = ANY (ARRAY[''approve''::text, ''deny''::text, ''reset''::text])))", "tourney_player_tokens_token_hash_key UNIQUE (token_hash)", "tourney_reset_token_version_v4_check CHECK (((purpose <> ''reset''::text) OR (NULLIF(btrim(recipient_version), ''''::text) IS NOT NULL)))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_player_tokens' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_players')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE INDEX tourney_players_approved_roster_idx ON tourney.tourney_players USING btree (registration_pool, role_play, display_name, id) WHERE (status = ''approved''::text)", "CREATE INDEX tourney_players_created_cursor_idx ON tourney.tourney_players USING btree (created_at DESC, id DESC)", "CREATE UNIQUE INDEX tourney_players_discord_key_key ON tourney.tourney_players USING btree (discord_key)", "CREATE UNIQUE INDEX tourney_players_discord_user_id_unique ON tourney.tourney_players USING btree (discord_user_id) WHERE (discord_user_id IS NOT NULL)", "CREATE UNIQUE INDEX tourney_players_display_name_login_unique ON tourney.tourney_players USING btree (lower(btrim(display_name))) WHERE ((status = ANY (ARRAY[''approved''::text, ''pending''::text])) AND (display_name IS NOT NULL) AND (btrim(display_name) <> ''''::text))", "CREATE UNIQUE INDEX tourney_players_email_key ON tourney.tourney_players USING btree (email)", "CREATE UNIQUE INDEX tourney_players_pkey ON tourney.tourney_players USING btree (id)", "CREATE UNIQUE INDEX tourney_players_principal_id_unique_v4 ON tourney.tourney_players USING btree (principal_id) WHERE (principal_id IS NOT NULL)", "CREATE UNIQUE INDEX tourney_players_username_key ON tourney.tourney_players USING btree (username)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["accepted_roo_visibility boolean NN D:false", "accepted_rules boolean NN D:false", "approved_at timestamp with time zone", "approved_by text", "approved_role_play text NN D:''''::text", "available_aug_1_2 boolean NN D:false", "battlenet text NN", "created_at timestamp with time zone NN D:now()", "denied_at timestamp with time zone", "denied_by text", "discord text NN", "discord_invite_email_id text", "discord_invite_last_error text", "discord_invite_sent_at timestamp with time zone", "discord_key text NN", "discord_linked_at timestamp with time zone", "discord_oauth_global_name text", "discord_oauth_username text", "discord_role_assigned_at timestamp with time zone", "discord_role_last_error text", "discord_user_id text", "display_name text", "email text NN", "id text NN", "notes text", "password_hash text NN", "principal_id uuid", "rank_name text NN", "registration_pool text NN D:''main''::text", "removed_at timestamp with time zone", "removed_by text", "role_play text NN", "secondary_role_play text NN D:''''::text", "status text NN D:''pending''::text", "team_name text", "time_zone text NN D:''''::text", "twitch_username text", "updated_at timestamp with time zone NN D:now()", "username text NN", "version integer NN D:1", "withdrawn_at timestamp with time zone", "withdrawn_by text"], "cons": ["tourney_players_discord_key_key UNIQUE (discord_key)", "tourney_players_email_key UNIQUE (email)", "tourney_players_pkey PRIMARY KEY (id)", "tourney_players_registration_pool_check CHECK ((registration_pool = ANY (ARRAY[''main''::text, ''substitute''::text])))", "tourney_players_status_check CHECK ((status = ANY (ARRAY[''pending''::text, ''approved''::text, ''denied''::text, ''withdrawn''::text, ''removed''::text])))", "tourney_players_username_key UNIQUE (username)"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_players' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_registration_config')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_registration_config_pkey ON tourney.tourney_registration_config USING btree (id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["id text NN", "team_count integer NN D:8", "updated_at timestamp with time zone NN D:now()", "updated_by text"], "cons": ["tourney_registration_config_pkey PRIMARY KEY (id)", "tourney_registration_config_team_count_check CHECK (((team_count >= 2) AND (team_count <= 64)))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_registration_config' using errcode='55000'; end if;
if (select jsonb_build_object('kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(select string_agg(a::text,',' order by a::text) from unnest(c.relacl) a),
 'cols',(select jsonb_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NN' else '' end||coalesce(' D:'||pg_get_expr(ad.adbin,ad.adrelid),'') order by a.attname) from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'cons',(select jsonb_agg(conname||' '||pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid),
 'idx',(select jsonb_agg(pg_get_indexdef(indexrelid) order by pg_get_indexdef(indexrelid)) from pg_index where indrelid=c.oid),
 'trg',(select jsonb_agg(tgname||' '||tgenabled::text||' '||pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'pol',(select jsonb_agg(polname||' '||polcmd::text||' '||coalesce(pg_get_expr(polqual,polrelid),'')||' | '||coalesce(pg_get_expr(polwithcheck,polrelid),'')||' roles:'||(select string_agg(coalesce(r.rolname,'PUBLIC'),',' order by coalesce(r.rolname,'PUBLIC')) from unnest(polroles) roleid left join pg_roles r on r.oid=roleid) order by polname) from pg_policy where polrelid=c.oid),
 'owner',pg_get_userbyid(c.relowner)) from pg_class c where c.oid=to_regclass('tourney.tourney_session_entitlements')) is distinct from '{"acl": "postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres", "idx": ["CREATE UNIQUE INDEX tourney_session_entitlements_pkey ON tourney.tourney_session_entitlements USING btree (id)", "CREATE UNIQUE INDEX tourney_session_entitlements_player_unique ON tourney.tourney_session_entitlements USING btree (player_id)"], "pol": ["deny_browser_access * false | false roles:anon,authenticated"], "rls": true, "trg": null, "cols": ["booking_id uuid", "consumed_at timestamp with time zone", "created_at timestamp with time zone NN D:now()", "id uuid NN D:gen_random_uuid()", "player_id text NN", "status text NN D:''available''::text", "updated_at timestamp with time zone NN D:now()", "updated_by text"], "cons": ["tourney_session_entitlements_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES commerce.bookings(id) ON DELETE RESTRICT", "tourney_session_entitlements_consumed_booking_check CHECK (((status <> ''consumed''::text) OR ((booking_id IS NOT NULL) AND (consumed_at IS NOT NULL))))", "tourney_session_entitlements_pkey PRIMARY KEY (id)", "tourney_session_entitlements_player_id_fkey FOREIGN KEY (player_id) REFERENCES tourney.tourney_players(id) ON DELETE CASCADE", "tourney_session_entitlements_player_unique UNIQUE (player_id)", "tourney_session_entitlements_status_check CHECK ((status = ANY (ARRAY[''available''::text, ''consumed''::text, ''revoked''::text])))"], "kind": "r", "owner": "postgres", "force_rls": false}'::jsonb then raise exception 'Unknown adapted relation preimage: %','tourney.tourney_session_entitlements' using errcode='55000'; end if;
end $adapted$;
do $retirement$ begin if exists(select 1 from tourney.mirror_contracts where enabled) then raise exception 'Alignment requires retired zero-enabled mirror contracts' using errcode='55000'; end if; end $retirement$;
do $contracts$ begin if exists(select 1 from tourney.mirror_contracts where enabled and not (supabase_relation=any(array['accounts.discord_role_assignments','tourney.account_snapshots','tourney.command_receipts','tourney.email_dispatches','tourney.external_operations','tourney.tourney_appeals','tourney.tourney_bracket_audit','tourney.tourney_bracket_counters','tourney.tourney_bracket_entities','tourney.tourney_bracket_lock','tourney.tourney_bracket_meta','tourney.tourney_bracket_team_members','tourney.tourney_bracket_teams','tourney.tourney_payouts','tourney.tourney_player_tokens','tourney.tourney_players','tourney.tourney_registration_config']::text[]))) then raise exception 'Unknown tourney mirror contract destination' using errcode='55000'; end if; end $contracts$;
do $guard$ begin
if (select jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',(select string_agg(a::text,',' order by a::text) from unnest(p.proacl) a)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'='public.rls_auto_enable()') is distinct from '{"md5": "6998ea6b4c2480f5d2e34b5dcf3f8d36", "owner": "postgres", "secdef": true, "config": ["search_path=pg_catalog"], "acl": "postgres=X/postgres,service_role=X/postgres"}'::jsonb then raise exception 'Unknown function preimage: %','public.rls_auto_enable()' using errcode='55000'; end if;
end $guard$;
do $platform$ begin
if (select coalesce(jsonb_agg(jsonb_build_object('name',evtname,'owner',pg_get_userbyid(evtowner),'event',evtevent,'tags',evttags,'enabled',evtenabled,'function',evtfoid::regprocedure::text) order by evtname),'[]'::jsonb) from pg_event_trigger) is distinct from '[{"enabled": "O", "event": "ddl_command_end", "function": "rls_auto_enable()", "name": "ensure_rls", "owner": "postgres", "tags": ["CREATE TABLE", "CREATE TABLE AS", "SELECT INTO"]}, {"enabled": "O", "event": "sql_drop", "function": "set_graphql_placeholder()", "name": "issue_graphql_placeholder", "owner": "supabase_admin", "tags": ["DROP EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "grant_pg_cron_access()", "name": "issue_pg_cron_access", "owner": "supabase_admin", "tags": ["CREATE EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "grant_pg_graphql_access()", "name": "issue_pg_graphql_access", "owner": "supabase_admin", "tags": ["CREATE EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "grant_pg_net_access()", "name": "issue_pg_net_access", "owner": "supabase_admin", "tags": ["CREATE EXTENSION"]}, {"enabled": "O", "event": "ddl_command_end", "function": "pgrst_ddl_watch()", "name": "pgrst_ddl_watch", "owner": "supabase_admin", "tags": null}, {"enabled": "O", "event": "sql_drop", "function": "pgrst_drop_watch()", "name": "pgrst_drop_watch", "owner": "supabase_admin", "tags": null}]'::jsonb then raise exception 'Unknown platform event-trigger preimage' using errcode='55000'; end if;
if (select jsonb_build_object('name','ops.bookings_overview','owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass('ops.bookings_overview')) is distinct from '{"acl": "{postgres=arwdDxtm/postgres,service_role=r/postgres}", "name": "ops.bookings_overview", "options": ["security_invoker=true"], "owner": "postgres", "md5": "8aa3513bf4cff2d9254ff90e81966a94"}'::jsonb then raise exception 'Unknown protected ops view preimage: %','ops.bookings_overview' using errcode='55000'; end if;
if (select jsonb_build_object('name','ops.recent_holds','owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass('ops.recent_holds')) is distinct from '{"acl": "{postgres=arwdDxtm/postgres,service_role=r/postgres}", "name": "ops.recent_holds", "options": ["security_invoker=true"], "owner": "postgres", "md5": "1794aca37d067940bd104fcac8de45c8"}'::jsonb then raise exception 'Unknown protected ops view preimage: %','ops.recent_holds' using errcode='55000'; end if;
if (select jsonb_build_object('name','ops.payments_overview','owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'md5',md5(pg_get_viewdef(c.oid,true))) from pg_class c where c.oid=to_regclass('ops.payments_overview')) is distinct from '{"acl": "{postgres=arwdDxtm/postgres,service_role=r/postgres}", "name": "ops.payments_overview", "options": ["security_invoker=true"], "owner": "postgres", "md5": "d1ccab5d81b2311bbfe4c29a615080b1"}'::jsonb then raise exception 'Unknown protected ops view preimage: %','ops.payments_overview' using errcode='55000'; end if;
end $platform$;
do $version$ begin if current_user<>'postgres' then raise exception 'Apply role must match captured object owner postgres' using errcode='55000'; end if; if to_regclass('supabase_migrations.schema_migrations') is not null then if exists(select 1 from supabase_migrations.schema_migrations where version='20260715060000') then raise exception 'Migration version already recorded: %','20260715060000' using errcode='55000'; end if; end if; end $version$;
do $release_retirement$ begin lock table tourney.mirror_contracts in share row exclusive mode; if exists(select 1 from tourney.mirror_contracts where enabled) then raise exception 'Alignment requires retired zero-enabled mirror contracts' using errcode='55000'; end if; end $release_retirement$;
set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
begin
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  select schema_version into v_schema_version
  from tourney.schema_metadata
  where schema_name = 'tourney'
  for update;
  if v_meta.id is null then
    raise exception 'Supabase Tourney trigger repair metadata is unavailable'
      using errcode = '55000';
  end if;
  if v_meta.hardened_active and exists(select 1 from tourney.mirror_contracts where enabled) and (
    v_meta.primary_backend <> 'supabase'
    or v_meta.generation <> 1
    or not v_meta.writes_paused
    or v_meta.fallback_read_only
    or coalesce(v_schema_version, 0) < 4
  ) then
    raise exception 'Supabase Tourney trigger repair safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function tourney.capture_mirror_event_v4()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_command_id text := nullif(current_setting('roo.tourney_command_id', true), '');
  v_meta tourney.cutover_metadata%rowtype;
  v_logical_table text;
  v_key jsonb;
  v_data jsonb := case when tg_op = 'DELETE' then null else v_row end;
  v_hash text;
begin
  if current_setting('roo.tourney_mirror_apply', true) = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for share;
  if v_meta.id is null or not v_meta.hardened_active
     or v_meta.primary_backend <> 'supabase' or v_meta.generation < 1 then
    raise exception 'Tourney mirror source authority is invalid'
      using errcode = '55000';
  end if;
  if v_command_id is null or pg_catalog.length(v_command_id) not between 3 and 512
     or v_command_id ~ '[[:cntrl:]]' then
    raise exception 'Tourney mirror command context is required'
      using errcode = '22023';
  end if;
  select logical_table into v_logical_table
  from tourney.mirror_contracts
  where supabase_relation = tg_table_schema || '.' || tg_table_name and enabled;
  if v_logical_table is null then
    raise exception 'Tourney mirror relation is not registered' using errcode = '22023';
  end if;
  v_key := tourney.mirror_record_key(v_logical_table, v_row);
  v_hash := case when v_data is null then null else
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_data::text, 'UTF8'), 'sha256'),
      'hex'
    )
  end;
  insert into tourney.mirror_outbox(
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data, record_hash, status
  ) values(
    v_command_id, 'supabase', v_meta.generation, v_logical_table,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_key, v_data, v_hash, 'pending'
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;



do $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
  v_contract record;
  v_status jsonb;
begin
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  select schema_version into v_schema_version
  from tourney.schema_metadata
  where schema_name = 'tourney'
  for update;
  if v_meta.id is null then
    raise exception 'Supabase Tourney trigger repair metadata is unavailable'
      using errcode = '55000';
  end if;
  if v_meta.hardened_active and exists(select 1 from tourney.mirror_contracts where enabled) then
    if v_meta.primary_backend <> 'supabase'
       or v_meta.generation <> 1
       or not v_meta.writes_paused
       or v_meta.fallback_read_only
       or coalesce(v_schema_version, 0) < 4 then
      raise exception 'Supabase Tourney trigger repair safety preconditions are not satisfied'
        using errcode = '55000';
    end if;
    for v_contract in
      select logical_table, supabase_relation
      from tourney.mirror_contracts
      where enabled
      order by logical_table
    loop
      execute pg_catalog.format(
        'drop trigger if exists capture_tourney_mirror_event on %s',
        v_contract.supabase_relation::pg_catalog.regclass
      );
      execute pg_catalog.format(
        'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function tourney.capture_mirror_event_v4()',
        v_contract.supabase_relation::pg_catalog.regclass
      );
    end loop;
    v_status := tourney.mirror_trigger_binding_status_v4();
    if not coalesce((v_status->>'ready')::boolean, false) then
      raise exception 'Supabase Tourney mirror trigger repair verification failed'
        using errcode = '55000';
    end if;
    update tourney.cutover_metadata set
      clean_since = null,
      natural_mutation_verified_at = null,
      first_zero_drift_at = null,
      second_zero_drift_at = null,
      clock_last_reset_reason = 'mirror_trigger_binding_repaired',
      updated_at = pg_catalog.now(),
      updated_by = 'mirror-trigger-binding-repair-v4'
    where id = 'tourney';
    insert into tourney.cutover_gate_events(
      event_kind, generation, actor, evidence
    ) values(
      'clock_reset', v_meta.generation, 'mirror-trigger-binding-repair-v4',
      pg_catalog.jsonb_build_object(
        'reason', 'mirror_trigger_binding_repaired',
        'contract_version', v_status->>'contract_version',
        'correctly_bound', (v_status->>'correctly_bound')::integer
      )
    );
  end if;
end;
$$;



create or replace function public.roo_tourney_readiness()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_binding jsonb;
  v_blockers jsonb;
  v_ready boolean;
  v_shadow_reads jsonb;
begin
  v_result := public.roo_tourney_readiness_before_trigger_binding_v4();
  v_binding := tourney.mirror_trigger_binding_status_v4();
  v_ready := coalesce((v_binding->>'ready')::boolean, false);
  v_blockers := coalesce(v_result->'clock_blockers', '[]'::jsonb);
  if not v_ready and not exists(
    select 1 from pg_catalog.jsonb_array_elements_text(v_blockers) blocker
    where blocker = 'mirror_trigger_binding_drift'
  ) then
    v_blockers := v_blockers || pg_catalog.jsonb_build_array('mirror_trigger_binding_drift');
  end if;
  with ranked as (
    select observation.*,
      pg_catalog.row_number() over(
        partition by observation.route
        order by observation.observed_at desc, observation.id desc
      ) sample_rank
    from tourney.shadow_observations observation
  ), summary as (
    select route,
      pg_catalog.count(*)::integer samples,
      pg_catalog.count(*) filter(where not(
        shape_match and value_match and ordering_match and error_match
        and coalesce(primary_status between 200 and 299, false)
        and coalesce(shadow_status between 200 and 299, false)
      ))::integer mismatches,
      pg_catalog.percentile_cont(0.95) within group(
        order by primary_latency_ms
      )::integer primary_p95_ms,
      pg_catalog.percentile_cont(0.95) within group(
        order by shadow_latency_ms
      )::integer shadow_p95_ms,
      pg_catalog.max(observed_at) last_observed_at
    from ranked
    where sample_rank <= 30
    group by route
  )
  select coalesce(
    pg_catalog.jsonb_object_agg(route, pg_catalog.to_jsonb(summary)-'route'),
    '{}'::jsonb
  ) into v_shadow_reads
  from summary;
  return v_result || pg_catalog.jsonb_build_object(
    'mirror_trigger_bindings', v_binding,
    'clock_blockers', v_blockers,
    'shadow_reads_since_natural_mutation',
      coalesce(v_result->'shadow_reads', '{}'::jsonb),
    'shadow_reads', v_shadow_reads,
    'legacy_read_only_eligible',
      coalesce((v_result->>'legacy_read_only_eligible')::boolean, false)
      and v_ready
  );
end;
$$;

create or replace function tourney.assert_tourney_schema_v4_activation_ready()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
  v_binding jsonb;
begin
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney';
  select schema_version into v_schema_version
  from tourney.schema_metadata
  where schema_name = 'tourney';
  if v_meta.id is null
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or v_meta.fallback_read_only
     or not v_meta.hardened_active
     or coalesce(v_schema_version, 0) < 4 then
    raise exception 'Supabase Tourney schema-v4 activation validation requires hardened paused controls'
      using errcode = '55000';
  end if;
  v_binding := tourney.mirror_trigger_binding_status_v4();
  if not coalesce((v_binding->>'ready')::boolean, false) then
    raise exception 'Supabase Tourney activation mirror trigger verification failed'
      using errcode = '55000';
  end if;
  return v_binding;
end;
$$;

do $$
declare
  v_current pg_catalog.oid;
  v_backup pg_catalog.oid;
  v_source text;
begin
  v_current := pg_catalog.to_regprocedure(
    'public.roo_activate_tourney_schema_v4(text)'
  );
  v_backup := pg_catalog.to_regprocedure(
    'public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)'
  );
  if v_current is not null and v_backup is null then
    select function.prosrc into v_source
    from pg_catalog.pg_proc function
    where function.oid = v_current;
    if pg_catalog.strpos(
      coalesce(v_source, ''),
      'trigger-binding-live-schema-compat-v1'
    ) = 0 then
      alter function public.roo_activate_tourney_schema_v4(text)
        rename to roo_activate_tourney_schema_v4_before_trigger_binding_v4;
    end if;
  end if;
end;
$$;

create or replace function public.roo_activate_tourney_schema_v4(p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_binding jsonb;
begin
  if nullif(pg_catalog.btrim(p_actor), '') is null
     or pg_catalog.length(p_actor) > 120
     or p_actor ~ '[[:cntrl:]]' then
    raise exception 'Tourney activation actor is invalid'
      using errcode = '22023';
  end if;
  if pg_catalog.to_regprocedure(
    'public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)'
  ) is not null then
    execute 'select public.roo_activate_tourney_schema_v4_before_trigger_binding_v4($1)'
      into v_result using p_actor;
  else
    v_result := pg_catalog.jsonb_build_object(
      'activated', true,
      'already_active', true,
      'validation_only', true
    );
  end if;
  v_binding := tourney.assert_tourney_schema_v4_activation_ready();
  return coalesce(v_result, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'mirror_trigger_bindings_verified', true,
    'mirror_trigger_contract_version', v_binding->>'contract_version',
    'compatibility_mode', 'trigger-binding-live-schema-compat-v1'
  );
end;
$$;

revoke all on function tourney.capture_mirror_event_v4()
  from public, anon, authenticated, service_role;
revoke all on function tourney.mirror_trigger_binding_status_v4()
  from public, anon, authenticated, service_role;
revoke all on function tourney.assert_tourney_schema_v4_activation_ready()
  from public, anon, authenticated, service_role;
revoke all on function public.roo_tourney_readiness_before_trigger_binding_v4()
  from public, anon, authenticated, service_role;
do $$
begin
  if pg_catalog.to_regprocedure(
    'public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)'
  ) is not null then
    revoke all on function public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)
      from public, anon, authenticated, service_role;
  end if;
end;
$$;
revoke all on function public.roo_tourney_readiness()
  from public, anon, authenticated;
revoke all on function public.roo_activate_tourney_schema_v4(text)
  from public, anon, authenticated;
grant execute on function public.roo_tourney_readiness() to service_role;
grant execute on function public.roo_activate_tourney_schema_v4(text)
  to service_role;

do $retired$ begin if not exists(select 1 from tourney.mirror_contracts where enabled) then drop trigger if exists capture_tourney_mirror_event on accounts.discord_role_assignments; end if; end $retired$;

CREATE OR REPLACE FUNCTION public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_contract record;
begin
  if v_actor = '' or length(v_actor) > 120 then
    raise exception 'Tourney activation actor is invalid' using errcode = '22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for update;
  select schema_version into v_schema_version from tourney.schema_metadata
  where schema_name = 'tourney' for update;
  if v_meta.hardened_active and coalesce(v_schema_version, 0) >= 4 then
    return jsonb_build_object(
      'activated', true,
      'already_active', true,
      'generation', v_meta.generation,
      'schema_version', v_schema_version
    );
  end if;
  if v_meta.id is null
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or v_meta.fallback_read_only
     or to_regclass('tourney.mirror_contracts') is null
     or to_regclass('tourney.account_snapshots') is null
     or to_regclass('tourney.external_operations') is null
     or to_regclass('accounts.discord_role_assignments') is null
     or to_regclass('tourney.shadow_latency_baselines') is null
     or (select count(*) from tourney.shadow_latency_baselines) <> 5 then
    raise exception 'Supabase Tourney activation safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
  if exists (
    with expected(logical_table, supabase_relation, legacy_relation, key_columns) as (
      values
        ('tourney_players','tourney.tourney_players','tourney_players',array['id']::text[]),
        ('tourney_player_tokens','tourney.tourney_player_tokens','tourney_player_tokens',array['id']::text[]),
        ('tourney_registration_config','tourney.tourney_registration_config','tourney_registration_config',array['id']::text[]),
        ('tourney_bracket_teams','tourney.tourney_bracket_teams','tourney_bracket_teams',array['id']::text[]),
        ('tourney_bracket_team_members','tourney.tourney_bracket_team_members','tourney_bracket_team_members',array['id']::text[]),
        ('tourney_bracket_meta','tourney.tourney_bracket_meta','tourney_bracket_meta',array['id']::text[]),
        ('tourney_bracket_entities','tourney.tourney_bracket_entities','tourney_bracket_entities',array['entity_type','entity_id']::text[]),
        ('tourney_bracket_counters','tourney.tourney_bracket_counters','tourney_bracket_counters',array['entity_type']::text[]),
        ('tourney_bracket_audit','tourney.tourney_bracket_audit','tourney_bracket_audit',array['id']::text[]),
        ('tourney_bracket_lock','tourney.tourney_bracket_lock','tourney_bracket_lock',array['id']::text[]),
        ('tourney_appeals','tourney.tourney_appeals','tourney_appeals',array['id']::text[]),
        ('tourney_payouts','tourney.tourney_payouts','tourney_payouts',array['id']::text[]),
        ('email_dispatches','tourney.email_dispatches','tourney_email_dispatches',array['id']::text[]),
        ('command_receipts','tourney.command_receipts','tourney_command_receipts',array['command_id']::text[]),
        ('account_snapshots','tourney.account_snapshots','tourney_account_snapshots',array['snapshot_id']::text[]),
        ('external_operations','tourney.external_operations','tourney_external_operations',array['operation_key']::text[]),
        ('discord_role_assignments','accounts.discord_role_assignments','tourney_discord_role_assignments',array['principal_id']::text[])
    )
    select 1
    from expected
    full join tourney.mirror_contracts contract using(logical_table)
    where expected.logical_table is null or contract.logical_table is null
       or not contract.enabled
       or contract.supabase_relation is distinct from expected.supabase_relation
       or contract.legacy_relation is distinct from expected.legacy_relation
       or contract.key_columns is distinct from expected.key_columns
       or contract.allowed_columns is distinct from (
         select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
         from pg_catalog.pg_attribute attribute
         where attribute.attrelid = expected.supabase_relation::regclass
           and attribute.attnum > 0 and not attribute.attisdropped
       )
  ) then
    raise exception 'Supabase Tourney mirror registry is incomplete or stale'
      using errcode = '55000';
  end if;

  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts where enabled order by logical_table
  loop
    execute format(
      'drop trigger if exists capture_tourney_mirror_event on %s',
      v_contract.supabase_relation::regclass
    );
    execute format(
      'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function tourney.capture_mirror_event_v4()',
      v_contract.supabase_relation::regclass
    );
  end loop;

  update tourney.cutover_metadata set
    hardened_active = true,
    clean_since = null,
    natural_mutation_verified_at = null,
    first_zero_drift_at = null,
    second_zero_drift_at = null,
    clock_last_reset_reason = 'fresh_hardening_window',
    updated_at = now(),
    updated_by = v_actor
  where id = 'tourney';
  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts where enabled order by logical_table
  loop
    execute pg_catalog.format(
      'insert into tourney.mirror_outbox(
         command_id,source_backend,generation,table_name,operation,
         record_key,record_data,record_hash,status
       )
       select $1 || '':'' || $2,''supabase'',1,$2,''upsert'',
         tourney.mirror_record_key($2,to_jsonb(source_row)),
         to_jsonb(source_row),
         pg_catalog.encode(extensions.digest(
           pg_catalog.convert_to(to_jsonb(source_row)::text,''UTF8''),''sha256''
         ),''hex''),
         ''pending''
       from %s source_row',
      v_contract.supabase_relation::regclass
    ) using 'schema-v4-bootstrap:' || v_actor, v_contract.logical_table;
  end loop;
  insert into tourney.cutover_gate_events (event_kind, generation, actor, evidence)
  values ('hardened_activated', v_meta.generation, v_actor,
    jsonb_build_object('schema_version', 4));
  insert into tourney.schema_metadata (schema_name, schema_version, updated_at)
  values ('tourney', 4, now())
  on conflict (schema_name) do update
  set schema_version = greatest(tourney.schema_metadata.schema_version, excluded.schema_version),
      updated_at = now();
  return jsonb_build_object(
    'activated', true,
    'already_active', false,
    'generation', v_meta.generation,
    'schema_version', 4
  );
end;
$function$
;
revoke all on function public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.roo_backfill_tourney_email_history_v4(p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_count integer := 0;
begin
  if btrim(coalesce(p_actor, '')) = '' or length(p_actor) > 120 then
    raise exception 'Tourney email history actor is invalid' using errcode = '22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for update;
  if v_meta.id is null
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or not v_meta.hardened_active then
    raise exception 'Tourney email history backfill controls are not ready'
      using errcode = '55000';
  end if;
insert into tourney.email_dispatches(
  id,idempotency_key,command_id,dispatch_kind,recipient,recipient_hash,
  payload,status,provider_message_id,sent_at,created_at,updated_at
)
select tourney.history_uuid(candidate.key),candidate.key,null::text,
  candidate.kind,candidate.recipient,
  encode(extensions.digest(convert_to(candidate.recipient,'UTF8'),'sha256'),'hex'),
  candidate.payload,candidate.status,candidate.provider_message_id,candidate.sent_at,
  candidate.occurred_at,candidate.occurred_at
from (
  select
    'history:registration:'||token.player_id||':'||lower(token.recipient_email) key,
    'history:registration:'||token.player_id command_id,'registration' kind,
    lower(token.recipient_email) recipient,
    jsonb_build_object('historical',true,'entityId',token.player_id,'audience','admin') payload,
    'historical_unknown' status,null::text provider_message_id,null::timestamptz sent_at,
    min(token.created_at) occurred_at
  from tourney.tourney_player_tokens token
  where token.recipient_email is not null and token.purpose in ('approve','deny')
  group by token.player_id, lower(token.recipient_email)
  union all
  select 'history:approval:'||player.id||':'||lower(player.email),
    'history:approval:'||player.id,'approval',lower(player.email),
    jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),
    'historical_unknown',null,null,coalesce(player.approved_at,player.updated_at)
  from tourney.tourney_players player where player.status='approved'
  union all
  select 'history:reset:'||token.id||':'||lower(player.email),
    'history:reset:'||token.id,'reset',lower(player.email),
    jsonb_build_object('historical',true,'entityId',token.id,'audience','player'),
    'historical_unknown',null,null,token.created_at
  from tourney.tourney_player_tokens token
  join tourney.tourney_players player on player.id=token.player_id
  where token.purpose='reset'
  union all
  select 'history:discord_invite:'||player.id||':'||lower(player.email),
    'history:discord_invite:'||player.id,'discord_invite',lower(player.email),
    jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),
    'sent',player.discord_invite_email_id,player.discord_invite_sent_at,player.discord_invite_sent_at
  from tourney.tourney_players player where player.discord_invite_sent_at is not null
  union all
  select 'history:appeal:'||appeal.id||':'||lower(player.email),
    'history:appeal:'||appeal.id,'appeal',lower(player.email),
    jsonb_build_object('historical',true,'entityId',appeal.id,'audience','submitter'),
    'historical_unknown',null,null,appeal.created_at
  from tourney.tourney_appeals appeal
  join tourney.tourney_players player on player.id=appeal.submitter_player_id
  union all
  select 'history:payout:'||payout.id||':'||payout.status||':'||lower(payout.payout_email),
    'history:payout:'||payout.id||':'||payout.status,'payout',lower(payout.payout_email),
    jsonb_build_object('historical',true,'entityId',payout.id,'audience',payout.status),
    'historical_unknown',null,null,payout.updated_at
  from tourney.tourney_payouts payout
  where payout.status in ('ready','paid','void') and payout.payout_email is not null
) candidate
where candidate.recipient <> ''
  and not exists(
    select 1 from tourney.email_dispatches existing
    where existing.dispatch_kind=candidate.kind
      and existing.recipient_hash=encode(extensions.digest(convert_to(candidate.recipient,'UTF8'),'sha256'),'hex')
      and coalesce(
        existing.payload->>'entityId',
        existing.payload#>>'{player,id}',
        existing.payload#>>'{appeal,id}',
        existing.payload#>>'{payout,id}'
      )=candidate.payload->>'entityId'
      and coalesce(existing.payload->>'audience','')=coalesce(candidate.payload->>'audience','')
  )
on conflict(idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('inserted', v_count, 'actor', btrim(p_actor));
end;
$function$
;
revoke all on function public.roo_backfill_tourney_email_history_v4(text) from public,anon,authenticated,service_role;
grant execute on function public.roo_backfill_tourney_email_history_v4(text) to service_role;

CREATE OR REPLACE FUNCTION tourney.capture_mirror_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_enabled boolean := coalesce(nullif(current_setting('roo.tourney_mirror_enabled', true), ''), '0') in ('1', 'true', 'on');
  v_origin text := coalesce(nullif(current_setting('roo.tourney_backend', true), ''), 'supabase');
  v_generation integer := coalesce(nullif(current_setting('roo.tourney_generation', true), ''), '0')::integer;
  v_command_id text := nullif(current_setting('roo.tourney_command_id', true), '');
begin
  if not v_enabled or current_setting('roo.tourney_mirror_apply', true) = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  insert into tourney.mirror_outbox (
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data
  ) values (
    v_command_id, v_origin, v_generation, tg_table_name,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    tourney.mirror_record_key(tg_table_name, v_row),
    case when tg_op = 'DELETE' then null else v_row end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$
;
revoke all on function tourney.capture_mirror_event() from public,anon,authenticated,service_role;
grant execute on function tourney.capture_mirror_event() to service_role;

commit;

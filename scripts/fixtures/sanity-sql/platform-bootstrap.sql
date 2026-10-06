
create role postgres superuser login;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant service_role to serviroo;
create schema extensions;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
create schema auth;
create schema storage;
create schema accounts;
create schema commerce;
create schema licensing;
create schema cms;
create schema migration;
create schema ops;
create table auth.users (
 id uuid primary key, email text, encrypted_password text default '',
 email_confirmed_at timestamptz, banned_until timestamptz,
 raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
 created_at timestamptz default now(), updated_at timestamptz default now()
);
create table auth.identities (
 id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id),
 provider text, provider_id text, email text, identity_data jsonb default '{}'::jsonb,
 created_at timestamptz default now(), updated_at timestamptz default now(), last_sign_in_at timestamptz
);
create table auth.sessions (id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id));
create table auth.refresh_tokens (id bigint generated always as identity primary key,user_id text,token text);
create function auth.uid() returns uuid language sql stable as $$
 select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,metadata jsonb default '{}'::jsonb);
grant usage on schema public,accounts,commerce,licensing,cms,migration,auth,ops to service_role;

create schema tourney;
create function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin return; end; $$;

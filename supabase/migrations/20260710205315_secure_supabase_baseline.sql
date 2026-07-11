
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
grant execute on function public.rls_auto_enable() to service_role;

create schema if not exists accounts;
create schema if not exists commerce;
create schema if not exists licensing;
create schema if not exists cms;
create schema if not exists migration;

revoke all on schema accounts, commerce, licensing, cms, migration from public, anon, authenticated;
grant usage on schema accounts, commerce, licensing, cms, migration to service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

alter default privileges for role postgres in schema accounts
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema accounts
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema accounts
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema accounts
  grant all on tables to service_role;
alter default privileges for role postgres in schema accounts
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema accounts
  grant execute on functions to service_role;

alter default privileges for role postgres in schema commerce
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema commerce
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema commerce
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema commerce
  grant all on tables to service_role;
alter default privileges for role postgres in schema commerce
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema commerce
  grant execute on functions to service_role;

alter default privileges for role postgres in schema licensing
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema licensing
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema licensing
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema licensing
  grant all on tables to service_role;
alter default privileges for role postgres in schema licensing
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema licensing
  grant execute on functions to service_role;

alter default privileges for role postgres in schema cms
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema cms
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema cms
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema cms
  grant all on tables to service_role;
alter default privileges for role postgres in schema cms
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema cms
  grant execute on functions to service_role;

alter default privileges for role postgres in schema migration
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema migration
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema migration
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema migration
  grant all on tables to service_role;
alter default privileges for role postgres in schema migration
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema migration
  grant execute on functions to service_role;

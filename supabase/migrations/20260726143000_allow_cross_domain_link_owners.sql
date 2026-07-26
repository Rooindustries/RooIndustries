set lock_timeout = '5s';
set statement_timeout = '120s';

-- 20260726120000 writes projected cross-domain Discord links with
-- backend_owner = '<domain>_link' so that the reconciler in 20260726051500 never
-- garbage-collects them: that reconciler deletes only rows it owns
-- (backend_owner = 'supabase') which lack an auth.identities backing, and a
-- cross-domain link has no such backing by definition.
--
-- accounts.identity_links.backend_owner, however, still carried the original
-- two-value check from the Sanity-to-Supabase import
-- (ARRAY['sanity', 'supabase']), so every cross-domain link attempt aborted with
-- accounts_identity_links_backend_owner_check. The capability was live but
-- unusable -- exactly the referral-plus-tourney case it was written for.
--
-- Admit the two link owners. Using 'supabase' instead would satisfy the
-- constraint and then let the reconciler delete the row on its next run, so the
-- distinct owner values are load-bearing rather than cosmetic.

alter table accounts.identity_links
  drop constraint if exists accounts_identity_links_backend_owner_check;

alter table accounts.identity_links
  add constraint accounts_identity_links_backend_owner_check
  check (backend_owner in ('sanity', 'supabase', 'tourney_link', 'referral_link'));

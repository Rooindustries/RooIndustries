# Commerce failover to Sanity

Supabase is the default data, CMS, authentication, and commerce backend. An
unset `DATA_PRIMARY_BACKEND` or `COMMERCE_PRIMARY_BACKEND` therefore selects
Supabase. Sanity becomes authoritative only through an explicit failover
deployment.

`COMMERCE_FAILOVER_GENERATION` never follows the backend default. It is a
deployment-pinned fence and must exactly match `roo_commerce_control()`. A
stale generation is rejected by Supabase rather than accepted as a write.

A Sanity-primary deployment also requires a signed failover lease. The lease
contains the authoritative backend, generation, pause state, deployment
identity, issue time, and expiry. Its maximum lifetime is 15 minutes. The
application validates the signature locally and compares all control fields to
`roo_commerce_control()` whenever Supabase is reachable. A valid lease is the
only control evidence accepted while Supabase is unavailable.

## Failover procedure

1. Pause new commerce starts.
2. Drain/assess Sanity mirror backlog and parity.
3. Call `roo_advance_commerce_generation(old_generation, 'sanity', true,
   reason)`, which increments the generation.
4. Generate a short-lived lease with `issueCommerceFailoverLease()` from
   `src/server/supabase/commerceFailoverLease.js`. Sign the exact Sanity
   backend, new generation, current pause state, and deployment identity with
   `COMMERCE_FAILOVER_LEASE_SECRET`.
5. Deploy complete Sanity credentials plus:

   - `COMMERCE_PRIMARY_BACKEND=sanity`
   - `COMMERCE_FAILOVER_GENERATION=<new generation>`
   - matching `COMMERCE_STARTS_PAUSED`
   - `COMMERCE_FAILOVER_LEASE=<signed lease>`
   - `COMMERCE_FAILOVER_LEASE_SECRET=<signing secret>`
   - `COMMERCE_DEPLOYMENT_ID=<lease deployment identity>`

6. Set `DATA_PRIMARY_BACKEND=sanity` only for a full data/auth/content failover;
   leave it Supabase for commerce-only failover.
7. During a hard Supabase outage, set `SUPABASE_SHADOW_WRITES=0` so Sanity
   does not wait on doomed shadow attempts. The wrapper catches those failures,
   but still awaits the attempt before returning.

Restore `SUPABASE_SHADOW_WRITES` before relying on Supabase as the warm
secondary again.

Mirror health may gate promotion to Sanity. Mirror lag or an unavailable
Sanity target must never gate an ordinary Supabase-primary operation.

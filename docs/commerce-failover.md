# Commerce failover to Sanity

Supabase is the default data, CMS, authentication, and commerce backend. An
unset `DATA_PRIMARY_BACKEND` or `COMMERCE_PRIMARY_BACKEND` therefore selects
Supabase. Sanity becomes authoritative only through an explicit failover
deployment.

`COMMERCE_FAILOVER_GENERATION` never follows the backend default. It is a
deployment-pinned fence and must exactly match `roo_commerce_control()`. A
stale generation is rejected by Supabase rather than accepted as a write.

## Failover procedure

1. Pause new commerce starts.
2. Drain/assess Sanity mirror backlog and parity.
3. Call `roo_advance_commerce_generation(old_generation, 'sanity', true,
   reason)`, which increments the generation.
4. Deploy complete Sanity credentials plus:

   - `COMMERCE_PRIMARY_BACKEND=sanity`
   - `COMMERCE_FAILOVER_GENERATION=<new generation>`
   - matching `COMMERCE_STARTS_PAUSED`

5. Set `DATA_PRIMARY_BACKEND=sanity` only for a full data/auth/content failover;
   leave it Supabase for commerce-only failover.
6. During a hard Supabase outage, set `SUPABASE_SHADOW_WRITES=0` so Sanity
   does not wait on doomed shadow attempts. The wrapper catches those failures,
   but still awaits the attempt before returning.

Restore `SUPABASE_SHADOW_WRITES` before relying on Supabase as the warm
secondary again.

Mirror health may gate promotion to Sanity. Mirror lag or an unavailable
Sanity target must never gate an ordinary Supabase-primary operation.

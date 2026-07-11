# Supabase shadow migration

The production safety default is Sanity-primary with Supabase shadow writes.
Do not enable a Supabase commerce canary or primary cutover without the reverse
Sanity mirror.

## Data checks

```bash
npm run migrate:supabase:dry-run
npm run migrate:supabase:apply -- --reuse-verified-assets
npm run check:supabase:parity
```

The apply command is idempotent and refuses to run after
`DATA_PRIMARY_BACKEND=supabase`. A successful comparison resolves older drift
findings only after the current run reports zero document, asset, account, and
count drift.

## Runtime controls

- `DATA_PRIMARY_BACKEND`: `sanity` or `supabase`.
- `SUPABASE_SHADOW_WRITES`: mirrors successful Sanity writes into Supabase.
- `SUPABASE_CONTENT_CANARY_PERCENT`: deterministic content and asset canary.
- `SUPABASE_COMMERCE_CANARY_PERCENT`: checkout canary; requires shadow writes
  and the reverse mirror.
- `SUPABASE_AUTH_CANARY_ACCOUNTS`: comma-separated account identifiers.
- `SUPABASE_CUTOVER_ENABLED`: required before production can use Supabase as
  primary.
- `SANITY_REVERSE_MIRROR_WRITES`: preserves Sanity as the rollback copy.
- `TOURNEY_DATABASE_MODE`: `legacy` or `supabase`.
- `SUPABASE_LICENSING_ENABLED`: exposes the authenticated app entitlement API.
- `SUPABASE_MIGRATION_ENDPOINT_ENABLED`: preview-only Tourney import endpoint;
  production builds reject this flag.

Payment providers remain disabled on previews unless the existing explicit
preview-payment policy enables sandbox credentials. The migration scripts do
not create payment-provider orders, send emails, reset passwords, or modify the
India site.

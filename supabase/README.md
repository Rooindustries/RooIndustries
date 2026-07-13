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
- `TOURNEY_MIRROR_ENABLED`: writes ordered mutation events to the opposite
  Tourney backend; required while Supabase is primary and legacy is retained.
- `TOURNEY_WRITES_PAUSED`: pauses registrations and domain mutations with a
  retryable `503` while login, logout, sessions, and public reads remain live.
- `TOURNEY_FAILOVER_GENERATION`: non-negative manual cutover generation.
- `TOURNEY_HARDENING_V4_ENABLED`: requires schema v4 before the hardened queue,
  saga, activation, and readiness contracts are used.
- `SUPABASE_LICENSING_ENABLED`: exposes the authenticated app entitlement API.
- `SUPABASE_MIGRATION_ENDPOINT_ENABLED`: preview-only Tourney import endpoint;
  production builds reject this flag.

Payment providers remain disabled on previews unless the existing explicit
preview-payment policy enables sandbox credentials. The migration scripts do
not create payment-provider orders, send emails, reset passwords, or modify the
India site.

## Tourney schema-v4 activation

Apply the additive expand migrations first. Activation is permitted only while
Supabase is primary at generation 1, mirroring is enabled, both database control
rows and the deployment have writes paused, and schema v4 is enabled.

The production database URL is a non-exportable Vercel Sensitive variable. Use
the deployed, cron-secret-protected activation endpoint so the credential never
leaves the runtime. Inventory contacts Discord read-only and returns aggregate
counts plus a non-PII hash. Apply recomputes and requires that exact hash; it
aborts on changed or unknown Discord state, missing principals, duplicate
Discord users, identity conflicts, or import quarantine rows.

```bash
curl --fail-with-body --silent \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"action":"inventory"}' \
  https://www.rooindustries.com/api/admin/tourney-activation

curl --fail-with-body --silent \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  --data "{\"action\":\"apply\",\"inventoryHash\":\"$INVENTORY_HASH\"}" \
  https://www.rooindustries.com/api/admin/tourney-activation
```

Apply records account snapshots, principal corrections, Discord desired state,
command receipts, mirror events, and durable external operations. It does not
directly change Discord roles; the reconciliation worker verifies and applies
only managed participant/host role differences after commit.

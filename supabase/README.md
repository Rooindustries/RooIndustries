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
- `TOURNEY_V4_ACTIVATION_ENABLED`: marks an activation-staged release. Strict
  builds then require the exact paused Supabase-primary generation-one tuple and
  the Discord role-inventory credentials.
- `SUPABASE_LICENSING_ENABLED`: exposes the authenticated app entitlement API.
- `SUPABASE_MIGRATION_ENDPOINT_ENABLED`: preview-only Tourney import endpoint;
  production builds reject this flag.
- `SUPABASE_MIGRATION_TARGET_ENVIRONMENT`: `preview` uses only the dedicated
  `TOURNEY_PREVIEW_DATABASE_URL`, `SUPABASE_PREVIEW_DATABASE_URL`,
  `SUPABASE_PREVIEW_URL`, and `SUPABASE_PREVIEW_SECRET_KEY` values;
  `production` uses the generic runtime targets and requires
  `SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1`.
- `SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT` and
  `SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT`: SHA-256 identities for the
  selected credential-free database/project target descriptors.

After loading the intended target environment, print those hashes without
credentials using:

```bash
node -e 'const safety=require("./src/server/supabase/migrationTargetSafety.cjs"); console.log(safety.computeMigrationTargetFingerprints(process.env))'
```

Payment providers remain disabled on previews unless the existing explicit
preview-payment policy enables sandbox credentials. The migration scripts do
not create payment-provider orders, send emails, reset passwords, or modify the
India site.

Every migration request validates both selected target fingerprints and opens
both database connections before its first write. Preview targets that match
either inherited generic target are blocked unless
`SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1` is set. Every mutation against
such an inherited target, or a target classified as `production`, must also
include `productionMutationAcknowledgement` with `confirmed: true`, the exact
action, and both target fingerprints. Read-only health checks do not require the
per-request acknowledgement.

Dual-database cutover control writes use row-version compare-and-set. A definite
failure on the second target compensates the first target. Ambiguous transport
outcomes are verified before compensation and remain recovery-required unless
the committed target state can be observed directly.
`TOURNEY_CUTOVER_SECOND_TARGET_FAILED_COMPENSATED` is safe to retry;
`TOURNEY_CUTOVER_RECOVERY_REQUIRED` means an operator must inspect both rows and
retry the same fingerprinted request after restoring target availability.

## Tourney schema-v4 activation

Apply the additive expand migrations first. Activation is permitted only while
Supabase is primary at generation 1, mirroring is enabled, both database control
rows and the deployment have writes paused, `TOURNEY_V4_ACTIVATION_ENABLED=1`,
and `TOURNEY_HARDENING_V4_ENABLED=0`. The hardening flag is enabled only by the
post-activation deployment.

The timestamped Supabase migrations only install additive schema and guarded
functions; they do not activate hardening. Activate the legacy schema first,
then invoke the audited Supabase activation action. This prevents a normal
migration-chain replay or rolling deploy from silently switching runtime state.

The Supabase production database URL is a non-exportable Vercel Sensitive
variable. Use
the deployed, cron-secret-protected activation endpoint so the credential never
leaves the runtime. Inventory contacts Discord read-only and returns aggregate
counts plus a non-PII hash. Apply recomputes and requires that exact hash; it
aborts on changed or unknown Discord state, missing or inactive Tourney
principals, duplicate Discord users, identity conflicts, import quarantine
rows, active queue blockers, incomplete database controls, or a missing
five-route latency baseline.

Use this exact order. Keep the permission-restricted environment file outside
the worktree and keep writes paused throughout these steps. Every local command
that contacts a hosted target requires `--env /absolute/path/to/restricted.env`.
The file must be mode `0600`. After adding the target credentials and IDs, print
the credential-free pins without contacting any provider:

```bash
node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env \
  --print-target-fingerprints
```

Copy the applicable values back into the same restricted file:

```text
TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT=<legacy PostgreSQL v2 fingerprint>
TOURNEY_CUTOVER_EXPECTED_SUPABASE_API_FINGERPRINT=<Supabase API v2 fingerprint>
TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT=<Sanity project and dataset v2 fingerprint>
TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT=<direct Supabase PostgreSQL v2 fingerprint>
TOURNEY_CUTOVER_EXPECTED_DISCORD_FINGERPRINT=<Discord API, guild, and managed roles v2 fingerprint>
```

The legacy pin includes host, port, database, and user; the Supabase API pin
includes origin and path; the direct-database pin also proves the database
project matches the API project; the Sanity pin includes project and dataset;
and the Discord pin includes the official API endpoint, guild, participant
role, and host role. The snapshot command validates the first three pins before
capture. Direct-database and Discord pins are required only by commands that
contact those targets. Production Supabase database work still uses the
deployed activation endpoint because that credential is not exportable.

1. Apply the Supabase additive expand/forward-repair migrations, then run only
   `node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env --expand-legacy-v4`.
   Do not repair or activate the legacy schema yet, and do not activate
   Supabase.
2. Deploy this release from `main` with hardening and schema-v4 activation
   disabled.
3. While the deployment still has `TOURNEY_WRITES_PAUSED=0`, pause both
   database controls through the production endpoint. Read and fail-closed
   validate the normalized controls and credential-free target fingerprints
   first, then bind the mutation to that exact state and those exact targets.
   Generate a new operation ID for a new operation; reuse the same ID only when
   retrying an ambiguous response:

   ```bash
   CUTOVER_STATE="$(curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data '{"action":"cutover-state"}' \
     https://www.rooindustries.com/api/admin/tourney-activation)"
   printf '%s' "$CUTOVER_STATE" | jq -e '
     .ok == true and
     (.controls.legacy.primaryBackend == "supabase") and
     (.controls.supabase.primaryBackend == "supabase") and
     (.controls.legacy.generation == 1) and
     (.controls.supabase.generation == 1) and
     (.controls.legacy.writesPaused == false) and
     (.controls.supabase.writesPaused == false) and
     (.controls.legacy.lastPauseOperationId == .controls.supabase.lastPauseOperationId) and
     (.controls.legacy.lastResumeOperationId == .controls.supabase.lastResumeOperationId) and
     (.fingerprints.legacy | type == "string" and test("^[0-9a-f]{64}$")) and
     (.fingerprints.supabase | type == "string" and test("^[0-9a-f]{64}$"))
   ' >/dev/null
   LEGACY_TARGET_FINGERPRINT="$(printf '%s' "$CUTOVER_STATE" | jq -er '.fingerprints.legacy')"
   SUPABASE_TARGET_FINGERPRINT="$(printf '%s' "$CUTOVER_STATE" | jq -er '.fingerprints.supabase')"
   PAUSE_OPERATION_ID="pause-$(date -u +%Y%m%dt%H%M%Sz)"
   curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data "{\"action\":\"pause-writes\",\"operationId\":\"$PAUSE_OPERATION_ID\",\"expectedPrimaryBackend\":\"supabase\",\"expectedGeneration\":1,\"expectedWritesPaused\":false,\"legacyTargetFingerprint\":\"$LEGACY_TARGET_FINGERPRINT\",\"supabaseTargetFingerprint\":\"$SUPABASE_TARGET_FINGERPRINT\"}" \
     https://www.rooindustries.com/api/admin/tourney-activation
   PAUSED_STATE="$(curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data '{"action":"cutover-state"}' \
     https://www.rooindustries.com/api/admin/tourney-activation)"
   printf '%s' "$PAUSED_STATE" | jq -e \
     --arg operation "$PAUSE_OPERATION_ID" \
     --arg legacyFingerprint "$LEGACY_TARGET_FINGERPRINT" \
     --arg supabaseFingerprint "$SUPABASE_TARGET_FINGERPRINT" '
       .ok == true and
       (.controls.legacy.primaryBackend == "supabase") and
       (.controls.supabase.primaryBackend == "supabase") and
       (.controls.legacy.generation == 1) and
       (.controls.supabase.generation == 1) and
       (.controls.legacy.writesPaused == true) and
       (.controls.supabase.writesPaused == true) and
       (.controls.legacy.lastPauseOperationId == $operation) and
       (.controls.supabase.lastPauseOperationId == $operation) and
       (.controls.legacy.lastResumeOperationId == .controls.supabase.lastResumeOperationId) and
       (.fingerprints.legacy == $legacyFingerprint) and
       (.fingerprints.supabase == $supabaseFingerprint)
     ' >/dev/null
   ```

   A successful response means only that both database controls are paused.
   It does not change the deployment environment. The readback must show both
   controls paused and `lastPauseOperationId` equal to
   `$PAUSE_OPERATION_ID`. A replay after a later resume returns
   `superseded:true` and never pauses writes again.
4. Deploy the staged runtime tuple above with `TOURNEY_WRITES_PAUSED=1`.
   Confirm both control rows are Supabase-primary, generation 1, paused, and
   writable as a fallback (`fallback_read_only=false`).
5. Capture the full Supabase/Auth, Vercel-managed fallback PostgreSQL, Sanity,
   email, Discord, receipt, and queue snapshot. This command refuses an
   incomplete legacy schema, a missing Sanity account document, incomplete
   hosted payloads, and use of a generic `POSTGRES_URL`. It never falls back to
   the older partial snapshot function:

   ```bash
   node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env \
     --snapshot \
     --output "$HOME/Documents/Codex/Tourney Cutover/unique-pre-cutover.enc"
   node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env \
     --verify-snapshot \
     "$HOME/Documents/Codex/Tourney Cutover/unique-pre-cutover.enc"
   ```

6. After every shadow route has at least 30 real pre-activation samples,
   capture the baseline inside the deployed runtime. Do not run the local
   command for production: `SUPABASE_DATABASE_URL` is intentionally not
   exportable from Vercel. Exactly five route baselines are required by
   activation inventory.

   ```bash
   curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data '{"action":"capture-latency-baseline"}' \
     https://www.rooindustries.com/api/admin/tourney-activation
   ```

7. Run `node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env --activate-legacy-v4`.
   It re-reads the paused controls before mutation.
8. Run `node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env --repair-legacy-v4`
   only after legacy activation succeeds.
9. Call the deployed `activate-schema` action below to activate Supabase. It
   also re-reads the paused controls before mutation.
10. Call `inventory`, preserve its exact hash, then call `apply` with that hash.
   Apply is rejected if the inventory changes while the reconciliation lease is
   acquired.
11. Dry-run fallback bootstrapping and bind apply to that exact read-only
   Vercel-managed PostgreSQL snapshot:

   ```bash
   node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env \
     --inventory-fallback-v4
   node scripts/tourney-cutover.mjs --env /absolute/path/to/restricted.env \
     --bootstrap-fallback-v4 \
     --expected-legacy-hash "$LEGACY_SNAPSHOT_HASH"
   ```

12. Drain and verify all queues and parity while paused. Activation readiness
   must report zero active queue blockers, every Discord authority bucket
   (including inactive Tourney accounts), both database controls ready, and all
   five latency baselines present. Deploy
   `TOURNEY_HARDENING_V4_ENABLED=1` and
   `TOURNEY_V4_ACTIVATION_ENABLED=0` while keeping
   `TOURNEY_WRITES_PAUSED=1`, verify readiness again, and only then resume the
   database controls with an exact expected state:

   ```bash
   CUTOVER_STATE="$(curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data '{"action":"cutover-state"}' \
     https://www.rooindustries.com/api/admin/tourney-activation)"
   printf '%s' "$CUTOVER_STATE" | jq -e '
     .ok == true and
     (.controls.legacy.primaryBackend == "supabase") and
     (.controls.supabase.primaryBackend == "supabase") and
     (.controls.legacy.generation == 1) and
     (.controls.supabase.generation == 1) and
     (.controls.legacy.writesPaused == true) and
     (.controls.supabase.writesPaused == true) and
     (.controls.legacy.lastPauseOperationId == .controls.supabase.lastPauseOperationId) and
     (.controls.legacy.lastResumeOperationId == .controls.supabase.lastResumeOperationId) and
     (.fingerprints.legacy | type == "string" and test("^[0-9a-f]{64}$")) and
     (.fingerprints.supabase | type == "string" and test("^[0-9a-f]{64}$"))
   ' >/dev/null
   LEGACY_TARGET_FINGERPRINT="$(printf '%s' "$CUTOVER_STATE" | jq -er '.fingerprints.legacy')"
   SUPABASE_TARGET_FINGERPRINT="$(printf '%s' "$CUTOVER_STATE" | jq -er '.fingerprints.supabase')"
   RESUME_OPERATION_ID="resume-$(date -u +%Y%m%dt%H%M%Sz)"
   curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data "{\"action\":\"resume-writes\",\"operationId\":\"$RESUME_OPERATION_ID\",\"expectedPrimaryBackend\":\"supabase\",\"expectedGeneration\":1,\"expectedWritesPaused\":true,\"legacyTargetFingerprint\":\"$LEGACY_TARGET_FINGERPRINT\",\"supabaseTargetFingerprint\":\"$SUPABASE_TARGET_FINGERPRINT\"}" \
     https://www.rooindustries.com/api/admin/tourney-activation
   RESUMED_STATE="$(curl --fail-with-body --silent \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "Content-Type: application/json" \
     --data '{"action":"cutover-state"}' \
     https://www.rooindustries.com/api/admin/tourney-activation)"
   printf '%s' "$RESUMED_STATE" | jq -e \
     --arg operation "$RESUME_OPERATION_ID" \
     --arg legacyFingerprint "$LEGACY_TARGET_FINGERPRINT" \
     --arg supabaseFingerprint "$SUPABASE_TARGET_FINGERPRINT" '
       .ok == true and
       (.controls.legacy.primaryBackend == "supabase") and
       (.controls.supabase.primaryBackend == "supabase") and
       (.controls.legacy.generation == 1) and
       (.controls.supabase.generation == 1) and
       (.controls.legacy.writesPaused == false) and
       (.controls.supabase.writesPaused == false) and
       (.controls.legacy.lastPauseOperationId == .controls.supabase.lastPauseOperationId) and
       (.controls.legacy.lastResumeOperationId == $operation) and
       (.controls.supabase.lastResumeOperationId == $operation) and
       (.fingerprints.legacy == $legacyFingerprint) and
       (.fingerprints.supabase == $supabaseFingerprint)
     ' >/dev/null
   ```

   This resumes only the two database controls. Keep the deployment environment
   paused until that response and the control readback show both controls
   unpaused and `lastResumeOperationId` equal to `$RESUME_OPERATION_ID`. Then set
   `TOURNEY_WRITES_PAUSED=0`, deploy that environment change, and verify normal
   writes. Never run activation with both hardening flags enabled.

```bash
curl --fail-with-body --silent \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"action":"activate-schema"}' \
  https://www.rooindustries.com/api/admin/tourney-activation

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

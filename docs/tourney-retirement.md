# Tournament retirement cutover

This cleanup is manual and staged. Builds, preview deployments, and migrations do not delete tournament people.

1. Apply the reviewed forward repair `supabase/migrations/20260914000000_repair_referral_orphan_reclaim_prerequisites.sql` when the hosted database lacks orphan-recovery support, then apply `supabase/migrations/20260914010000_preserve_retired_tourney_identity_domains.sql` to the reviewed Roo Industries database before cleanup. It adds historical domain classification and protects retired identities from orphan reclamation; it does not retire existing users by itself.
2. Deploy and verify the results page on production. Retire the old tournament workers, scheduled jobs, and any older deployment endpoints that can still perform tournament writes. Keep commerce/referral reconciliation running.
3. Resolve unfinished tournament external operations, player Auth operations, and credential operations for the affected principals. The cleanup refuses these queues, including parked/dead-letter work; deleting a receipt cannot cancel an in-flight Auth request.
4. Run `node scripts/retire-tourney-people.mjs --env-file=/private/production.env` to produce and verify a private backup. Use a directory outside every Git checkout.
5. Review the targets and backup manifest. An explicitly approved production cutover can then run the same command with `--apply` and a **new** backup directory. The command checks the production results marker, retired API, Supabase project, and legacy Sanity project/dataset before applying.

The live migration ledger records many historical changes under different timestamps. Do not use a blanket history replay or `db push --include-all` for this cutover; apply only the reviewed forward migrations. The retirement migration refuses missing recovery prerequisites before changing account roles.

The apply path takes database locks while obtaining a consistent backup and cleaning up. Schedule this during the cutover window after tournament workers have stopped.

The script removes native tournament profiles, staff/password snapshots, operational queues, tournament aliases and active tournament roles. It keeps verified Auth/principal mappings and a `tourney_retired` domain marker; that marker contains no username, recovery email or credential and grants no tournament login. Existing creator profiles/roles, Auth identities/sessions, account mappings and commerce records are checked for changes inside the transaction.

SQL commits before the legacy Sanity staff document is cleared using its backed-up revision. `sql-completed.json` records that phase; `completed.json` records completion of both stores. If SQL fails, the legacy document is untouched. If a later legacy revision/write or receipt fails, preserve the backup and investigate the reported phase. A retry takes another verified backup in a fresh directory; it must not overwrite the previous backup or bypass revision checks.

## Regression checks

- `SUPABASE_TEST_DATABASE_URL=<isolated local URL> npm run test:referral-orphan-prerequisites:postgres17` checks the guarded forward repair, existing link behavior, reclaim proof, unknown-schema refusal and both migration orderings; all changes roll back.

- `npm run test:tourney-retirement:phases` exercises failures between the database, legacy store, and durable completion receipts.
- `SUPABASE_TEST_DATABASE_URL=<isolated local URL> npm run test:tourney-retirement:postgres17` tests profile deletion, shared creators, social sign-in, orphan-reclaim refusal, session preservation and queue guards. It applies the migration and synthetic fixtures inside transactions and verifies that all database changes roll back.

Never point the regression runner at production or use it as the cleanup command.

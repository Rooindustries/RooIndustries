# Daily payment reconciliation

Run `npm run reconcile:payments` from the checkout with Bash, jq, curl, flock,
timeout and the existing authenticated Executor CLI installed.

The job reads `https://www.rooindustries.com/api/payment/report`. Store its
32–128 character bearer token in `~/.config/roo/reconcile-token`, owned by your
account with mode `600`. The token travels through curl's standard input.

Each UTC day gets one Roo Website project update. Unresolved entities get a
child issue under ROO-498. Retries reuse the update, issue and status comment.
The issue description stays unchanged after creation; current evidence lives
in one machine-owned comment. Human notes and comments stay intact.

A clean scan does not close an old issue. The job checks open entities by ID,
including those outside the 72-hour scan, and closes an issue only after a
fresh positive audit. Missing entities, partial scans, ambiguous identity and
failed requests keep issues open. Identity errors need owner investigation.

State lives in `~/.local/state/roo-reconcile`. The existing mission-control
alert is `~/.local/share/mission-control/alerts/site-reconcile.json`.
`ROO_RECONCILE_TOKEN_FILE`, `ROO_RECONCILE_STATE_DIR`,
`ROO_RECONCILE_ALERT_FILE` and `ROO_RECONCILE_EXECUTOR_BIN` override those
locations and the CLI executable. The live report URL is fixed.

Reuse the existing `roo-reconcile` timer and puller after the maintained
script, jq helper and read credential have been installed and checked.
Keep the previous installation for rollback. This checkout does not enable
the timer or install credentials.

The job changes only sanitized Linear reporting records and its local
status files. It does not change bookings, referral credits, prices or
refunds. Investigate money differences in fixtures or test mode.

Run `npm run test:reconcile-payments` for repeatable local HTTP and CLI
fixtures. Test mode requires a private HTTP origin and an explicit fake-CLI
handshake. It refuses the production URL and does not use real Linear.

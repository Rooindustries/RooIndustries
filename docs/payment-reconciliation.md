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
Unresolved canceled and archived issues stay in the audit. Their workflow
states stay unchanged; clearing uncertainty requires fresh positive evidence.

State lives in `~/.local/state/roo-reconcile`. The existing mission-control
alert is `~/.local/share/mission-control/alerts/site-reconcile.json`.
The private `identities.json` retains observed issue UUIDs and their
reconciliation keys. If an unresolved identity leaves the scoped Linear list,
the job refuses before reporting or source requests; it never writes outside
the configured scope. Only an identity last verified recovered and closed can
leave without blocking. Missing or damaged identity state beside prior run
records also refuses. Restore and verify that state before retrying; deleting
it is not a reset.

Archived issues stay read-only and remain eligible for a fresh audit on every
run. Unknown or unaudited results keep the report incomplete, including when
the 200-target limit is reached.

Every retained valid financial identity needs a fresh audit each run; the
200-target limit keeps unaudited identities incomplete.
Closed recovered issues keep their status comment when fresh positive proof
leaves their known aliases unchanged.

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

The Dodo scan reads succeeded payments across their history, ending 30 minutes
before the check. It does not filter by the payment's creation date, because
a payment can settle days later. The 72-hour `from` value applies to the reverse
booking scan and recently changed owner-review records. Each payment is read
again before comparison. The scan stops after 2,000 listed payments and reports
incomplete coverage if that limit is reached; it cannot report clean then.

Run `npm run test:reconcile-payments` for repeatable local HTTP and CLI
fixtures. Test mode requires a private HTTP origin and an explicit fake-CLI
handshake. It refuses the production URL and does not use real Linear.

The report also sends each mismatch to the existing Sentry SDK. Events contain
the reason and a hash of the entity key. Retries stay in the same issue group.
Names, emails, payment details and request bodies stay out of these events.
A captured upgrade whose credit changed has its own owner-review reason.

Checkout, webhook and booking routes report handled server errors as well as
thrown errors. Expected client errors, such as a slot conflict or an invalid
signature, do not send a route alert. Sentry delivery has a two-second limit
and cannot change the route's result.

The [preview alert](https://rooindustries.sentry.io/monitors/alerts/1407819/)
emails the owner when a new issue appears or a resolved issue regresses.
It applies to the website's error monitor in the `preview` environment and
requires the `commerce_surface` tag. Production activation stays with release.
Existing alerts are unchanged. Disable this alert in Sentry to roll it back.

Run `npm run test:commerce-alerts` with the same Postgres 17 and PostgREST
setup as native CI. It seeds a succeeded test-mode payment without a booking,
reads it through the payment report route, runs the daily check twice and
checks the Sentry transport. Results go to `test-results/commerce-alerts/`.
The owner issue and daily update are reused on the second attempt. The check
also confirms the audit left payment and booking records unchanged.
`npm run test:commerce-alerts:routes` runs the route and transport checks
without Postgres. Both commands use local services and fake reporting accounts.

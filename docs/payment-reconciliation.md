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
Each report request has a finite 310-second client limit, allowing the route's
300-second budget plus a small transfer margin. After collecting the batches,
the job checks report freshness again before planning recovery. Evidence that
expired during a later request cannot close an issue or report a clean scan.
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

The Dodo scan first requests succeeded payments created in the last 72 hours,
excluding the most recent 30 minutes, then older checkouts with no lower
creation-date bound. Both ranges share the 2,000-summary limit. This prioritizes
recent payments without depending on provider ordering or excluding older
checkouts by creation date. The split boundary may appear in both ranges; details and
findings share identity caches. At most 21 pages are read, including the short
page that can finish each range. Before ordinary comparisons, details must also be at least 30 minutes
past the latest supplied payment `updated_at` or refund/dispute `created_at`.
A just-settled old checkout therefore waits for its webhook or reconciliation
to finish. During that grace period, daily findings omit it and targeted checks
return unknown, keeping existing issues open. Explicit terminal owner-review
records still alert immediately because their automatic processing has stopped.
If the optional update timestamp is absent or null, a matching server-confirmed
local capture or validated active dispute can supply its last update time.
A pending start or finalization lease is not capture proof. Without reliable transition evidence,
the window and targeted checks report `owner_review_dodo_settlement_time_unknown`
against that payment's identity. The daily command creates or reuses its owner issue,
and coverage remains incomplete. Creation time alone cannot establish settlement age;
the read-only endpoint invents no transition time or observation record.
Malformed or materially future timestamps make the report unavailable.
The 72-hour `from` value divides those payment ranges and bounds reverse booking transitions.
Stopped owner-review records, including exhausted booking recovery, are
discovered regardless of update age. Either terminal flag keeps a record unresolved
in daily and targeted checks. The two flag scans share a deduplicated limit of
200 records and report incomplete coverage when that limit is exceeded. Each
positive database filter also requires its field to exist before the limit is
applied. Ordinary records without recovery flags cannot crowd out terminal
records; the same presence rule applies to booking scan fields.
Age affects response priority only: recent booking findings stay ahead of old
terminal findings, which remain visible up to the response limit.
Each payment is read again before comparison. The scan stops after 2,000 listed payments and reports
incomplete coverage if that limit is reached; it cannot report clean then.
That ceiling is a hard lifetime limit for a complete scan, even if every
listed payment is healthy. Detail reads run in groups of eight, retain list
order and share in-flight reads for repeated identities.
Recent terminal records are checked before lifetime payments. Forward payment
comparisons establish booking bindings before the reverse booking scan.
The report stops starting work after four minutes and returns
incomplete coverage with any findings already established. Each provider read
is bounded through its response body; database reads keep their existing
30-second limit, leaving time for the response and telemetry within the
five-minute route limit. If targeted work runs out of time, all requested
identities return unknown and none can close an issue.
The response keeps at most 50 findings. Scan-limit warnings come first, then
findings tied to recent reverse-scan bookings or terminal recovery records,
then other lifetime payment findings. This keeps historical mismatches from
crowding out recent booking and owner-review alerts. Ordering stays stable
within each group, including entities already found by the forward scan.
Recent booking priority includes its booking, payment-record and payment IDs,
so early pricing and provider-binding failures retain that priority even
when their finding references the record instead of the booking.
The count still includes every finding, and overflow remains incomplete.
Retained historical issues remain eligible for targeted checks.
Terminal recovery findings use their payment-record identity in every scan.
A payment-key issue from an earlier report learns that record alias through
its own targeted check, so a change in provider listing membership reuses the
same owner issue and Sentry group.

The reverse scan includes recent captured, completed, refunded, pending and cancelled Dodo bookings,
so a refunded booking is still checked against provider details when its payment
is absent from the succeeded-payment listing. The same booking limit applies
across those statuses; an incomplete scan cannot report clean.
It also includes older bookings with a refund in the last 72 hours. Booking
creation, last refund time and refund-state updates form one deduplicated
200-booking limit. Each date window requires that date to exist; unrelated
updates to old captured bookings do not consume the refund window. Matching
refunds still need provider validation, and recent provider changes retain
their settlement grace period.
Recent dispute changes on older bookings use the stored `_updatedAt` timestamp.
Pending and cancelled bookings are included, as are other audited statuses with
a known dispute flag, including its false value after resolution. These windows
share the same 200-booking limit. Missing or conflicting active flags are checked
against provider details; correct dispute accounting preserves zero earnings for
pending and cancelled bookings.
Fully refunded bookings earn no referral commission, even when they keep a
historical commission amount. They can also keep their historical active-dispute
flag after a won or cancelled dispute: the writer intentionally leaves fully
refunded bookings untouched. This flag does not block recovery after full refund
accounting is verified and the payment record's current dispute state agrees
with the provider. A failed dispute update cannot close an issue, including for
an unbooked refund. Partial refunds also require the booking flag to agree.
Lost, accepted and expired disputes remain unresolved even if their saved
owner-review marker has not caught up with the provider.
A full refund before booking is clean only when
the provider's validated refund total matches the payment and the local record
confirms completed refund synchronization and released resources. A payment
without a booking still needs investigation if its refund is partial or
unfinished, or its record points to a missing booking.
Booked refunds remain unresolved until the payment record agrees with the
provider's cumulative refund total, currency and full or partial state, and
confirms completed booking synchronization. Updating the booking alone cannot
close its issue while that record still has pending or inconsistent refund work.
After a completed full refund before booking, positive targeted proof contains
the payment and record identities with `recovery: unbooked_full_refund`. The
daily job accepts that pair only for this explicit recovery type and only when
the issue has no known booking identity. Booked payments use `recovery: booking`
and require all three identity types. Missing types, duplicates, incomplete or
conflicting identity sets cannot close issues.
Pending, failed and review refunds with no succeeded amount do not change earnings.
The audit uses the writers' shared exact rational calculator for version-2 commissions,
including half-cent refund ties and authoritative frozen zeroes. Unversioned bookings
retain their historical operation order and earnings rules. No cent tolerance is applied.
Invalid writer markers cannot prove
recovery, and a cent above or below the matching writer result still alerts.
Stored financial proof must also be an exact cent amount. Extra precision in
pricing, commission, supplied totals or refunds stays unresolved instead of
being rounded into a match. Ordinary cent values such as 0.29 remain valid.
Frozen referral fields alone cannot prove credit. An ordinary booking must carry the
writer's `referralAccountingApplied: true`; completed refunds need their atomic refund
accounting checkpoint. The service-role-only `roo_booking_referral_audit` RPC checks that
the native earnings booking has the same source revision, hash, payload, status and ownership.
Missing or stale native credit stays unresolved in both scans and targeted checks. An
unavailable proof makes the report unavailable. Apply
`20261024010000_read_booking_referral_audit.sql` before enabling the updated report;
the function performs indexed reads only, returns no customer details and makes no repairs.
Historical reschedule recovery can intentionally omit a referral reference to
preserve earlier accounting. The audit accepts only that documented shape:
preserved accounting, no pending reconstruction, a reschedule booking and no
new referral-accounting flag. The referral code and frozen commission still
must match. Ordinary missing references and conflicting references remain
unresolved; the audit does not add a reference or change creator credit.
An admin cancellation preserved during a dispute stays cancelled after the
dispute closes and earns no referral commission. The audit accepts that state
only after the provider dispute and local booking flags agree.

The provider must return readable, valid details before the audit can establish
ownership and completeness. An unreadable or malformed account payment makes
the report unavailable, even if another payment is known to need attention.
The daily job records that failure and keeps existing issues open; it never
treats the unreadable payment as unrelated or reports a clean scan.

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
Internal logs and automatic exception capture for the same failed route share
one route event, retaining a sanitized stack. Successful responses and separate
metric-store errors keep their existing error reporting.

Local test and preview servers must unset Sentry DSNs, including server and
public/client aliases, or use a loopback collector. The maintained local
launcher removes inherited aliases and hosting markers and accepts only a
loopback DSN. Server reporting requires `NODE_ENV=production`,
`VERCEL=1` and `VERCEL_ENV=production` together. Hosted Preview, CI and a local
production build do not qualify. Initialization, automatic request capture and
commerce alerts share this gate, including loopback delivery. Positive local
E2Es set those markers explicitly and send only to their loopback collector.
Browser builds and the relay share ROO-719's private production gate. Keep builds
isolated so a previous build cannot retain a public DSN. Never use real Sentry
issues or notifications as local test fixtures. Production notification
activation stays with release.

Run `npm run test:commerce-alerts:preview` to exercise actual Next checkout,
booking and signed Dodo webhook failures against the local collector. Its
positive case builds and starts Next with all production markers. It also
checks that inherited aliases are removed, an external fixture DSN is refused,
and the browser relay is disabled or sends to the local collector. Each mode
gets a fresh isolated build directory. Its guard allows only the owned Next
server and local collector/database fixture. Next's exact development version
check uses installed-version metadata supplied in process, with a separate
audit; all other requests still pass through the network guard. Results and
envelopes go to
`test-results/commerce-alerts-preview/`; all owned processes stop afterward.

Run `npm run test:commerce-alerts:production` for the shared production-only
gate. One real production artifact starts as local, CI, hosted Preview and
Production, with the same valid loopback DSN. Every mode executes an actual
checkout start failure, signed test-mode Dodo webhook and booking failure.
Only Production sends one sanitized route event per category. The matrix
checks shutdown for late events and retains process markers, source hashes,
build logs and envelopes. Set `ROO_COMMERCE_PREVIEW_ARTIFACT` to choose its
artifact directory. This runtime matrix complements the fresh-build browser proof below.
The production fixture copies the site into its own temporary directory and
replaces only that copy's provider runtime-policy predicate with a test-only
predicate. Production hosting markers otherwise forbid Dodo test mode before
signature verification. The original production payment policy is unchanged;
actual route handling, signature verification and monitoring run, with local
database faults. This check asserts alert delivery, not a financial outcome.

Run `ROO_MONITORING_CASE=local,ci,preview,production npm run test:monitoring:deployments`
for the composed deployment proof. Each mode gets a fresh build with the same loopback
DSN and an opposing public enable override. Production sends browser, server, edge,
checkout, signed-webhook and booking events; the other modes send none. Each commerce
failure sends exactly one sanitized route event. One headless browser is reused, with
one Next server at a time. Build/server logs, browser traces, source hashes and stopped
processes are retained under `test-results/monitoring-deployments/`; set
`ROO_MONITORING_ARTIFACT` to choose the directory. The full command also covers development
and reusing a production artifact locally. All provider and database failures remain synthetic.

Run `npm run test:commerce-alerts` with the same Postgres 17 and PostgREST
setup as native CI. It seeds a succeeded test-mode payment without a booking,
reads it through the payment report route, runs the daily check twice and
checks the Sentry transport. Results go to `test-results/commerce-alerts/`.
The owner issue and daily update are reused on the second attempt. The check
also confirms the audit left payment and booking records unchanged.
The same command runs the deployment gate E2E with a fictional `.invalid` DSN
under transport and DNS guards, then three production-labelled route events
against a loopback collector. Its native reports also reach the daily command
after a signed pre-booking refund, on initial discovery of old terminal records,
after a four-day gap, and across local-capture grace without provider timestamps.
Missing referral application and stale native earnings projections keep both newly
discovered and retained issues open. An undated payment gets its own owner issue on
the first scan and after a four-day gap, with one identity reused across retries.
`npm run test:commerce-alerts:routes` runs the route and transport checks
without Postgres. Both commands use local services and fake reporting accounts.
The daily bridge accepts up to 60 seconds of server clock lead; reports older
than 15 minutes or farther in the future remain unavailable.

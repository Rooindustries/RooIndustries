# Roo Industries

rooindustries.com sells remote PC game optimization to competitive players and streamers who want more FPS, lower input lag, cleaner frametimes and stable performance in the games they play. Customers compare the Performance Vertex packages, book a session slot, pay, and get their PC tuned remotely. The site also carries free tools and the BIOS guide, before and after benchmarks, reviews, a referral program for creators, and a CMS the team edits.

## What we can never break

1. **Bookings.** A customer picks a slot, `/api/holdSlot` holds it while they fill in their details and pay, and their booking is recorded once. Never lose a held slot, typed details or a paid booking.
2. **Dodo checkout.** Payments run through Dodo Payments (`src/server/api/payment/`, webhook at `app/api/payment/webhook/dodo`); the PayPal and Razorpay paths still exist. Prove payment changes against fixtures or test mode, never production.
3. **The creator portal.** Creators register, verify, sign in and track their referrals, commission and payouts under `/referrals/*`. Their links and codes must keep crediting them.
4. **Speed.** Most public pages are prebuilt and served from the CDN (`force-static`, `revalidate = 60`; `middleware.js` handles queries and Markdown). Don't turn a prebuilt page back into a per-request render, and don't add weight before the first paint.
5. **SEO.** Indexable pages are listed in `src/lib/routes.js`, which builds `sitemap.xml` (the static `public/BIOSGuide/` page is added separately and carries its own metadata); the other titles, descriptions and canonicals come from `src/lib/seo.js`, and `public/llms.txt` guides agents. `/`, `/about`, `/contact` and `/privacy` also answer in Markdown. Keep that metadata and the server-rendered content intact.

## Hit every surface

A change is done when it works everywhere its behavior reaches. Say which of these applied:

- **Screens.** Phones (360 and 390 px wide) and desktop.
- **Pages.** Every `page.jsx` under `app/` (the routes in `src/lib/routes.js` plus the `/discord` redirect, `/upgrade/[slug]`, `/downloads/[slug]` and `/admin/*`), the static `/BIOSGuide` and the 404 page.
- **Flows.** Packages, the booking dialog, `/payment`, then `/payment-success` or `/thank-you`; a `?ref=` link through to a paid booking; an admin publish through to the public page after revalidation.
- **Route handlers.** Every `route.js` under `app/`: the APIs and payment provider webhooks in `app/api/`, the creator sign-in callback at `/auth/callback` and the Markdown routes.
- **Formats.** The HTML page, its Markdown variant where one exists, `sitemap.xml`, `robots.txt` and `llms.txt`.
- **Emails.** Booking emails (`src/server/api/ref/`) and creator account emails (`src/server/email/`).
- **Tests.** CI runs Jest, the Playwright suites and the Postgres 17 suites (`.github/workflows/tests.yml`). Run the ones your change touches locally first.

## Error tracking

Sentry (project `rooindustries-website`) gets Node server and browser errors when `NEXT_PUBLIC_SENTRY_DSN` is set; Vercel sets it for Production and Preview. Missing or malformed values leave reporting off; reporting failures cannot stop server startup. Middleware (edge) stays without the SDK so it stays light. The browser SDK loads only after a page's first uncaught error or error boundary, so it adds nothing before the first paint, and it sends through `/api/client-report`, which forwards only the envelope body (no cookies or headers) and only for this DSN, so ad blockers don't drop reports. Errors that route handlers catch and log with `logSafeError` are reported as the log label plus stack frames, never the error message. The server traces 5% of requests on its own roll; incoming `sentry-trace`/`baggage` headers can't raise that. Events carry no user, cookies, query strings, bodies, local variables, source lines or headers, and emails, card numbers and URL query strings in messages are replaced (`src/lib/monitoring/scrub.js`).

External DSNs require HTTPS; HTTP is allowed only for loopback fixtures. Invalid environment labels become `unknown` before SDK initialization. Automatic release-health sessions are disabled. Network breadcrumbs and HTTP client spans keep only the method, status and origin, so payment IDs in URL paths stay private. Caught-error reports keep the static label before any `: ` suffix and only unambiguous stack frames; local console logs keep the full label.

Check monitoring with `npm run test:monitoring`. `npm run test:monitoring:startup` builds and starts an isolated production fixture with a malformed DSN; the homepage must stay available and the reporting endpoint must stay off. Both use local fixtures with production traffic blocked.

## How we ship

- Keep related fixes for one task together in the same PR.
- Run the affected suites locally, then push once per round. Every push restarts CI. A round is the push after you have read the latest checks and reviews. Wait for those results before the next push.
- Do not buy GitHub Actions minutes. Private repos run CI locally on the exact head and post a `local-ci` commit status with the result. Run only affected browser groups while iterating, one at a time and headless on linux-dev-laptop; run the full suite once on the final head before posting success. Never use `pw-remote` or wake the 9950X3D for tests.
- Tests talk only to local fixtures: `scripts/test-tooling-sweep-server.mjs` refuses env files and outbound requests outside its allowed local fixture origins. Never point a test or script at production. The one exception is `npm run smoke:production`, which sends read-only GET requests to www.rooindustries.com.
- After every production deploy, `.github/workflows/production-smoke.yml` runs `npm run deploy:gate`: it smokes the money path (the money pages, booking availability, package prices, `?ref` capture) and, if that fails while the new deployment is live, rolls production back one step.
- Undo a bad deploy by hand with `VERCEL_TOKEN=… npm run deploy:rollback` (`-- --dry-run` to preview). A rollback pins production to the older deployment, so new deploys stay off the domain until `npm run deploy:rollback -- --undo` promotes the newest one.

### Own the pull request until it ships

The agent that opens a pull request owns it until the production deployment is verified, or until it has to stop for the owner. Opening the pull request is the start of that loop. Merging does not end ownership.

Each round, read the checks on the current head and every open review finding. The checks include the jobs in `.github/workflows/tests.yml` and the other checks on the pull request (Vercel, GitGuardian, CodeRabbit, Seer, and anything else that reported). The findings include every unresolved thread from CodeRabbit, Seer/Sentry, Codex, and any other reviewer. Fix the failures and the findings, push to the same branch, and repeat. When the branch is behind `main` or GitHub reports conflicts, rebase onto `main` and resolve the conflicts. A cancelled check is not green. Put the suites back on the head.

No coding agent merges a pull request. The Grok Bot assistant does not merge one either. Merging is the job of `.github/workflows/auto-merge.yml`. It squash-merges into `main` only when all of the following are true:

- Checks on the head pass. Success, skipped, and neutral count as green. Required Tests jobs that never started may instead be covered by a successful `local-ci` status on that exact head, as described below. Other pending, failed, and cancelled checks still block.
- CodeRabbit approves that head, and no review thread is still open. CodeRabbit is managed through the `serviroo2` account; the approval must still come from the real CodeRabbit bot.
- Sentry Seer has finished a clean review of that exact head. Its latest `Seer Code Review` check must be `completed` with conclusion `success`, from the installed Sentry app (id `12637`, slug `sentry`). A missing, pending, skipped, neutral or failed review does not pass this gate.
- No person has an open request for changes. It stands, on any commit, until that person approves or the review is dismissed.

The required Tests jobs are GitHub Actions check runs from this repository's `.github/workflows/tests.yml`, matched through workflow and check-suite identities. A same-named check from another app or workflow never stands in for one. A successful `local-ci` commit status can cover missing Tests jobs or jobs that never started. The collector checks every job attempt on the head: the replaced job must have no assigned runner and no executed step, and any existing check must match its job record. Missing or conflicting job evidence does not count. Queued jobs can already have `started_at` timestamps, so those timestamps alone do not prove execution. A started or failed executed job keeps its real result; local CI cannot hide it. All other checks still apply.

Only the latest `local-ci` commit status from the current head counts. An old-head status, a PR comment, or a check run named `local-ci` is not proof. A pending or failed newer status supersedes an older success. Both merge snapshots repeat these checks. Current `main` must be an ancestor of the PR head. The branch must be clean, or GitHub may report `unstable` solely because the unstarted Tests checks covered by local CI are still pending; conflicts, an outdated base and other unfinished checks still block.

Green means merge. No kind of change waits for the owner once it meets this bar: money paths, workflows, the merge gate, deploy and rollback scripts and migrations merge the same way.

CodeRabbit approves by a GitHub approval on that head with no later request for changes or dismissal. Sentry Seer's clean check is a separate requirement; neither reviewer replaces the other. Codex's GitHub review is optional: the workflow does not request it, wait for its verdict or apply a timeout to it. An existing open finding from any reviewer still blocks the merge, and the owning agent clears it.

A squash-merge to `main` starts the production deployment. The Vercel project ships `main`. The owning agent follows that deployment, checks the production smoke result, and confirms the intended version is live before finishing. If deployment or smoke fails, including an automatic rollback, the agent investigates, fixes the failure or reports the blocker, and verifies recovery. A failed or rolled-back deployment does not count as shipped. The owner should not have to merge a pull request that has already met the merge bar.

When CodeRabbit and Sentry Seer do not both approve, or a review thread is still open, the workflow keeps that same branch in a loop. The owning agent, woken by its pull request watch, addresses the findings and pushes. Review requests go only to eligible gating reviewers without approval on the current head, using `@coderabbitai review` or `@sentry review` as needed. A dismissed review reopens its request. A held review can be requested again once the findings are resolved, without an empty commit. That repeats until both approve and no review thread is open. The gate then merges, and the agent verifies production. After 8 review rounds without agreement, the workflow stops the loop and adds `needs-owner`.

The workflow flags the owner only when the loop cannot finish on its own: after 8 review rounds without agreement, a requested review remains pending for 24 hours, or GitHub blocks or rejects a merge that meets the bar. Human change requests stay with the owning agent until the review cap. Flagging is a `needs-owner` label and one comment on the pull request, from the workflow. Leave the pull request open. Money-path pull requests also follow the rules in Money paths (one at a time, Sol review, the local suites) before their final push.

Review mentions use `AUTO_MERGE_TOKEN` when available so integrations can receive a user-authored request. Only CodeRabbit and Seer without approval on the current head are requested. Each receipt and 24-hour deadline belongs to a reviewer, head and review state. A finished response or dismissal retires the previous receipt; a pending update keeps the active request and deadline. Human-authored markers do not suppress requests. Legacy receipts count only before that reviewer's first completed response on the head and only when they identify that reviewer. An older receipt explicitly requesting both CodeRabbit and Codex still covers CodeRabbit, but never Seer. The merge snapshots read the current `main` ref directly because the PR payload's base SHA can remain older.

The workflow's own GitHub Actions check is named `auto-merge-gate` and is excluded from merge snapshots only when its check-suite identity belongs to the current Auto-merge workflow run, including manual dispatches on a pull request branch. Every other check still counts, including another workflow's job with that name and earlier Auto-merge runs.

The workflow does not call any agent API. The owning agent finds out about a red check, a conflict, a new review or a new comment through its own pull request watch (in T3, `watch_pull_request` on that thread wakes it), fixes the branch and pushes. Keep that watch on while the pull request is open, until it closes or is flagged `needs-owner`. After merge, continue following Vercel and the production smoke workflow until production is verified; a pull request watch ending is not task completion. If the watch ends before merge or the thread is gone, whoever picks up the pull request next reopens the loop with a fresh watch. The workflow records one review-round marker for each head and completed review state that still needs work. Repeated runs on the same state do not add rounds; new completed attempts on the same head do. After 8 rounds it adds `needs-owner`.

The workflow merges with the GitHub Actions token. That token can land the squash commit, and it does not start a new Actions run on the merge commit. Vercel still receives the push and deploys `main`. If GitHub rejects the merge because of branch protection, the pull request comment says so. A repository secret named `AUTO_MERGE_TOKEN`, holding a token that can write to this repository, merges as that user instead, which also lets the Tests workflow run on the merge commit. This repository does not change branch protection or rulesets from the workflow.

## Invariants

- A rollback or undo only points production at a deployment that the Vercel API shows, at that moment, as READY, target production, in this project and not deleted. A rollback target must also be one Vercel lists as a rollback candidate and older than the live deployment. When Vercel's last promote put the live deployment in place, the target is the deployment that promote replaced; a deployment that a rollback already moved away from is never a target. The domain is read once more right before the request, and a rollback that Vercel records as moving away from any other deployment, or without recording which one it replaced, fails loudly (exit 2). Anything else is refused, never swapped for another target.
- The rollback tooling reads its credential from `VERCEL_TOKEN` only (the repo secret in CI), never from env files, and never prints it. `--dry-run` and `--status` change nothing, and an unknown option is refused.
- The automatic rollback acts only when the deployment that failed the smoke is live, is the newest production deployment and production isn't already rolled back. So it goes back at most one step per bad deploy and never touches a newer deploy.
- The production smoke sends GET requests only; its browser blocks any other method. It exits 2 only for a money-path failure, the only result that can trigger a rollback, and 1 when it can't run, including when the runner can't reach the site at all (DNS, TLS, refused or reset connections before or during a response or while loading a page resource, a closed browser) or the smoke runs out of its own time budget. Blocked or refused resources (CSP, CORS, redirects, bad responses) and a request the site leaves unanswered past its timeout are site failures.

What must always be true where money moves: payments, bookings and holds, referral credit, refunds and credits. Each line cites the code that enforces it, checked on `febd7d26`, or says **NOT ENFORCED** with the scenario that breaks it. Line numbers drift. If a cited line no longer does what the invariant says, fix the invariant or the code in the same PR. Never soften a gap into an invariant.

### Money paths

A file is a money path when a payment, booking, hold, price, discount, referral credit, refund or payout decision reaches it. These are the known ones:

- `app/api/payment/`, `app/api/holdSlot/`, `app/api/releaseHold/`, `app/api/ref/`, `app/api/admin/referral-creators/`
- `src/server/api/payment/`, `src/server/booking/`, `src/server/api/ref/`, `src/server/referrals/`
- `src/server/commerce/`, `src/server/data/documentClient.js`, `src/server/supabase/` (the stores those decisions read and write)
- `src/lib/cms/contentSchema.js`, `src/lib/cms/contentPreservation.js`, `src/server/cms/`, `app/api/admin/content/` (coupon validation and publishing can change checkout pricing and coupon capacity)
- `src/lib/packagePricing.js`, `src/lib/checkoutStorage.js`, `src/lib/checkoutCodes.js`, `src/lib/salesAttribution.ts`, `src/lib/useUpgradeEligibility.js`
- `src/components/BookingForm.jsx`, `BookingModal.jsx`, `Packages.jsx`, `Payment.jsx`, `PaymentSuccess.jsx`, `ReservationBanner.jsx`, `UpgradeLink.jsx`, `UpgradeXoc.jsx`, `RefDashboard.jsx`
- `src/components/admin/ReferralCreatorEditor.jsx`, `src/components/admin/referralDraftStore.js`
- `src/next/AppClientRuntime.jsx` (referral capture) and `middleware.js` (its query handling reaches `?ref`)
- `supabase/migrations/` and the `crons` in `vercel.json`

Any PR that touches a money path, including a helper outside this list:

1. Is the only open money-path PR. Money-path PRs merge one at a time.
2. Names the invariants below that it touches.
3. Lists every entry point into the changed behavior, each with an E2E case: full page load, in-app navigation, Back and Forward, second tab, API, webhook, cron and retry. It also lists every state its data can be in.
4. Shows each new E2E failing against the base branch locally, then merges it together with the fix once it passes.
5. For data from a provider (Dodo, Supabase), lists every field and documented state with the code that handles it.
6. Runs these locally before merge, and says which links of the chain they cover:
   - `npm run test:booking-flow`: the browser flow from the packages to the payment handoff. Fixtures answer the hold, quote and start, and it ends at a synthetic checkout handoff, so it never confirms a paid booking or a credit. (`tests/fixtures/booking-flow.cjs:71-89,131-141`)
   - `node scripts/test-payment-persistence-sweep.mjs --full-chain`, with Postgres 17 set up as in the native CI job: the payment flow functions against a real database on the full migration chain. It calls them through its own fixture router, not the Next webhook route (`scripts/test-payment-persistence-sweep.mjs:203`). Additional start, completion and referral scenario groups require `--a1` or `--a2` (`:19,40-48`).
   - the referral suites, when credit changes.
   - **NOT ENFORCED (ROO-507):** no test runs the whole chain: booking, Dodo checkout, a signed webhook through `app/api/payment/webhook/dodo/route.js`, the confirmed booking and the creator's credit. Until one does, a money-path PR names the links its tests leave out.
7. Gets a Sol review briefed with the diff, these invariants and the entry points, and asks it to break each one (up to 5 rounds).
8. Gets a read-only production smoke after deploy.
9. Gives every bug found a one-line root cause and a new invariant line or regression E2E.

### Referral attribution

- The passive referral lives in `sessionStorage["referral_session"]` (`src/lib/checkoutStorage.js:125-134`). There is no visitor attribution cookie; `REF_SESSION_COOKIE` is the creator portal login (`src/server/api/ref/auth.js:5,124-137,158`).
  - An applied code is also copied into the booking draft (`booking_draft.packages[<package>].checkoutCodes.referral`) and the checkout state (`checkout_booking_state.referralCode`). (`src/components/BookingForm.jsx:1283-1297,1303-1313,2377,2405`)
  - Analytics attribution is a separate journey snapshot, not a copy of the applied code. Applying another code doesn't update it, so a booking can send `referralCode` B with an analytics `creatorCode` A. (`src/lib/salesAttribution.ts:53-68`, `src/components/BookingForm.jsx:2381`)
  - An independently opened tab or window, with no session to restore, starts empty. A same-origin tab or window opened with its opener kept initially copies that opener's session storage; one opened with `rel="noopener"`, like the booking FAQ link (`src/components/BookingForm.jsx:3005-3008`), starts empty. A restored session keeps its own. ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage))
- At the site runtime and the packages section, a non-empty `?ref=` replaces the stored code, and an empty or missing `?ref` leaves it alone. The capture points:
  - the site runtime, outside `/booking`, `/payment`, `/payment-success` and `/thank-you` (`src/next/AppClientRuntime.jsx:10,82`);
  - the packages section, on mount (`src/components/Packages.jsx:107-117`);
  - `/booking`, on every change of its query or of the draft's removed code, with its own rules below (`src/components/BookingForm.jsx:487-495,648-663`).
- **NOT ENFORCED (ROO-475, addressed by open PR #242):** the site runtime captures only once per document (`src/next/AppClientRuntime.jsx:81-83`). So an in-app move to a public page carrying `?ref=` keeps the older code or none, unless that page is `/booking` or mounts the packages section.
- `/booking?ref=X` stores X unless X is the code the visitor removed in this booking draft. `/booking?ref=` with a blank value clears the stored code. (`src/components/BookingForm.jsx:487-495,648-663`)
- **NOT ENFORCED (ROO-475, addressed by open PR #242):** while the draft remembers removed code A, reopening `/booking` without a different nonempty explicit referral clears the stored code, even when it belongs to creator B (`src/components/BookingForm.jsx:649-663`). So remove A, follow B's link on another public page, then reopen `/booking` without `?ref`, and B is cleared before auto-apply. An explicit `/booking?ref=B` stores B instead.
- The normal booking review flow sends only a referral the server validated in this session; raw API requests can still store an unknown code as documented below. The review step auto-applies `?ref` or the stored code once per package and code, and only while a hold is active and no referral is applied. (`src/components/BookingForm.jsx:1921-1990,2377,2405`)
- An invalid code is dropped and remembered as dismissed. A code that can't be checked right now (validation unavailable) is kept so the visitor can retry. (`src/components/BookingForm.jsx:1952-1964`)
- The draft remembers one removed code at a time, and the auto-apply skips it.
  - Applying another code clears that memory (`src/components/BookingForm.jsx:1709-1713`), and removing a code replaces it (`:1775-1785`).
  - Remove A, apply B, remove B, then open `/booking?ref=A`, and A applies again. Creator links use `/?ref=A` (`src/components/RefDashboard.jsx:349`); following that link and reopening `/booking` without `?ref` clears A while B is remembered, as in the ROO-475 gap above. (`:649-663,1936-1940`)
- **NOT ENFORCED (second creator link after a code is applied):** a booking draft restores its applied referral (`src/components/BookingForm.jsx:1229-1272`), and auto-apply skips when one is applied (`:1928`).
  - So creator A's code applied at review, then creator B's link in the same tab, still credits A, even on `/booking?ref=B`.
  - The restore also falls back to the last-used package's draft (`:1245-1247`).
  - Policy call pending (ROO-510): last click or first applied.
- On `/payment` the code comes from `?ref`, then the booking's code, then the stored code, in that order. It is re-validated, and an invalid code is cleared from storage. (`src/components/Payment.jsx:697-700,769-773,791`)
- The server never trusts the client's discount or commission.
  - It resolves the code itself: lowercased slug, creators whose `registrationStatus` isn't `pending_email`.
  - It takes discount and commission from that creator's current percentages. (`src/server/api/ref/pricing.js:227-228,443-463,610-616`)
- **NOT ENFORCED (unknown or unverified code):** when no creator matches, `effectiveReferralCode` keeps the raw code at 0% commission (`src/server/api/ref/pricing.js:456-457`). Earnings match bookings by referral id or by lowercased code (`src/server/api/ref/payoutUtils.js:87-102`).
  - The normal checkout validates codes first and drops unknown ones (`src/server/api/ref/validateReferral.js:93-107`, `src/components/Payment.jsx:719-726`). A raw API request can still store one.
  - A creator who books before verifying their email gets no credit on those bookings (ROO-512).
- **NOT ENFORCED (self-referral):** nothing compares the buyer with the creator, so a creator can book with their own code and earn commission. Policy call pending (ROO-511).
- Commission is frozen on the booking when it's created. (`src/server/api/ref/createBooking.js:1293-1320,1615-1621`)
  - **NOT ENFORCED:** a PayPal or Razorpay capture recovered as a reschedule booking loses its commission (ROO-520). Only the Dodo branch copies the commission fields (`src/server/api/ref/bookingCommit.js:313-328`); the other branch keeps the referral but not the commission (`:329-374`), so earnings compute 0 (`src/server/api/ref/payoutUtils.js:41-50`).

### Bookings and holds

- A slot has at most one hold, keyed by its start time. A held slot is refused to anyone without the hold token, and an expired hold can be reclaimed. (`src/server/booking/holdSlot.js:241,346-373,415-451`)
- A slot with an active booking lock or a blocking booking can't be held. This is rechecked after the hold read. (`src/server/booking/holdSlot.js:304-311,318-335`)
- A slot that has already started can't be held. (`src/server/booking/holdSlot.js:337-342`)
- A hold lasts 20 minutes, and starting a payment resets it to 20 minutes from payment start. (`src/server/booking/holdSlot.js:23,344`, `src/server/api/payment/paymentRecord.js:23`, `src/server/api/payment/flow.js:2899,3016-3025`)
- Payment-pending holds have separate guards for each client operation:
  - Release requires an unexpired matching token; with that token, `payment_pending` returns 409 without checking the stored hold expiry. (`src/server/booking/releaseHold.js:56-72`, `src/server/booking/holdToken.js:75-89`)
  - A move to a different slot returns 409 when a matching, unexpired previous token proves ownership of a `payment_pending` hold. An expired token does not pass that guard; acquiring another available slot does not release the previous pending hold. (`src/server/booking/holdSlot.js:105-147,243-266,462-466`, `src/server/booking/holdToken.js:75-89`)
  - Same-slot refresh refuses `payment_pending` while the stored hold is active. An expired target hold can be reclaimed with a fresh nonce, subject to the other slot and booking checks. (`src/server/booking/holdSlot.js:28-36,346-367,415-442`)
  - A provider-confirmed unpaid cancellation (the visitor changes payment method) reopens its own unexpired hold with a new nonce. (`src/server/api/payment/flow.js:3502-3576,3680-3693,3730-3785`, `src/server/api/payment/cancel.js:9-14`) If that hold has expired, the payment is abandoned and the slot released, with no new hold. (`src/server/api/payment/flow.js:3661-3677`) Upgrades have no slot hold.
- Each hold generation (hold id plus nonce) has at most one payment record, and a second start for it reuses that record. (`src/server/api/payment/paymentRecord.js:136-137`, `src/server/api/payment/flow.js:1273,1291-1300,2860-2878`)
- An ordinary booking commits only against an active, unexpired hold for the same time, package, payment record and backend. (`src/server/api/ref/bookingCommit.js:59-77,166-169`) The exceptions:
  - upgrades book with no slot (`src/server/api/ref/createBooking.js:1660`);
  - a verified paid capture whose hold expired or vanished can book a free slot when its reconciliation proof and remaining commit checks pass (`src/server/api/ref/createBooking.js:1450-1478,1682-1684`, `src/server/api/ref/bookingCommit.js:59-77`). A matching expired hold can pass; a released or replaced hold can fail even while the slot is free;
  - reschedule records carry no slot: they keep only `originalRequestedStartTimeUTC`, with no start time or slot lock (`src/server/api/ref/bookingCommit.js:306-374`).
- A booking is recorded at most once per payment:
  - it has a deterministic id with a replay check (`src/server/api/ref/bookingCommit.js:138-146,268-276`);
  - one payment proof can't fund two bookings (`:162-165`);
  - the slot lock and the hold consumption commit in one transaction (`:186-215,261-266`).
- A recognized, validated capture whose booking fails on a slot conflict or a payload problem becomes a "requires reschedule" booking. This happens from the 5-minute reconcile (`vercel.json:66`, `src/server/api/payment/flow.js:4779-4789,4892-4917`) and from a late capture after abandonment (`:2384-2400`). The record is built at `:4027-4060`.
- **NOT ENFORCED (capture without a booking, ROO-499):** some captures end with neither a booking nor a reschedule record:
  - owner-review states, such as upgrade credit that dropped after capture (`src/server/api/payment/flow.js:1936-1965,3933-3942`);
  - exhausted retries: 12 failed finalizes set `reconciliationRecoveryTerminal` (`:105-117,1870-1911`), and reconcile then skips the record (`:4347`).
- A definitive unpaid abandonment tries to release the hold and the coupon reservation. If the release fails it keeps `resourceReleasePending` and retries. (`src/server/api/payment/flow.js:1687,1746-1752,1781,2634,2696-2732`)
  - A payment still pending after its hold expires releases only the hold; its coupon reservation stays. (`src/server/api/payment/flow.js:3828-3840,4848-4854`)
- **NOT ENFORCED (ROO-225, PR #227 parked):** when the hold expires in the booking dialog or on `/payment`, the visitor should stay in the flow with a reason and keep what they typed.
  - Today `src/components/ReservationBanner.jsx:199-201,241-245` clears only the browser's copy of the hold, with no release call. It deletes `booking_draft` (`:234`) and sends them to `/` (`:237`) with no message.

### Dodo payments and webhooks

Sources: Dodo's [webhook guide](https://docs.dodopayments.com/developer-resources/webhooks), [event types](https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide) and [payment statuses](https://docs.dodopayments.com/api-reference/payments/get-payments-1).

Creating a checkout:

- The server sets the product amount from the quote's `netAmount`, never from a client value. A start with a stale quote fingerprint is refused. On tax-exclusive products, the customer's total adds tax on top. (`src/server/api/payment/flow.js:2961,2983,3228-3253`, `src/server/api/payment/dodoProvider.js:26-27,49`)
- A paid quote can't be forced into the free checkout, and a zero-value quote carries zero commission. (`src/server/api/payment/flow.js:3258-3278`, `src/server/api/ref/pricing.js:589-603,660-663`)
- A payment access token is bound to its record, provider, pricing, backend and generation. (`src/server/api/payment/flow.js:891-944`, `src/server/api/payment/accessToken.js:134-158`)
- An upgrade intent is bound to its original booking, buyer email, target package, backend and generation when the checkout starts, and is frozen for finalization. (`src/server/api/payment/flow.js:3178-3198`, `src/server/api/ref/createBooking.js:395-407`)
- A checkout is USD only, with no currency switch, no Dodo discount codes and a locked email. It is idempotent per payment record. (`src/server/api/payment/dodoProvider.js:48-64`, `src/server/api/payment/flow.js:2789-2791`)
- The Dodo product must be one-time and USD, pay-what-you-want, with the recorded tax mode, no PPP, no discount, and a floor no higher than our amount. Otherwise no checkout is made. (`src/server/api/payment/dodoProvider.js:30-38`)
- The checkout URL must be https on the Dodo checkout host for the current mode. (`src/server/api/payment/dodoProvider.js:66-72`)

Validating a payment, on every path (webhook, return page, reconcile):

- `payment_id`, `checkout_session_id`, `metadata.paymentRecordId` and any stored payment id must all match the record. A missing one fails the match. (`src/server/api/payment/dodoProvider.js:86-90`)
- The record's Dodo environment (test or live) must be the server's current one, whose key the payment is read with. (`src/server/api/payment/dodoProvider.js:91-93`)
- The currency must be USD and equal to the record's. (`src/server/api/payment/dodoProvider.js:94-95`)
- `total_amount` minus any added tax must equal the quoted `netAmount` in cents. Missing tax counts as 0, and tax must be between 0 and the total. (`src/server/api/payment/dodoProvider.js:96-102`)
- A succeeded payment must have exactly one cart line, with quantity 1, for the recorded product. A missing cart fails. (`src/server/api/payment/dodoProvider.js:103-106`)
- Refunds and disputes must be arrays. (`src/server/api/payment/dodoProvider.js:107-108`)
- Payment data from the client is never trusted. The return page triggers a server lookup. (`src/server/api/payment/flow.js:1011`, `src/server/api/payment/dodoProvider.js:137-140`)
- **NOT ENFORCED (owner alerts, ROO-499):** a captured payment that fails validation or ends in owner review should reach the owner. Today it ends silently.
  - It becomes `needs_recovery` with `providerRecoveryTerminal`, and reconcile skips it from then on. (`src/server/api/payment/flow.js:4441-4442,4459,4465-4472`)
  - Or the webhook acknowledges a binding mismatch with 200 (`:6141`).
  - The same silent end applies to lost, accepted or expired disputes (`:5883,5936`), upgrade-credit reviews (`:1945-1964`) and refunds with incomplete details (`:5990-5996`).
- **NOT ENFORCED (rare, ROO-498):** a payment without `metadata.paymentRecordId`, such as one through the product's public buy link, is acknowledged and dropped. (`src/server/api/payment/flow.js:6122`)
- Fields read from a payment: `payment_id`, `status`, `total_amount`, `tax`, `currency`, `checkout_session_id`, `metadata.paymentRecordId`, `product_cart`, `refund_status`, `refunds` and `disputes`. `customer.email` is kept only as a fallback contact email for a recovered booking (`src/server/api/payment/dodoProvider.js:159`, `src/server/api/ref/bookingCommit.js:334`). No money decision reads any other field (customer, billing, card and payment method details, brand and business ids, discounts, settlement amounts), so none of them can change one.

Payment statuses:

- `succeeded` goes to finalization after refunds and disputes are handled: a fully refunded payment stops there, and so does an active dispute (`src/server/api/payment/flow.js:6070-6079`). Finalization then books, takes the reschedule path, or stops in owner review or exhausted retries, as in "capture without a booking" above. (`:6080-6085`)
- `failed` and `cancelled` end the record and release its resources, unless a booking exists or a dispute is active. (`src/server/api/payment/flow.js:6053-6068`)
- `requires_payment_method` counts as unpaid. Reconcile abandons the record once it is older than the 20-minute payment hold. (`src/server/api/payment/dodoProvider.js:128-129`, `src/server/api/payment/paymentRecord.js:23`, `src/server/api/payment/flow.js:4822-4829`)
- `processing`, `requires_customer_action`, `requires_merchant_action`, `requires_confirmation`, `requires_capture`, `partially_captured`, `partially_captured_and_capturable`, and a null status are pending.
  - For a checkout still in progress the webhook answers 503 so Dodo re-delivers. A record already booked or refunded answers 200. (`src/server/api/payment/dodoProvider.js:128-129`, `src/server/api/payment/flow.js:6087-6090,6145-6147`)
  - A later success after hold expiry follows the conditional booking exception above. If reconcile already released the hold, booking can fail with `hold_changed` and take recovery/rescheduling even when the slot is free (`src/server/api/payment/flow.js:1709-1738,3828-3840,4848-4854,4901-4917`). An already abandoned checkout takes reschedule recovery (`:2384-2400`); a taken slot also requires rescheduling.
  - ACH Direct Debit can stay `processing` for days ([Dodo ACH](https://docs.dodopayments.com/features/payment-methods/ach)). Its final success or failure arrives as its own event, and the 5-minute reconcile re-reads it; once its hold has expired, only the hold is released. (`src/server/api/payment/flow.js:4463-4485,4848-4854`)

Refunds:

- A null `refund_status` means no succeeded refund; pending, failed or review refunds can still exist, and `refunds` is read either way. ([Dodo payment schema](https://docs.dodopayments.com/api-reference/payments/get-payments-1), `src/server/api/payment/flow.js:5953-5980`)
- A `succeeded` refund must match the payment, with a positive amount no larger than the total and the same currency, before it's applied. A missing amount or currency is fetched from Dodo first. (`src/server/api/payment/flow.js:5982-6006,6041-6052`)
- `failed`, `pending` and `review` are recorded with no accounting change. Any other status gets a 409, and Dodo retries. (`src/server/api/payment/flow.js:5955-5980`)
- `refund_status: full` with succeeded refunds below the total, or `partial` with none succeeded, answers 503 and waits for the details. (`src/server/api/payment/flow.js:6007-6012`)

Disputes:

- All seven dispute statuses and three stages are validated, and each dispute's id, payment id and currency must match the payment. Anything else gets a 409. (`src/server/api/payment/flow.js:5870-5876`)
- An open dispute moves a `captured` or `completed` booking to `pending`, zeroes the commission and puts the record in `needs_recovery`. A cancelled booking stays cancelled, and a fully refunded booking isn't touched. Open means any status except `dispute_won` and `dispute_cancelled`. (`src/server/api/payment/flow.js:5884-5888,5906-5925,5939`)
- `dispute_won` and `dispute_cancelled` restore the earlier status only if the booking is still `pending` with its dispute flag set, so an admin's cancellation in between stands. The commission returns at the retained share either way; a cancelled booking still earns nothing, since earnings count only `captured` and `completed`. (`src/server/api/payment/flow.js:5908-5921`, `src/server/api/ref/payoutUtils.js:87-93`)
- A disputed payment never finalizes a booking. (`src/server/api/payment/dodoProvider.js:147-149`, `src/server/api/payment/flow.js:6073-6079`)

Webhook delivery:

- Every webhook is verified on its raw body before any processing: a Standard Webhooks signature with 5-minute timestamp tolerance. A failure answers 401, 409 or 503. (`src/server/api/payment/flow.js:6094-6100`, `src/server/api/payment/dodoProvider.js:163-167`)
- A webhook without `webhook-id` is refused. (`src/server/api/payment/flow.js:6101-6102`)
- Payload state is never trusted. The payment is re-read from Dodo by `data.payment_id`, so stale or out-of-order events act on the latest state. (`src/server/api/payment/flow.js:6108-6121`)
- Only these event types are processed: `payment.succeeded`, `payment.failed`, `payment.processing`, `payment.cancelled`, `refund.succeeded`, `refund.failed` and `dispute.*`. Every other event gets 200 and is ignored. (`src/server/api/payment/flow.js:6103-6104`)
- Each claimed Dodo `webhook-id` has one receipt. Ignored event types and payments with no matching record return before a receipt is made. (`src/server/api/payment/paymentRecord.js:183-194`, `src/server/api/payment/flow.js:1599-1636,6103-6104,6122,6129-6136`)
  - A repeat whose receipt is already `processed` with an unchanged fetched state answers 200. (`src/server/api/payment/flow.js:1625-1627`)
  - A receipt released as `retryable` (an earlier delivery answered non-2xx) is claimed and processed again even with an unchanged state, so an unfinished effect gets retried. (`src/server/api/payment/flow.js:1668-1680`)
  - A changed state is processed again, thanks to the stored hash.
  - A different type or identity under the same id is a binding conflict (409).
  - A receipt held by a concurrent delivery (120-second lease) answers 503 at once.
- A webhook answers 2xx only after its effect is durably recorded, or when it's irrelevant. Otherwise its receipt is released for retry. (`src/server/api/payment/flow.js:6137-6155`)

### Refunds and credits

- A full refund marks the booking refunded and, in one transaction:
  - releases the slot lock it owns;
  - restores the consumed coupon use;
  - decrements the creator's `successfulReferrals`.
  - (`src/server/api/ref/bookingRefunds.js:228-314`)
- Commission counts only `captured` and `completed` bookings, so a fully refunded booking earns none. (`src/server/api/ref/payoutUtils.js:87-93`, `supabase/migrations/20260712092342_close_supabase_port_and_unified_auth.sql:1513`)
- Refund accounting applies once:
  - full refunds through `refundAccountingAppliedAt`;
  - non-Dodo partial refunds through `processedRefundIds`;
  - Dodo partial refunds through a `refundedAmount` that only goes up.
  - (`src/server/api/ref/bookingRefunds.js:154-158,171-186,211-226`)
- A Dodo partial refund scales commission to the retained share, or to 0 while a dispute is active. (`src/server/api/ref/bookingRefunds.js:154-168`, `supabase/migrations/20260909090000_add_dodo_payment_provider.sql:25-30`)
- **NOT ENFORCED (ROO-508):** commission should never exceed the commission on the money we kept. A PayPal or Razorpay partial refund records `refundedAmount` but keeps the full `commissionAmount`. (`src/server/api/ref/bookingRefunds.js:187-201`)
- **NOT ENFORCED (ROO-509):** `successfulReferrals` should count only bookings we kept.
  - A lost chargeback zeroes commission (`src/server/api/payment/flow.js:5909-5925`) but never decrements the count. Only a full refund does (`src/server/api/ref/bookingRefunds.js:298-302`).
  - The count unlocks split editing at 5. (`src/server/api/ref/updateSplit.js:71-73`)
- A new coupon reservation enforces `maxUses`, counting consumed uses plus active reservations, under revision guards. (`src/server/api/ref/couponReservations.js:83-88,119-131`)
  - **NOT ENFORCED as a hard ceiling:** a late paid capture consumes its released reservation even when the cap is already reached, and records `capacityExceededAtRecovery`. (`src/server/api/ref/couponReservations.js:188-226`, `src/server/api/ref/bookingCommit.js:416-424`)
  - Lowering `maxUses` doesn't recheck existing reservations. (`src/server/api/ref/couponReservations.js:232-258`)
- A coupon reservation belongs to one checkout owner. That is normally its payment record, or the deterministic booking id for legacy and free completion. (`src/server/api/ref/bookingCommit.js:170-173`, `src/server/api/ref/createBooking.js:1571-1576`)
  - A late capture after the reservation was released is still accounted for. (`src/server/api/payment/flow.js:4055-4056`)
- Positive upgrade credit requires one server-verified USD payment matching its booking, provider, payment identifiers, amount, backend and generation, whether or not anything was refunded. A bound zero-value free booking contributes zero. Settled refunds reduce credit; a full refund or reversal gives no credit, and disputed or unverifiable sources refuse the upgrade. (`src/server/api/ref/pricing.js`, `getRetainedUpgradeCredit`; E2E: `tests/upgrade-credit.mjs`, `tests/upgrade-credit-ownership.mjs`)
- If the credit dropped after the quote, a captured upgrade is held for owner review instead of booked. (`src/server/api/ref/pricing.js:346-370`, `src/server/api/payment/flow.js:1936-1965,3933-3942`)
- One upgrade checkout owns a booking chain's credit across targets and fresh intents. Equivalent retries reuse it; competing checkouts are refused. Only a started record may return a provider handoff; booked and email-partial records remain eligible for completion responses. Cancellation or a full refund releases only its owner's lock. A higher upgrade can atomically take over after the preceding upgrade is booked. Closed checkouts are never reused; a failed refund cleanup must finish before a fresh checkout starts. Final booking and reschedule recovery guard the lock and credit-source revisions together. A bound pre-deploy session lock can acquire the root lock in that same booking transaction, updating the payment's cleanup key; competing legacy captures cannot both book. A late capture without ownership stays in review. (`src/server/api/payment/flow.js`, `createOrReusePaymentRecordForStart`; `src/server/api/ref/pricing.js`, `resolveCapturedUpgradeFunding`; `src/server/api/ref/bookingCommit.js`, both commit paths; E2E: `tests/upgrade-credit-ownership.mjs`)

## Repository rules

These rules apply to every agent and every contributor working in this repository.

## Keep agent process artifacts out of Git

Only files a maintainer can run or read on purpose belong in the repository. Never commit:

- Review-round or process leftovers: "fixround", "outside-data", "evidence", "proof", "rehearsal", "signoff" or "before-source" scripts, fixtures, inventories or JSON reports.
- Captured database dumps, rollback captures or schema snapshots taken from a local or test database.
- Scripts that only work on one machine: hardcoded /tmp, /Users or /home paths, personal worktree paths, or binaries built for one box.
- Test or check scripts that no package.json script, config file or source file runs. If a check matters, wire it into package.json; if it does not, do not add it.
- Generated reports, screenshots, traces or test output. Those stay under the gitignored test-results/ and audit/ directories.
- Minified or single-line code. Scripts use the same formatting as src/.
- Narrating comments, docstrings, banners, generated-by markers or process notes. Comment only where the code cannot explain itself.

## Public Git text

- Commit subjects are conventional and under 72 characters; the body stays empty.
- No model or tool attribution, co-author trailers, signatures or generated-by footers in commits, pull requests or files.
- Pull request text describes completed functional changes only, with no testing or verification narration.

## Before opening a pull request

- After the pull request is open, follow "Own the pull request until it ships". The open pull request is not the end of the task.
- `git status` shows only the files the change needs. Delete scratch files instead of renaming or parking them.
- Every new script runs from a clean checkout without machine-specific paths; fixture locations come from environment variables with documented defaults.
- Branch names use the `servi/` prefix with a short description, for example `servi/review-carousel-loop`.

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

## How we ship

- Small PRs, one fix each. Two fixes are two PRs.
- Run the affected suites locally, then push once per round. Every push restarts CI.
- Tests talk only to local fixtures: `scripts/test-tooling-sweep-server.mjs` refuses env files and outbound requests outside its allowed local fixture origins. Never point a test or script at production.

## Invariants

What must always be true where money moves: payments, bookings and holds, referral credit, refunds and credits. Each line cites the code that enforces it, checked on `febd7d26`, or says **NOT ENFORCED** with the scenario that breaks it. Line numbers drift. If a cited line no longer does what the invariant says, fix the invariant or the code in the same PR. Never soften a gap into an invariant.

### Money paths

These files are money paths:

- `app/api/payment/`, `app/api/holdSlot/`, `app/api/releaseHold/`, `app/api/ref/`
- `src/server/api/payment/`, `src/server/booking/`, `src/server/api/ref/`
- `src/components/BookingForm.jsx`, `BookingModal.jsx`, `Payment.jsx`, `PaymentSuccess.jsx`, `ReservationBanner.jsx`
- `src/lib/checkoutStorage.js`, `src/lib/checkoutCodes.js`, `src/lib/salesAttribution.ts`, `src/next/AppClientRuntime.jsx` (referral capture), `middleware.js` (its query handling reaches `?ref`)
- `supabase/migrations/` and the `crons` in `vercel.json`

A PR that touches one:

1. Is the only open money-path PR. Money-path PRs merge one at a time.
2. Names the invariants below that it touches.
3. Lists every entry point into the changed behavior, each with an E2E case: full page load, in-app navigation, Back, second tab, API, webhook, cron and retry. It also lists every state its data can be in.
4. Lands a failing E2E on `main` before the fix.
5. For data from a provider (Dodo, Supabase), lists every field and documented state with the code that handles it.
6. Runs the booking-to-payment chain locally before merge:
   - `npm run test:booking-flow`
   - `node scripts/test-payment-persistence-sweep.mjs --full-chain`, with Postgres 17 set up as in the native CI job
   - the referral suites, when credit changes
7. Gets a Sol review briefed with the diff, these invariants and the entry points, and asks it to break each one (up to 5 rounds).
8. Gets a read-only production smoke after deploy.
9. Gives every bug found a one-line root cause and a new invariant line or regression E2E.

### Referral attribution

- The visitor's code lives only in `sessionStorage["referral_session"]`, for the current tab.
  - There is no referral cookie; `REF_SESSION_COOKIE` is the creator portal login.
  - A closed tab, a new tab, a new window or a different browser starts with no code. (`src/lib/checkoutStorage.js:125-134`)
- A non-empty `?ref=` outside `/booking`, `/payment`, `/payment-success` and `/thank-you` replaces the stored code, so the newest link wins.
  - An empty or missing `?ref` leaves the stored code alone.
  - (`src/lib/checkoutStorage.js:127-134`, `src/next/AppClientRuntime.jsx:10,82`, `src/components/Packages.jsx:107-117`)
- **NOT ENFORCED (ROO-475, fixed by #242):** a code is captured once per document (`src/next/AppClientRuntime.jsx:81-83`).
  - So an in-app navigation to a `?ref=` URL keeps the older code or none.
  - Middleware strips the server query on prebuilt pages (`middleware.js:70-80`), and `src/next/LegacyRoutePage.jsx:20-25` builds the route without it.
- `/booking?ref=X` stores X, unless X is the code the visitor removed in this booking. `/booking?ref=` with a blank value clears the stored code. (`src/components/BookingForm.jsx:487-495,648-663`)
- A booking sends only a referral the server validated in this session.
  - The review step auto-applies `?ref` or the stored code once per package and code.
  - It does that only while a hold is active and no referral is applied. (`src/components/BookingForm.jsx:1921-1990,2377,2405`)
- An invalid code is dropped and remembered as dismissed.
  - A code that can't be checked right now (validation unavailable) is kept for the visitor to retry. (`src/components/BookingForm.jsx:1952-1964`)
- A code the visitor removed stays removed for that booking draft, even when a later link carries the same code. (`src/components/BookingForm.jsx:1775-1788,1936-1940`)
- **NOT ENFORCED (second creator link after a code is applied):** a booking draft restores its applied referral (`src/components/BookingForm.jsx:1229-1272`), and auto-apply skips when one is applied (`:1928`).
  - So creator A's code applied at review, then creator B's link in the same tab, still credits A, even on `/booking?ref=B`.
  - The restore also falls back to the last-used package's draft (`:1245-1247`).
  - Policy call pending: last click or first applied.
- On `/payment` the code comes from `?ref`, then the booking's code, then the stored code, in that order. It is re-validated, and an invalid code is cleared from storage. (`src/components/Payment.jsx:697-700,769-773,791`)
- The server never trusts the client's discount or commission.
  - It resolves the code itself: lowercased slug, creators whose `registrationStatus` isn't `pending_email`.
  - It takes discount and commission from that creator's current percentages. (`src/server/api/ref/pricing.js:227-228,443-463,610-616`)
- **NOT ENFORCED (unknown or unverified code):** when no creator matches, `effectiveReferralCode` falls back to the raw code at 0% commission (`src/server/api/ref/pricing.js:456-457`).
  - Earnings match bookings by referral id or by lowercased code (`src/server/api/ref/payoutUtils.js:87-102`).
  - So bookings made through a creator's link before they verify their email earn them nothing.
  - A creator who later registers that slug sees those bookings at 0 commission.
- **NOT ENFORCED (self-referral):** nothing compares the buyer with the creator, so a creator can book with their own code and earn commission. Policy call pending.
- Commission is frozen on the booking when it's created, and refunds and disputes scale it down (see Refunds and credits). (`src/server/api/ref/createBooking.js:1293-1320,1615-1621`)

### Bookings and holds

- A slot has at most one hold, keyed by its start time, and a held slot is refused to anyone without the hold token. (`src/server/booking/holdSlot.js:241,346-373,433-451`)
- A slot with an active booking lock or a blocking booking can't be held, and this is rechecked after the hold read. (`src/server/booking/holdSlot.js:304-311,318-335`)
- A slot that has already started can't be held. (`src/server/booking/holdSlot.js:337-342`)
- A hold lasts 20 minutes, and starting a payment resets it to 20 minutes from payment start. (`src/server/booking/holdSlot.js:23,344`, `src/server/api/payment/paymentRecord.js:23`, `src/server/api/payment/flow.js:2899,3016-3025`)
- The client can't release, refresh, replace or swap a hold in `payment_pending`. (`src/server/booking/releaseHold.js:67-72`, `src/server/booking/holdSlot.js:132-136,257-266,358-367`)
- Each hold has at most one payment record, and a second start reuses it. (`src/server/api/payment/flow.js:1273,1291-1300,2860-2878`)
- A booking commits only against an active, unexpired hold for the same time, package, payment record and backend. The reschedule path is the one exception. (`src/server/api/ref/bookingCommit.js:59-77,166-169`)
- A booking is recorded at most once per payment:
  - it has a deterministic id and a replay check (`src/server/api/ref/bookingCommit.js:138-146,268-276`);
  - one payment proof can't fund two bookings (`:162-165`);
  - the slot lock and hold consumption commit in one transaction (`:186-215,261-266`).
- A captured payment is never dropped when its booking can't commit. It becomes a "requires reschedule" booking:
  - from the 5-minute reconcile cron (`vercel.json:66`, `src/server/api/payment/flow.js:4779-4789,4892-4917`);
  - from a late capture after abandonment (`:2384-2400`).
  - The reschedule record is built at `:4027-4060`.
- An abandoned or expired payment releases its hold and its coupon reservation. (`src/server/api/payment/flow.js:2634,1781,1687,1746-1752`)
- **NOT ENFORCED (ROO-225, PR #227 parked):** when the hold expires in the booking dialog or on `/payment`, the visitor should stay in the flow with a reason and keep what they typed.
  - Today `src/components/ReservationBanner.jsx:199-201` releases the hold, deletes `booking_draft` (`:234`) and sends them to `/` (`:237`) with no message.

### Dodo payments and webhooks

Sources: Dodo's [webhook guide](https://docs.dodopayments.com/developer-resources/webhooks), [event types](https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide) and [payment statuses](https://docs.dodopayments.com/api-reference/payments/get-payments-1).

Creating a checkout:

- The amount charged is the server quote's `netAmount`, never a client value. A start with a stale quote fingerprint is refused. (`src/server/api/payment/flow.js:2961,3228-3253`, `src/server/api/payment/dodoProvider.js:26-27`)
- A checkout is USD only, with no currency switch, no Dodo discount codes and a locked email. It is idempotent per payment record. (`src/server/api/payment/dodoProvider.js:48-64`, `src/server/api/payment/flow.js:2789-2791`)
- The Dodo product must be one-time and USD, pay-what-you-want, with the recorded tax mode, no PPP, no discount, and a floor no higher than our amount. Otherwise no checkout is made. (`src/server/api/payment/dodoProvider.js:30-38`)
- The checkout URL must be https on the Dodo checkout host for the current mode. (`src/server/api/payment/dodoProvider.js:66-72`)

Validating a payment, on every path (webhook, return page, reconcile):

- `payment_id`, `checkout_session_id`, `metadata.paymentRecordId` and any stored payment id must all match the record. (`src/server/api/payment/dodoProvider.js:86-90`)
- The payment must be in the record's Dodo environment. (`src/server/api/payment/dodoProvider.js:91-93`)
- The currency must be USD and equal to the record's. (`src/server/api/payment/dodoProvider.js:94-95`)
- `total_amount` minus any added tax must equal the quoted `netAmount` in cents, and the tax must be between 0 and the total. (`src/server/api/payment/dodoProvider.js:96-102`)
- A succeeded payment must have exactly one cart line, with quantity 1, for the recorded product. (`src/server/api/payment/dodoProvider.js:103-106`)
- Payment data from the client is never trusted. The return page triggers a server lookup. (`src/server/api/payment/flow.js:1011`, `src/server/api/payment/dodoProvider.js:137-140`)
- **NOT ENFORCED (owner alerts):** a captured payment that fails validation or ends in owner review should reach the owner. Today it ends silently.
  - It becomes `needs_recovery` with `providerRecoveryTerminal`, and reconcile skips it from then on. (`src/server/api/payment/flow.js:4441-4442,4459,4465-4472`)
  - Or the webhook acknowledges a binding mismatch with 200 (`:6141`).
  - The same silent end applies to lost, accepted or expired disputes (`:5883,5936`), upgrade-credit reviews (`:1945-1964`) and refunds with incomplete details (`:5990-5996`).
  - Example: Adaptive Currency is switched on in Dodo and a buyer pays in EUR. That paid customer gets no booking and nobody is told.
- **NOT ENFORCED (rare):** a payment without `metadata.paymentRecordId`, such as one through the product's public buy link, is acknowledged and dropped. (`src/server/api/payment/flow.js:6122`)

Payment statuses:

- `succeeded` finalizes the booking, or takes the reschedule path. (`src/server/api/payment/flow.js:6080-6085`)
- `failed` and `cancelled` end the record and release its resources, unless a booking exists or a dispute is active. (`src/server/api/payment/flow.js:6053-6068`)
- `requires_payment_method` counts as unpaid. Reconcile abandons the record once the session expires. (`src/server/api/payment/dodoProvider.js:129`, `src/server/api/payment/flow.js:4604,5859-5861`)
- `processing`, `requires_customer_action`, `requires_merchant_action`, `requires_confirmation` and `requires_capture` are pending.
  - The webhook answers 503 so Dodo re-delivers. (`src/server/api/payment/flow.js:6145-6147`)
  - A later success after the hold expired takes the reschedule path.
  - ACH Direct Debit stays `processing` for days and gets a 503 on all 8 deliveries. That is harmless.
- `partially_captured` and `partially_captured_and_capturable` are pending too. We never request manual capture.

Refund statuses:

- A `succeeded` refund must match the payment, with a positive amount no larger than the total and the same currency, before it's applied. (`src/server/api/payment/flow.js:5982-6006,6041-6052`)
- `failed`, `pending` and `review` are recorded with no accounting change. Any other status gets a 409, and Dodo retries. (`src/server/api/payment/flow.js:5955-5980`)
- If Dodo says `refund_status: full` but the succeeded refunds don't add up to the total, the webhook answers 503 and waits for the details. (`src/server/api/payment/flow.js:6007-6012`)

Disputes:

- All seven dispute statuses and three stages are validated, and anything else gets a 409. (`src/server/api/payment/flow.js:5870-5876`)
- An open dispute takes the booking to `pending`, zeroes the commission and puts the record in `needs_recovery`. Open means any status except `dispute_won` and `dispute_cancelled`. (`src/server/api/payment/flow.js:5884-5885,5909-5925,5939`)
- `dispute_won` and `dispute_cancelled` restore the booking status, and the commission returns at the retained share. (`src/server/api/payment/flow.js:5916-5921`)
- A disputed payment never finalizes a booking. (`src/server/api/payment/dodoProvider.js:147-149`, `src/server/api/payment/flow.js:6073-6079`)

Webhook delivery:

- Every webhook is verified on its raw body before any processing: a Standard Webhooks signature with 5-minute timestamp tolerance. A failure answers 401, 409 or 503. (`src/server/api/payment/flow.js:6094-6100`, `src/server/api/payment/dodoProvider.js:163-167`)
- A webhook without `webhook-id` is refused. (`src/server/api/payment/flow.js:6101-6102`)
- Payload state is never trusted. The payment is re-read from Dodo by id, so stale or out-of-order events act on the latest state. (`src/server/api/payment/flow.js:6108-6121`)
- Only these event types are processed: `payment.succeeded`, `payment.failed`, `payment.processing`, `payment.cancelled`, `refund.succeeded`, `refund.failed` and `dispute.*`. Every other event gets 200 and is ignored. (`src/server/api/payment/flow.js:6103-6104`)
- Duplicates have no effect:
  - receipts are keyed by `webhook-id` and type, plus a hash of the fetched payment;
  - a repeat with an unchanged state answers 200;
  - a concurrent repeat waits on a 120-second lease and answers 503.
  - (`src/server/api/payment/flow.js:81,1599-1636,6129-6136`)
- A webhook answers 2xx only after its effect is durably recorded, or when it's irrelevant. Otherwise its receipt is released for retry. (`src/server/api/payment/flow.js:6137-6155`)

### Refunds and credits

- A full refund marks the booking refunded and, in one transaction:
  - releases the slot lock it owns;
  - restores the consumed coupon use;
  - decrements the creator's `successfulReferrals`.
  - (`src/server/api/ref/bookingRefunds.js:228-314`)
- Commission counts only `captured` and `completed` bookings, so a fully refunded booking earns none. (`src/server/api/ref/payoutUtils.js:87-93`, `supabase/migrations/20260712092342_close_supabase_port_and_unified_auth.sql:1467`)
- Refund accounting applies once:
  - full refunds through `refundAccountingAppliedAt`;
  - non-Dodo partial refunds through `processedRefundIds`;
  - Dodo partial refunds through a `refundedAmount` that only goes up.
  - (`src/server/api/ref/bookingRefunds.js:154-158,171-186,211-226`)
- A Dodo partial refund scales commission to the retained share, or to 0 while a dispute is active. (`src/server/api/ref/bookingRefunds.js:154-168`, `supabase/migrations/20260909090000_add_dodo_payment_provider.sql:25-30`)
- **NOT ENFORCED:** commission should never exceed the commission on the money we kept.
  - A PayPal or Razorpay partial refund records `refundedAmount` but keeps the full `commissionAmount` (`src/server/api/ref/bookingRefunds.js:187-201`).
  - Example: a $20 refund on a $54.95 PayPal booking leaves the creator the full commission.
- **NOT ENFORCED:** `successfulReferrals` should count only bookings we kept.
  - A lost chargeback zeroes commission (`src/server/api/payment/flow.js:5909-5925`) but never decrements the count. Only a full refund does (`src/server/api/ref/bookingRefunds.js:298-302`).
  - The count unlocks split editing at 5 (`src/server/api/ref/updateSplit.js:71-73`).
- A coupon's uses never exceed `maxUses`, counting consumed uses plus active reservations. This is checked at reservation and at consumption, under revision guards. (`src/server/api/ref/couponReservations.js:83-88,119-131,193-199`)
- A coupon reservation belongs to one payment record. A late capture after the reservation was released is still accounted for. (`src/server/api/ref/bookingCommit.js:170-173`, `src/server/api/payment/flow.js:4055-4056`)
- Upgrade credit counts only paid bookings in the chain, minus settled refunds. A fully refunded original gives no credit, and a non-USD original or a provider mismatch refuses credit. (`src/server/api/ref/pricing.js:144-177,255-264,289-300`)
- If the credit dropped after the quote, a captured upgrade is held for owner review instead of booked. (`src/server/api/ref/pricing.js:346-370`, `src/server/api/payment/flow.js:1936-1965,3933-3942`)
- Each original order has at most one upgrade at a time (the upgrade lock), and the lock is released on refund. (`src/server/api/payment/flow.js:2872-2878,3007`, `src/server/api/ref/bookingRefunds.js:47-60,315-318`)

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

- `git status` shows only the files the change needs. Delete scratch files instead of renaming or parking them.
- Every new script runs from a clean checkout without machine-specific paths; fixture locations come from environment variables with documented defaults.
- Branch names use the `servi/` prefix with a short description, for example `servi/review-carousel-loop`.

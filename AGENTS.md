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

- Small PRs, one fix each. Two fixes are two PRs.
- Run the affected suites locally, then push once per round. Every push restarts CI.
- Tests talk only to local fixtures: `scripts/test-tooling-sweep-server.mjs` refuses env files and outbound requests outside its allowed local fixture origins. Never point a test or script at production.

## Invariants

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
   - `npm run test:referral-payment`: browser booking, synthetic Dodo checkout, a signed webhook through the running Next `app/api/payment/webhook/dodo/route.js`, the confirmed booking and the creator's credit, with native Postgres. Both event orders and duplicate delivery must credit once. Provider responses are synthetic, and browser financial calls use a separate Next listener; this does not test live Dodo or hosted RLS. (`tests/referral-payment.spec.js:80-196`, `tests/fixtures/referral-payment.mjs`)
7. Gets a Sol review briefed with the diff, these invariants and the entry points, and asks it to break each one (up to 5 rounds).
8. Gets a read-only production smoke after deploy.
9. Gives every bug found a one-line root cause and a new invariant line or regression E2E.

### Referral attribution

- Per-tab referral intent is stored in `sessionStorage["referral_dismissed"]`: the passive code, each code's `available`/`applied`/`removed` state and the explicit choice for a checkout scope. A scope is the package title plus the original order ID. `referral_session` is a compatibility mirror; it cannot replace a newer journal choice. There is no visitor attribution cookie; `REF_SESSION_COOKIE` signs creators into their portal. (`src/lib/checkoutStorage.js:217-260,450-466`, `src/server/api/ref/auth.js:5,124-158`)
  - The booking draft and checkout state also carry applied-code candidates. Candidates still need validation. Analytics keeps a separate journey snapshot, so its creator code can differ from the applied referral. (`src/components/BookingForm.jsx:1249-1282,1313-1325,2459-2521`, `src/components/Payment.jsx:756-890`, `src/lib/salesAttribution.ts:53-74`)
  - A same-origin tab or window opened with its opener kept initially copies the opener's session storage. A new one using `noopener` starts empty; a restored session keeps its own. ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage))
- The shared coordinator captures a fresh actual address before a checkout reads its referral and notifies mounted checkout readers after capture state changes. Booking reads URL referral intent only through this coordinator; a historical raw query is not a separate candidate. Public navigation can capture a new nonempty `?ref=`; a missing or blank value on a public page leaves intent alone. Repeating the same address, reload and history restoration do not replay an older link. Fresh `/booking?ref=X` can capture X; `/payment` query values are candidates, not a fresh capture. Runtime navigation, package clicks, Booking and Payment use the same coordinator. (`src/lib/checkoutStorage.js:316-383,521-527`, `src/next/AppClientRuntime.jsx:72-82,107-111`, `src/components/BookingForm.jsx:2459,2544`, `src/components/Payment.jsx:756-764`)
  - Fresh `/booking?ref=` clears only the passive code. `/booking` without a query leaves an unrelated passive code alone. An existing undismissed scoped choice can still take precedence. (`src/lib/checkoutStorage.js:348-357,450-466`)
  - Removing A records A as removed without removing B. Another link for A does not undo that removal; explicit, validated manual application of A does. Removing A, applying B and removing B therefore leaves both removed until explicitly reapplied. (`src/lib/checkoutStorage.js:268-314,387-422`)
- Selection uses an undismissed scoped choice first. If that choice is dismissed, selection may fall back to the passive code; otherwise it checks the supplied candidates and then the passive code. A supplied candidate that is not in the journal stays selectable when recording it as available fails, so automatic application can surface the storage error. Booking and Payment revalidate before applying a discount. Invalid matching intent is cleared; a failed clear stays in storage and surfaces the storage error instead of looking removed. Unavailable validation keeps the input for retry. An empty Apply removes only the displayed or matching pending unavailable code, preserving a newer different choice. (`src/lib/checkoutStorage.js:284-291,450-466,468-489`, `src/components/BookingForm.jsx:1823-2098`, `src/components/Payment.jsx:756-890,1638-1801`)
- While a payment session is locked, Payment displays its saved quote and fingerprint codes. New links do not reprice it. If its saved price is unavailable, it keeps the session and offers status or payment-method recovery without showing a replacement total. An existing checkout can resume from its stored session while a fresh quote is unavailable; a new checkout still needs a confirmed quote. An unlocked checkout can retry its price after session release or a closed banner; price retry keeps unrelated recovery guidance. Failed status checks or missing checkout details keep the saved session for recovery without reopening checkout. PayPal keeps intentional terminal status guidance after the SDK rejects checkout. (`src/components/Payment.jsx:504-540,1265-1347,2022-2076,2113-2244,2498-2509`) A delayed start whose checkout storage cannot be read keeps the returned session when the in-memory checkout still matches. A delayed paid start for the same checkout keeps its original claim for explicit recovery without opening it. The older quote stays with that reserved session; its late response does not replace the current quote. Updated code candidates survive reload and Payment's Change payment method, then are revalidated before a replacement starts. Removing a coupon clears it on the checkout, so a later pre-apply does not put that code back, and keeps a stored slot hold whose id or token differs from the checkout in navigation. Changing payment method writes a refreshed hold into navigation as well as storage. (`src/components/Payment.jsx:282-297,771-902,991-1028,1158-1197,1379-1506,2275-2282`)
- An active restored hold keeps its scoped choice. A fresh hold initializes the current scope even when the separate release request failed but the server swap succeeded. A valid stored hold is restored in memory before its normalized rewrite, so a failed rewrite does not look like a missing hold or clear the draft. If its reset cannot be stored, Booking retains data and manual controls, refuses automatic restoration and permits an empty-referral checkout. That refusal also reaches Payment and reload; it cannot silently revive the retained old choice. (`src/components/BookingForm.jsx:751-778,811-819,1803-1823,2391-2403`, `src/lib/checkoutStorage.js:159-215,491-504`
- A capture writes a pending refusal before changing the journal and becomes ready only after confirmed acknowledgement. A mirror-only legacy tab normalizes its code and writes a journal before marking capture ready. Missing guards on existing journals, pending or malformed guards, denied storage and failed writes refuse automatic fallback while retaining the data. A blank or unknown failure, or a failed reset with recorded scopes, also blocks fresh public and `/booking` captures until validated manual recovery. A qualified fresh B can replace a pending A; a removed B keeps A pending and cannot revive an older passive code. If the failed reset's origin is unknown and another scope has a stored choice, manual application refuses before writing the journal and keeps the data. Manual recovery then requires that no other scope has a stored choice; two or more stored scopes prevent it in that tab. Known failed-reset scopes are cleared in the same write as the validated manual choice. The existing `SecurityError` exception permits that manual choice only in the current document, without promising persistence across reload. (`src/lib/checkoutStorage.js:159-215,331-363,404-427`, `src/components/BookingForm.jsx:1693-1713,1738-1769`)
- A genuine cached-page restore compares guard, journal and mirror. Changed or unreadable storage invalidates obsolete manual continuations and reruns eligible restoration. An unready Booking scope keeps its own draft candidates until the scope is active and ready. Unchanged healthy intent preserves the current form, hold and quote. (`src/lib/checkoutStorage.js:141-151,507-520`, `src/components/BookingForm.jsx:1755-1762,1803-1823`, `src/components/Payment.jsx:659-670,1655-1657,1738-1740`)
- **NOT ENFORCED (second creator link after a code is applied):** an active hold's undismissed scoped choice A still takes precedence after a later passive link for B, including `/booking?ref=B`. Draft restoration can also use the last-used package's candidates, subject to the journal's selection rules. Policy call pending (ROO-510): last click or first applied. (`src/lib/checkoutStorage.js:450-466`, `src/components/BookingForm.jsx:751-758,1249-1282`)
- The server never trusts the client's discount or commission.
  - It resolves the code itself: lowercased slug, creators whose `registrationStatus` isn't `pending_email`.
  - It takes discount and commission from that creator's current percentages. (`src/server/api/ref/pricing.js:227-228,443-463,610-616`)
- **NOT ENFORCED (unknown or unverified code):** when no creator matches, `effectiveReferralCode` keeps the raw code at 0% commission (`src/server/api/ref/pricing.js:456-457`). Earnings match bookings by referral id or by lowercased code (`src/server/api/ref/payoutUtils.js:87-102`).
  - The normal checkout validates codes first and drops unknown ones (`src/server/api/ref/validateReferral.js:93-107`, `src/components/Payment.jsx:787-799`). A raw API request can still store one.
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
- Refund-aware upgrade credit counts only paid bookings in the chain, minus settled refunds. A fully refunded original gives no credit. Entries with settled refund state are checked for currency, provider and binding; a non-USD currency or provider mismatch refuses credit on that path. (`src/server/api/ref/pricing.js:152-177,255-264,289-300`)
  - **NOT ENFORCED (ROO-518):** when nothing was refunded, credit returns the booking's paid amount before the currency, provider and binding checks run. (`src/server/api/ref/pricing.js:144-151`)
- If the credit dropped after the quote, a captured upgrade is held for owner review instead of booked. (`src/server/api/ref/pricing.js:346-370`, `src/server/api/payment/flow.js:1936-1965,3933-3942`)
- An upgrade lock covers one payment per original booking, target package and upgrade intent. It is released on a full refund. (`src/server/api/payment/flow.js:2872-2878,3007`, `src/server/api/ref/bookingRefunds.js:47-60,315-318`)
  - **NOT ENFORCED (ROO-519):** each upgrade request gets a new random intent (`src/server/api/ref/getUpgradeInfo.js:310-317`, `src/server/api/ref/upgradeIntentToken.js:43,114`). So two upgrades for the same original booking can run at once and both draw its credit.

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

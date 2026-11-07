# Moving rooindustries.com from Vercel to Cloudflare

The site stays on Vercel while the Vercel for Startups application is pending. This plan moves it to Cloudflare
Workers in steps, starting with downloads, so each step can be proven and undone on its own.

## What runs where today

- Vercel: the Next.js 15.5 app (29 pages, 33 route handlers, `middleware.js`), 11 prebuilt pages revalidated every
  60 seconds, API functions pinned to `dub1` next to Supabase, two crons (`/api/payment/reconcile` every 5 minutes,
  `/api/ref/cronSyncAll` every 10), the apex to `www` redirect, preview deployments, Vercel Analytics and Speed
  Insights, the post-deploy smoke and automatic rollback through the Vercel API.
- Vercel Blob: the Optimization Suite installers and its signed update feed, and optionally the paid builds behind
  `/downloads/<slug>`.
- Supabase Storage: the hosted Tools page installers, served through `/api/tools/<id>/download`.
- Unchanged by this plan: Supabase (database, auth, storage for CMS content), Dodo, PayPal and Razorpay, Resend.

## What moves, in order

1. **Public downloads on R2** (this PR, live). `roo-downloads.rooindustries.workers.dev` serves the Tools page
   installers and the Suite installer from the `roo-downloads` R2 bucket, with resumable ranges, caching headers and
   a health route. Every file verifies byte for byte through it.
2. **The Tools page on the Worker.** Turn on `TOOL_DOWNLOADS_ORIGIN` in a preview deployment, click every hosted
   tool, then in production. Done when the switch has run a week in production without errors.
3. **Suite update feed and installers to R2.** The release script uploads to R2 instead of Vercel Blob. The feed URL
   is compiled into the app, so a release that reads the new feed ships first and the old feed stays up until
   testers have moved to it.
4. **Paid builds to a private R2 bucket.** `/downloads/<slug>` keeps checking the order, then redirects to a
   short-lived presigned R2 URL instead of a Blob or Supabase signed URL.
5. **The site on Workers** with the OpenNext Cloudflare adapter: pages, route handlers and middleware run in one
   Worker, static files from Workers static assets, the 60-second revalidation through OpenNext's R2 incremental
   cache and its tag cache. Smart Placement keeps API calls close to Supabase.
6. **Crons to Cron Triggers** calling the same handlers with the same cron secret. Only one platform runs the
   crons at any time, so they are switched in the same change that moves traffic.
7. **Platform pieces:** Cloudflare Web Analytics instead of Vercel Analytics and Speed Insights; Sentry gated on a
   new production marker instead of `VERCEL` and `VERCEL_ENV`; the deploy gate and rollback rewritten on Worker
   versions and `wrangler rollback`; the CMS image processing that uses `sharp` moved to the Images binding.
8. **DNS last.** Import the rooindustries.com zone into Cloudflare with every record copied exactly (mail records
   included), lower TTLs, then attach `www` and the apex to the Worker. Vercel stays deployed until the move has
   held for two weeks.

## Risks

- **Workers Free limits.** 10 ms of CPU per request fits the downloads Worker, which only streams bytes, but not
  server rendering for the whole site. Step 5 needs Workers Paid.
- **Node-only code.** Route handlers run on Node today. `nodejs_compat` covers most of it, but not native modules
  (`sharp`) or the local file download backend, which is development only.
- **Money paths.** Bookings, holds, the Dodo webhook (raw-body signature check), the 5-minute reconcile and
  referral credit must behave exactly the same. Two platforms running crons at once could double-process
  payments.
- **Revalidation.** A CMS publish must still reach the public page within a minute through OpenNext's caches.
- **Latency to Supabase.** Vercel pins API functions next to the database; Workers run near the visitor, so
  routes that make several database calls need Smart Placement or Hyperdrive.
- **Monitoring and rollback.** Sentry, the production smoke and the automatic rollback all read Vercel markers or
  the Vercel API today and must be rebuilt before cutover, not after.
- **DNS.** A missed record can break email or verification for other services. Copy, compare, then switch.

## How we test each step

- Downloads: `npm run verify` in `workers/downloads` against the live Worker for every file (size, SHA-256 and a
  byte range) after each deploy and upload, and the Tools page clicked through with the switch on in a preview
  deployment.
- Site build: every CI suite (Jest, Playwright, Postgres 17, booking flow, payment persistence sweep, SEO and
  monitoring checks) runs against the OpenNext build in workerd, not just against `next start`.
- Staging on workers.dev with Dodo in test mode: a full booking through checkout, the signed webhook and the
  confirmed booking with creator credit; a CMS publish through to the public page; both crons on a staging
  database.
- Parity: every route in `src/lib/routes.js`, the Markdown variants, `sitemap.xml`, `robots.txt` and `llms.txt`
  compared between Vercel and staging for status, headers and body.
- Cutover: the read-only production smoke against the new origin, then a rollback drill that points DNS back at
  Vercel before the first real traffic moves.

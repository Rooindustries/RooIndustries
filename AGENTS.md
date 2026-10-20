# Roo Industries

rooindustries.com sells remote PC game optimization to competitive players and streamers who want more FPS, lower input lag, cleaner frametimes and stable performance in the games they play. Customers compare the Performance Vertex packages, book a session slot, pay, and get their PC tuned remotely. The site also carries free tools and the BIOS guide, before and after benchmarks, reviews, a referral program for creators, and a CMS the team edits.

## What we can never break

1. **Bookings.** A customer picks a slot, `/api/holdSlot` holds it while they fill in their details and pay, and their booking is recorded once. Never lose a held slot, typed details or a paid booking.
2. **Dodo checkout.** Payments run through Dodo Payments (`src/server/api/payment/`, webhook at `app/api/payment/webhook/dodo`); the PayPal and Razorpay paths still exist. Prove payment changes against fixtures or test mode, never production.
3. **The creator portal.** Creators register, verify, sign in and track their referrals, commission and payouts under `/referrals/*`. Their links and codes must keep crediting them.
4. **Speed.** Public pages are prebuilt and served from the CDN (`force-static`, `revalidate = 60`; `middleware.js` handles queries and Markdown). Don't turn a prebuilt page back into a per-request render, and don't add weight before the first paint.
5. **SEO.** Indexable pages are listed in `src/lib/routes.js`, which builds `sitemap.xml`; their titles, descriptions and canonicals come from `src/lib/seo.js`, and `public/llms.txt` guides agents. `/`, `/about`, `/contact` and `/privacy` also answer in Markdown. Keep that metadata and the server-rendered content intact.

## Hit every surface

A change is done when it works everywhere its behavior reaches. Say which of these applied:

- **Screens.** Phones (360 and 390 px wide) and desktop.
- **Pages.** Every route in `src/lib/routes.js`, plus `/upgrade/[slug]`, `/downloads/[slug]` and `/admin/*`.
- **Flows.** Packages, the booking dialog, `/payment`, then `/payment-success` or `/thank-you`; a `?ref=` link through to a paid booking; an admin publish through to the public page after revalidation.
- **APIs and webhooks.** Everything under `app/api/`, including the payment provider webhooks.
- **Formats.** The HTML page, its Markdown variant where one exists, `sitemap.xml`, `robots.txt` and `llms.txt`.
- **Emails.** Booking emails (`src/server/api/ref/`) and creator account emails (`src/server/email/`).
- **Tests.** CI runs Jest, the Playwright suites and the Postgres 17 suites (`.github/workflows/tests.yml`). Run the ones your change touches locally first.

## How we ship

- Small PRs, one fix each. Two fixes are two PRs.
- Run the affected suites locally, then push once per round. Every push restarts CI.
- Tests talk only to local fixtures: `scripts/test-tooling-sweep-server.mjs` refuses env files and outbound requests outside its two local origins. Never point a test or script at production.

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

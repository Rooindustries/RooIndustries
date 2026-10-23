# Roo Industries

## Error source maps

Set `SENTRY_AUTH_TOKEN` in the private Vercel production build environment to upload source maps to the `rooindustries-website` project in Sentry. Uploads require `VERCEL=1`, `VERCEL_ENV=production` and the token together. Local, CI, development and preview builds keep uploads off even when a token is present. Uploaded browser maps are deleted before deployment; server maps remain available to the runtime. Never expose the token through a `NEXT_PUBLIC_` variable or commit it. CLI telemetry is disabled for these builds.

If the production token is missing or an upload fails, the build warns and continues so a Sentry outage cannot block deployment. Check that warning before relying on source maps for the new build. Ordinary local builds stay quiet.

`npm run test:sourcemaps` runs on Linux with `unzip`, `cc` and `bwrap`. It checks the deployment gates, uploaded maps for the main and shared browser files, their matching debug IDs and original source, private map cleanup and refused uploads. It also starts a real production build without a token to check its warning, homepage and unavailable public maps. Env files are refused; the local-origin guard and an inherited native audit block outbound traffic and fail the check on any nonlocal attempt. It uses no real credentials. Reports, network audits and uploaded archives are saved under `test-results/sourcemaps-e2e/`.

## Browser checks

CI uses the official Playwright 1.58.2 Noble image for browser, API-route and revalidation jobs, matching `package-lock.json`. Browser system libraries and binaries are already installed; these jobs do not download Ubuntu packages. Update the image and its version check together when upgrading Playwright.

Each Playwright invocation stops gracefully after 20 minutes, with a 22-minute emergency limit for shutdown. API routes, creator portal, benchmarks revalidation and static revalidation each have their own 30-minute job, so a stalled group cannot consume the next group's time. Ordinary tests have two minutes; existing slower cases keep their own finite limits, and each navigation matrix has ten minutes with its repeat counts unchanged. CI keeps one retry for diagnostics and fails flaky results, including a timed-out first attempt whose retry passes. CI logs each test by name and keeps failed traces and JSON results in `test-results/`, uploaded even when a group fails. `npm run test:playwright:timeouts` checks per-test expiry, retry recovery and consecutive group expiry against deliberately hung local browser actions, using shorter deadlines derived from the real config and workflow; its report is `test-results/playwright-timeouts.json`.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

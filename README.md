# Roo Industries

## Error source maps

Set `SENTRY_AUTH_TOKEN` in the private Vercel production build environment to upload source maps to the `rooindustries-website` project in Sentry. Uploads require `VERCEL=1`, `VERCEL_ENV=production` and the token together. Local, CI, development and preview builds keep uploads off even when a token is present. Uploaded browser maps are deleted before deployment; server maps remain available to the runtime. Never expose the token through a `NEXT_PUBLIC_` variable or commit it. CLI telemetry is disabled for these builds.

If the production token is missing or an upload fails, the build warns and continues so a Sentry outage cannot block deployment. Check that warning before relying on source maps for the new build. Ordinary local builds stay quiet.

`npm run test:sourcemaps` runs on Linux with `unzip`, `cc` and `bwrap`. It checks the deployment gates, uploaded maps for the main and shared browser files, their matching debug IDs and original source, private map cleanup and refused uploads. It also starts a real production build without a token to check its warning, homepage and unavailable public maps. Env files are refused; the local-origin guard and an inherited native audit block outbound traffic and fail the check on any nonlocal attempt. It uses no real credentials. Reports, network audits and uploaded archives are saved under `test-results/sourcemaps-e2e/`.

## Error reporting

Sentry reports only from production deployments: `VERCEL=1`, `VERCEL_ENV=production` and `NODE_ENV=production` must all be set, with a valid `NEXT_PUBLIC_SENTRY_DSN`. Local runs, CI and Vercel previews stay silent even when they have a valid DSN. There is no local opt-in.

The server checks the deployment when it starts reporting or handles a browser envelope. The browser uses `NEXT_PUBLIC_ROO_SENTRY_ENABLED`, which `next.config.mjs` derives from those same deployment checks. Setting that public variable yourself cannot enable reporting. Rebuild when changing deployment environments; [Next.js freezes public variables at build time](https://nextjs.org/docs/app/guides/environment-variables). [Vercel supplies its deployment markers at build and runtime](https://vercel.com/docs/environment-variables/system-environment-variables).

Run `npm run test:monitoring:deployments` on Linux with Node 24, `unshare` (util-linux), `ip` (iproute2), a C compiler and Playwright Chromium installed. It builds a disposable copy of the website, uses local Sentry and Supabase stand-ins, and writes its report, browser traces and screenshots under `test-results/monitoring-deployments/`. Its network namespace and connection audit keep traffic local; the Sentry CLI has telemetry disabled. `npm run test:monitoring` checks the reporting and privacy behavior within an explicitly production-flagged local fixture. `npm run test:monitoring:startup` checks that a malformed DSN leaves a production-flagged build and server available, with its reporting endpoint disabled. Its tooling-server production setting accepts only the literal malformed DSN `false`.

The host must allow unprivileged user and network namespaces. On GitHub-hosted Ubuntu runners, the monitoring job loads an AppArmor profile permitting user namespaces only for `/usr/bin/unshare`, without changing the system-wide restriction. Self-hosted runners keep their existing security settings.

## Product analytics

PostHog (US Cloud) records pageviews and every event sent through `trackEvent`, which covers the booking funnel: `view_item`, `package_selected`, `checkout_started` and `booking_completed`. It loads after the page is idle, and only on `www.rooindustries.com` production builds, the same check Vercel Analytics uses. It starts on the first page in a tab that has a sales journey (the home page, packages, booking, payment and the other sales pages), including after in-app navigation from any other page. Local runs, CI and Vercel previews send nothing.

| Variable | Default | Use |
| --- | --- | --- |
| `NEXT_PUBLIC_POSTHOG_KEY` | `phc_AqgCN7TfCu5fVECnkPCVjWAStC3grX4MmA3AmKXWu9qe` | Public project key, sent by the browser. |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://us.i.posthog.com` | Where `/ingest` forwards events. `/ingest/static` and `/ingest/array` go to the matching `-assets` host. |

The browser sends everything to `/ingest` on the site's own origin, and `next.config.mjs` forwards it to PostHog. Next.js normally removes trailing slashes with a redirect, and PostHog's endpoints end in one, so the config turns that redirect off and adds the same redirect back for every path outside `/ingest/`. Both variables are read at build time, so rebuild after changing them.

There is no consent banner yet, so PostHog keeps its state in memory and sets no cookies or storage. The visitor id is the existing per-tab sales journey id, which already lives in `sessionStorage`. A confirmed booking identifies the visitor by the booking's internal receipt id (`event_id`). URLs are cut down to the page path, pages outside the public list (admin, creator portal, sign-in) send nothing, and autocapture is off. Session replay, when it is turned on in PostHog, masks every input and all page text and drops request and response headers and bodies. Names, emails and other customer details are never sent.

`npx playwright test tests/posthog-analytics.spec.js --project=chromium` runs the funnel on a local build served as `www.rooindustries.com` and checks every PostHog request, the replay masking and the trailing slash redirects. Nothing leaves the machine.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

# Roo Industries

## Error source maps

Set `SENTRY_AUTH_TOKEN` in the private Vercel production build environment to upload source maps to the `rooindustries-website` project in Sentry. Uploads require `VERCEL=1`, `VERCEL_ENV=production` and the token together. Local, CI, development and preview builds keep uploads off even when a token is present. Uploaded browser maps are deleted before deployment; server maps remain available to the runtime. Never expose the token through a `NEXT_PUBLIC_` variable or commit it. CLI telemetry is disabled for these builds.

If the production token is missing or an upload fails, the build warns and continues so a Sentry outage cannot block deployment. Check that warning before relying on source maps for the new build. Ordinary local builds stay quiet.

`npm run test:sourcemaps` runs on Linux with `unzip`, `cc` and `bwrap`. It checks the deployment gates, uploaded maps for the main and shared browser files, their matching debug IDs and original source, private map cleanup and refused uploads. It also starts a real production build without a token to check its warning, homepage and unavailable public maps. Env files are refused; the local-origin guard and an inherited native audit block outbound traffic and fail the check on any nonlocal attempt. It uses no real credentials. Reports, network audits and uploaded archives are saved under `test-results/sourcemaps-e2e/`.

## Error reporting

Sentry reports only from production deployments: `VERCEL=1`, `VERCEL_ENV=production` and `NODE_ENV=production` must all be set, with a valid `NEXT_PUBLIC_SENTRY_DSN`. Local runs, CI and Vercel previews stay silent even when they have a valid DSN. There is no local opt-in.

The server checks the deployment when it starts reporting or handles a browser envelope. The browser uses `NEXT_PUBLIC_ROO_SENTRY_ENABLED`, which `next.config.mjs` derives from those same deployment checks. Setting that public variable yourself cannot enable reporting. Rebuild when changing deployment environments; [Next.js freezes public variables at build time](https://nextjs.org/docs/app/guides/environment-variables). [Vercel supplies its deployment markers at build and runtime](https://vercel.com/docs/environment-variables/system-environment-variables).

Run `npm run test:monitoring:deployments` on Linux with Node 24, `unshare` (util-linux), `ip` (iproute2), a C compiler and Playwright Chromium installed. It builds a disposable copy of the website, uses local Sentry and Supabase stand-ins, and writes its report, browser traces and screenshots under `test-results/monitoring-deployments/`. Its network namespace and connection audit keep traffic local; the Sentry CLI has telemetry disabled. `npm run test:monitoring` checks the reporting and privacy behavior within an explicitly production-flagged local fixture.

The host must allow unprivileged user and network namespaces. On GitHub-hosted Ubuntu runners, the monitoring job loads an AppArmor profile permitting user namespaces only for `/usr/bin/unshare`, without changing the system-wide restriction. Self-hosted runners keep their existing security settings.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

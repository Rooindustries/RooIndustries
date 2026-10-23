# Roo Industries

## Error source maps

Set `SENTRY_AUTH_TOKEN` in the private Vercel production build environment to upload source maps to the `rooindustries-website` project in Sentry. Uploads require `VERCEL=1`, `VERCEL_ENV=production` and the token together. Local, CI, development and preview builds keep uploads off even when a token is present. Uploaded browser maps are deleted before deployment; server maps remain available to the runtime. Never expose the token through a `NEXT_PUBLIC_` variable or commit it. CLI telemetry is disabled for these builds.

If the production token is missing or an upload fails, the build warns and continues so a Sentry outage cannot block deployment. Check that warning before relying on source maps for the new build. Ordinary local builds stay quiet.

`npm run test:sourcemaps` runs on Linux with `unzip`, `cc` and `bwrap`. It checks the deployment gates, uploaded maps for the main and shared browser files, their matching debug IDs and original source, private map cleanup and refused uploads. It also starts a real production build without a token to check its warning, homepage and unavailable public maps. Env files are refused; the local-origin guard and an inherited native audit block outbound traffic and fail the check on any nonlocal attempt. It uses no real credentials. Reports, network audits and uploaded archives are saved under `test-results/sourcemaps-e2e/`.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

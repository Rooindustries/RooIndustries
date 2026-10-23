# Roo Industries

## Error source maps

Set `SENTRY_AUTH_TOKEN` in the private Vercel build environment to upload source maps to the `rooindustries-website` project in Sentry. Builds without that token keep uploads disabled. Uploaded browser maps are deleted before deployment; server maps remain available to the runtime. Never expose the token through a `NEXT_PUBLIC_` variable or commit it.

If an upload fails, the build warns and continues so a Sentry outage cannot block deployment. Check that warning before relying on source maps for the new build.

`npm run test:sourcemaps` requires `unzip` and checks the real build configuration against a local upload fixture. It inspects uploaded maps for the main and shared browser files, their matching debug IDs and original source, along with private map cleanup and refused uploads. It uses no real credentials. Reports and uploaded archives are saved under `test-results/sourcemaps-e2e/`.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

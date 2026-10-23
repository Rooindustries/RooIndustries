# Roo Industries

## Error source maps

Set `SENTRY_AUTH_TOKEN` in the private Vercel build environment to upload source maps to the `rooindustries-website` project in Sentry. Builds without that token keep uploads disabled. Uploaded browser maps are deleted before deployment; server maps remain available to the runtime. Never expose the token through a `NEXT_PUBLIC_` variable or commit it.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

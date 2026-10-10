# Local route tests

Run `npm run test:api:routes` to start the guarded Next.js server and run the
HTTP and browser route checks with synthetic data. On a shared Linux desktop,
use `xvfb-run -a npm run test:api:routes` for the headed browser checks.

`ROO_TEST_HOST` defaults to `127.0.0.1`, `PW_PORT` to `4173`, and
`TOOLING_CONTENT_PORT` to the app port plus one. Set `PW_SERVER_ID` or
`NEXT_DIST_DIR` to choose an isolated build directory. The server refuses env
files and outbound requests outside the two local origins. API fixture writes
are enabled only by `TOOLING_API_ROUTES=1`, which the package script sets.
The default content fixture remains read only.

With an existing guarded fixture server, set `BASE_URL` to its app origin.
`TOOLING_DEV_SERVER=1` selects hot reload when starting the fixture server;
omit it for the production build and server. Production builds require a fresh
directory when their source fingerprint changes. Generated HTTP attachments,
screenshots, traces, and logs belong under `test-results/`.

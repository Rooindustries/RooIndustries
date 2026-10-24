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
Keep real Sentry DSNs unset in the fixture server and browser process.

`npm run test:account-domain:postgres17` checks the account fixture against native
PostgreSQL 17, including startup with an occupied loopback port and the complete
normal account identity run. Set `PG_BIN` or provide `pg_config` on `PATH`.
The fixture keeps native server output and init/start/stop command output under
`test-results/account-domain-postgres/run-*/`, outside its temporary cluster.
`ROO_ACCOUNT_DOMAIN_ARTIFACT_DIR` changes that artifact parent directory, and
`ROO_TEST_POSTGRES_PORT` selects an explicit test port. Startup failures remain
failures and print the native server log before owned-cluster cleanup.
The CLI E2E retains both invocations under `test-results/account-domain-startup/`;
`ROO_ACCOUNT_DOMAIN_STARTUP_ARTIFACT_DIR` changes that artifact parent directory.
The native CI job uploads `test-results/` even when the fixture fails.
Client-close failures still stop the owned server and remove its cluster.
Stop failures retain the cluster; close, stop and removal errors remain visible
together. Cleanup E2Es inject a rejection after the real client closes, a failing
stop command, and a removal permission error on the owned temporary directory.
Both E2E teardown paths share cleanup that retains each stop log before checking
its result, attempts every cluster and checks every known postmaster PID. Failed
stops retain the temporary root and all errors, including an earlier assertion.
Native cases cover a rejected stop and a command that reports success while its
server remains alive; a second cluster must still stop in both cases.

`npm run test:remote-browser-guard` exercises connected and native browsers with
local HTTP fixtures. Native runs keep the Node and browser guards active together.
Chromium receives local-network permission only for the allowed fixture origins,
so direct streaming responses can expose their headers while their bodies stall.
Caller HTTP agents are replaced with the default transport after the destination
check. Zero-hop API responses remain available for redirect validation; ordinary
HTTP redirects and browser endpoint redirects remain refused.
Browser requests are fetched with automatic redirects off.
GET page redirects are checked and started as fresh guarded navigations, with
at most 20 hops. Fetches, image requests and POST forms refuse redirects
instead of replaying requests. Forbidden targets, credentials, malformed
locations and redirect loops are recorded before refusal. Allowed navigation
chains retain their final URL, response, load wait and Back/Forward history.
Every hop and final load wait share the original navigation deadline, including
page/context defaults. Explicit zero and inherited unlimited timeouts remain
unlimited. Real timeout and cancellation failures still reject the navigation.
The browser E2Es also check ordinary POST bodies, server failures and images.
Response cleanup cannot replace an earlier redirect refusal. A local WebSocket
relay injects disposal failures after the real server command completes, checking
the original refusal, cleanup-only errors and the unchanged successful result.
An initial popup request can arrive before its frame exists. Its ordinary
response stays guarded; a redirect without a frame is recorded and refused.

`npm run test:booking:holds` starts the real hold handler and request adapter over
HTTP, using the same content fixture and a clock mock confined to that test
process. It owns both servers and stops them on completion. `BOOKING_ROUTE_PORT`
defaults to `PW_PORT` or `4173`; the content port defaults to that port plus one.
`BOOKING_HOLDS_ARTIFACT` defaults to
`test-results/api-routes/booking-holds.jsonl`.

`npm run test:api:preview` checks the read-only middleware against Next.js. When
using `BASE_URL`, start that server with `TOOLING_API_ROUTES=0`.

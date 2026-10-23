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

With that server running, `BASE_URL=http://127.0.0.1:<port> npm run
test:nav:sections:repeat` runs the complete section-navigation suite five times
with one worker and no retries. Commit changes first: the command records the
commit and preserves each run's report, timings and console logs separately
under `test-results/section-nav-consecutive/`. It stops at the first failure.
Each round must produce all three fresh audit files, even when the browser
command exits successfully. `npm run test:tooling:dependencies` also exercises
interrupted, missing-evidence and complete rounds through isolated CLI fixtures.
Keep real Sentry DSNs unset in both the fixture server and browser process.

`npm run test:remote-browser-guard` exercises the real browser connection and
local HTTP fixtures. Browser requests are fetched with automatic redirects off.
GET page redirects are checked and started as fresh guarded navigations, with
at most 20 hops. Fetches, image requests and POST forms refuse redirects
instead of replaying requests. Forbidden targets, credentials, malformed
locations and redirect loops are recorded before refusal. Allowed navigation
chains retain their final URL, response, load wait and Back/Forward history;
the browser E2Es also check ordinary POST bodies, server failures and images.

`npm run test:booking:holds` starts the real hold handler and request adapter over
HTTP, using the same content fixture and a clock mock confined to that test
process. It owns both servers and stops them on completion. `BOOKING_ROUTE_PORT`
defaults to `PW_PORT` or `4173`; the content port defaults to that port plus one.
`BOOKING_HOLDS_ARTIFACT` defaults to
`test-results/api-routes/booking-holds.jsonl`.

`npm run test:api:preview` checks the read-only middleware against Next.js. When
using `BASE_URL`, start that server with `TOOLING_API_ROUTES=0`.

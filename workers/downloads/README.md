# Roo Industries downloads Worker

Serves our installer downloads at `https://roo-downloads.rooindustries.workers.dev` on the Workers free plan.

- `GET /<key>` and `HEAD /<key>` return the file with its content type (`.exe`, `.msi`, `.zip`, `.7z`),
  `Content-Disposition: attachment`, `Cache-Control: public, max-age=86400`, `ETag` and `Last-Modified`.
  Conditional requests answer 304 or 412, and a single byte range on a GET answers 206 (or 416 when it starts past
  the end), so downloads can resume.
- `GET /health` answers `{"status":"ok","storage":"origin"}` (or `"r2"`) and is never cached.
- Anything else answers 404, and methods other than GET and HEAD answer 405.

Keys keep the path each file has today, so links only change host:

- Tools page installers use their Supabase Storage path in `optimization-builds-private`, e.g. `builds/<hash>.zip`.
- Optimization Suite installers use their Vercel Blob path,
  e.g. `b/<random>/RooIndustries-OptimizationSuite-<version>-setup.exe`.

## Storage modes

The Worker runs in one of two modes, with the same HTTP behavior in both.

**Origin (live now).** `npm run deploy` publishes the Worker with `ORIGIN_FILES` from `wrangler.json`: each key's
source URL, size, SHA-256 and date. The Worker streams the file from its current home: the Suite installer from
Vercel Blob, the Tools page installers through the site's `/api/tools/<id>/download`, which redirects to a fresh
signed Supabase URL. A redirect is followed only to a URL whose path ends with the key and that isn't the Worker
itself. The Worker always asks the source for an exact byte range (the whole file for a full download), skipping
Cloudflare's cache, and passes the body through untouched only when the source answers 206 with exactly that
`Content-Range` and `Content-Length`; anything else answers 503, and a source that drops mid-stream aborts the
download. No code touches the bytes, which keeps every download inside the free plan's 10 ms of CPU. The ETag is the
pinned SHA-256.
To add or replace a file, add its entry to `ORIGIN_FILES` and deploy.

**R2 (next).** `npm run deploy:r2` publishes the same Worker with the `roo-downloads` R2 bucket bound as `DOWNLOADS`
and no `ORIGIN_FILES`. R2 needs a payment method on the Cloudflare account even for the free tier (10 GB stored,
1 million class A and 10 million class B operations a month, free egress). Once that is in place:

1. `npx wrangler r2 bucket create roo-downloads`
2. Upload every file (below).
3. `npm run deploy:r2`, then run `verify` against the live URL.

## Upload and verify

```sh
npm run upload -- builds/<hash>.zip=/path/to/tool.zip \
  b/<random>/RooIndustries-OptimizationSuite-<version>-setup.exe=/path/to/setup.exe
npm run verify -- --url https://roo-downloads.rooindustries.workers.dev <same pairs>
```

`upload` puts each file in the R2 bucket and prints its size and SHA-256. `verify` works in either mode: it checks
`/health`, downloads every file through the Worker, compares its size and SHA-256 with the local file, checks a
1 KB range from the middle, and exits 1 on any difference.

Add `--local --persist-to <dir>` to `upload` to fill the local bucket that
`npx wrangler dev --env r2 --persist-to <dir>` serves.

## Point the site at the Worker

Set `TOOL_DOWNLOADS_ORIGIN=https://roo-downloads.rooindustries.workers.dev` in the site's environment and hosted
Tools page downloads (`/api/tools/<id>/download`) redirect to the Worker instead of a signed Supabase URL.
Unset means off. A release build refuses a value that isn't a bare https origin.

Turn it on only once the Worker runs on R2. In origin mode the Worker reads the Tools installers through that same
site route, so with the switch on it would be redirected back to itself and answer 503. On R2, upload every hosted
tool's file before turning the switch on, and upload a new tool file before publishing it while the switch is on.

## Limits

Workers Free allows 100,000 requests a day. On R2 a download costs at most two class B operations, so even a full
day, every day, stays under the free 10 million a month.

## Tests

`npm test` runs the Worker in workerd in both modes: R2 mode against a local bucket, origin mode against a local
source server. It covers both scripts, downloads, ranges, conditional requests, refusals and broken sources. CI runs
it in the Downloads Worker job.

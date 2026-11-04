# Roo Industries downloads Worker

Serves installer downloads from the `roo-downloads` R2 bucket at
`https://roo-downloads.rooindustries.workers.dev`.

- `GET /<key>` and `HEAD /<key>` return the file with its content type (`.exe`, `.msi`, `.zip`, `.7z`),
  `Content-Disposition: attachment`, `Cache-Control: public, max-age=86400`, `ETag` and `Last-Modified`.
  Conditional requests answer 304 or 412, and a single byte range answers 206 (or 416 when it is past the end).
- `GET /health` answers `{"status":"ok"}` when the bucket responds, 503 otherwise, and is never cached.
- Anything else answers 404, and methods other than GET and HEAD answer 405.

Keys keep the path each file has today, so links only change host:

- Tools page installers use their Supabase Storage path in `optimization-builds-private`, e.g. `builds/<hash>.zip`.
- Optimization Suite installers use their Vercel Blob path,
  e.g. `b/<random>/RooIndustries-OptimizationSuite-<version>-setup.exe`.

## Set up once

1. `npm ci` in this folder.
2. `npx wrangler login` with the Roo Industries Cloudflare account.
3. Enable R2 on that account in the dashboard (R2 Object Storage). Cloudflare asks for a payment method
   even for the free tier: 10 GB stored, 1 million class A and 10 million class B operations a month, free egress.
4. `npx wrangler r2 bucket create roo-downloads`
5. `npm run deploy`

## Upload and verify

```sh
npm run upload -- builds/<hash>.zip=/path/to/tool.zip \
  b/<random>/RooIndustries-OptimizationSuite-<version>-setup.exe=/path/to/setup.exe
npm run verify -- --url https://roo-downloads.rooindustries.workers.dev <same pairs>
```

`upload` puts each file in the bucket and prints its size and SHA-256. `verify` checks `/health`, downloads every
file through the Worker, compares its size and SHA-256 with the local file, checks a 1 KB range from the middle,
and exits 1 on any difference.

Add `--local --persist-to <dir>` to `upload` to fill the local bucket that
`npx wrangler dev --persist-to <dir>` serves.

## Point the site at the Worker

Set `TOOL_DOWNLOADS_ORIGIN=https://roo-downloads.rooindustries.workers.dev` in the site's environment and hosted
Tools page downloads (`/api/tools/<id>/download`) redirect to the Worker instead of a signed Supabase URL.
Unset means off. A release build refuses a value that isn't a bare https origin.

The site doesn't check the bucket, so upload every hosted tool's file before turning it on, and upload a new tool
file before publishing it while the switch is on.

## Limits

Workers Free allows 100,000 requests a day. A download costs at most two class B operations, so even a full day,
every day, stays under the free 10 million a month.

## Tests

`npm test` runs the Worker in workerd against a local R2 bucket. It covers both scripts, downloads, ranges,
conditional requests and refusals. CI runs it in the Downloads Worker job.

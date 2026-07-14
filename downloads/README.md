# Gated Customer Downloads

Send customers to:

```text
https://www.rooindustries.com/downloads/<slug>
```

The customer enters the booking email and an Order ID. The resolver accepts the
booking ID, public booking `orderId`, PayPal order ID, Razorpay order ID,
Razorpay payment ID, or payment-record ID. The download itself is served
through `/api/downloads/file` with a short-lived signed token.

## Production: Private Vercel Blob

Use a private Vercel Blob store for production files. Upload with:

```text
node scripts/upload-download-blob.mjs <slug> [local-zip-path]
```

Example:

```text
node scripts/upload-download-blob.mjs optimizer-pack-v1 downloads/optimizer-pack-v1.zip
https://www.rooindustries.com/downloads/optimizer-pack-v1
```

To replace an existing blob path intentionally:

```text
node scripts/upload-download-blob.mjs optimizer-pack-v1 downloads/optimizer-pack-v1.zip --overwrite
```

The default Blob mapping is:

```text
/downloads/<slug> -> private blob downloads/<slug>.zip
```

The production project needs a private Vercel Blob store connected so Vercel
provides `BLOB_STORE_ID`/OIDC at runtime. Local uploads need
`BLOB_READ_WRITE_TOKEN` from the same store.

After booking authorization, the file route issues an exact-path, GET-only Blob
bearer URL and redirects to it with Vercel's forced-download parameter. The URL
expires after 24 hours by default. `DOWNLOAD_SIGNED_URL_TTL_SECONDS` may extend
that window up to seven days, but values below 24 hours are raised to the safe
24-hour transfer minimum. Direct delivery keeps Blob's
range/resume support and avoids routing large archives through the application.

Vercel Blob does not provide per-URL revocation after a signed URL is issued.
Revoking a booking immediately blocks new URLs, but an already-issued URL can
remain usable until its expiry (unless the underlying blob becomes unavailable).

The catalog `fileName` must exactly match the basename of `blobPath`. This keeps
the forced-download filename stable. Invalid mappings are rejected; the route
only falls back to application streaming for a legacy or non-catalog mismatch.

## Local Fallback

When Blob credentials are not configured, the same route can serve a local ZIP
from this folder:

```text
downloads/<slug>.zip
```

This is mainly for development, test previews, or very small controlled files.

Optional `DOWNLOAD_CATALOG_JSON` can customize labels, filenames, and package
restrictions:

```json
[
  {
    "slug": "optimizer-pack-v1",
    "title": "Optimizer Pack v1",
    "fileName": "optimizer-pack-v1.zip",
    "blobPath": "downloads/optimizer-pack-v1.zip",
    "storageBackend": "blob",
    "sizeBytes": 3650722816,
    "sha256": "8888888888888888888888888888888888888888888888888888888888888888",
    "blobEtag": "replace-with-the-etag-produced-by-the-upload-script",
    "allowedPackageTitles": ["Performance Vertex Max"]
  }
]
```

`sizeBytes`, `sha256`, and `blobEtag` are mandatory pins for every configured
archive. The upload script prints the verified values after checking the ZIP,
CRC, local SHA-256, remote size, and remote ETag. Production refuses to sign a
Blob URL when any pin is missing or the live Blob revision differs.

Set `DOWNLOAD_STORAGE_BACKEND=blob` to force Blob, or `local` to force the
repo-local fallback. Without that variable, Blob is used when Vercel Blob
credentials are present; otherwise local fallback is used.

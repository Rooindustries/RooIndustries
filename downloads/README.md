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
    "allowedPackageTitles": ["Performance Vertex Max"]
  }
]
```

Set `DOWNLOAD_STORAGE_BACKEND=blob` to force Blob, or `local` to force the
repo-local fallback. Without that variable, Blob is used when Vercel Blob
credentials are present; otherwise local fallback is used.

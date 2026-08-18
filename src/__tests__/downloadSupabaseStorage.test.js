const {
  createSignedSupabaseDownloadUrl,
  DOWNLOAD_STORAGE_SUPABASE,
  getDownloadStorageBackend,
  verifySupabaseDownloadMetadata,
} = require("../server/downloads/downloadStorage");

const download = {
  fileName: "utilities.zip",
  blobPath: "downloads/utilities.zip",
  storageBackend: "supabase",
  storageBucket: "optimization-builds-private",
  sizeBytes: 3_692_474_026,
  sha256: "8".repeat(64),
  blobEtag: '"verified-supabase-etag"',
  contentType: "application/zip",
};

const env = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: "server-secret-placeholder",
};

const createClient = ({
  metadata = {},
  metadataError = null,
  bucketMetadata = { public: false },
  signedUrl =
    "https://project.supabase.co/storage/v1/object/sign/" +
    "optimization-builds-private/downloads/utilities.zip" +
    "?token=signed&download=utilities.zip",
} = {}) => {
  const getBucket = jest.fn(async () => ({
    data: bucketMetadata,
    error: null,
  }));
  const info = jest.fn(async () => ({
    data: metadataError ? null : {
      size: download.sizeBytes,
      etag: "verified-supabase-etag",
      contentType: "application/zip",
      ...metadata,
    },
    error: metadataError,
  }));
  const createSignedUrl = jest.fn(async () => ({
    data: { signedUrl },
    error: null,
  }));
  const from = jest.fn(() => ({ info, createSignedUrl }));
  return {
    client: { storage: { getBucket, from } },
    getBucket,
    from,
    info,
    createSignedUrl,
  };
};

describe("Supabase-backed downloads", () => {
  test("uses Supabase only when the catalog or environment selects it", () => {
    expect(getDownloadStorageBackend(download, env)).toBe(
      DOWNLOAD_STORAGE_SUPABASE
    );
    expect(
      getDownloadStorageBackend(
        { ...download, storageBackend: "" },
        { ...env, DOWNLOAD_STORAGE_BACKEND: "supabase" }
      )
    ).toBe(DOWNLOAD_STORAGE_SUPABASE);
    expect(
      getDownloadStorageBackend(
        { ...download, storageBackend: "" },
        { ...env, DOWNLOAD_STORAGE_BACKEND: "" }
      )
    ).toBe("local");
  });

  test("verifies the private object before issuing a 24-hour URL", async () => {
    const storage = createClient();

    const url = await createSignedSupabaseDownloadUrl(download, {
      env,
      client: storage.client,
    });

    expect(new URL(url).searchParams.get("download")).toBe("utilities.zip");
    expect(storage.getBucket).toHaveBeenCalledWith(
      "optimization-builds-private"
    );
    expect(storage.from).toHaveBeenCalledWith("optimization-builds-private");
    expect(storage.info).toHaveBeenCalledWith("downloads/utilities.zip");
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      "downloads/utilities.zip",
      86_400,
      { download: "utilities.zip" }
    );
  });

  test.each([
    [{ size: download.sizeBytes - 1 }, "DOWNLOAD_SUPABASE_SIZE_MISMATCH"],
    [{ etag: "unexpected-etag" }, "DOWNLOAD_SUPABASE_ETAG_MISMATCH"],
    [
      { contentType: "application/octet-stream" },
      "DOWNLOAD_SUPABASE_CONTENT_TYPE_MISMATCH",
    ],
  ])("fails closed when object metadata differs", async (metadata, code) => {
    const storage = createClient({ metadata });

    await expect(
      verifySupabaseDownloadMetadata(download, {
        env,
        client: storage.client,
      })
    ).rejects.toMatchObject({ code, status: 503 });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  test("fails closed if the configured bucket is public", async () => {
    const storage = createClient({ bucketMetadata: { public: true } });

    await expect(
      createSignedSupabaseDownloadUrl(download, {
        env,
        client: storage.client,
      })
    ).rejects.toMatchObject({
      code: "DOWNLOAD_SUPABASE_BUCKET_PUBLIC",
      status: 503,
    });
    expect(storage.info).not.toHaveBeenCalled();
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  test("fails closed if the configured private object is missing", async () => {
    const storage = createClient({
      metadataError: { message: "Object not found", status: 404 },
    });

    await expect(
      createSignedSupabaseDownloadUrl(download, {
        env,
        client: storage.client,
      })
    ).rejects.toMatchObject({
      code: "DOWNLOAD_SUPABASE_METADATA_UNAVAILABLE",
      status: 503,
    });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  test.each([
    [
      "https://example.com/storage/v1/object/sign/" +
        "optimization-builds-private/downloads/utilities.zip" +
        "?token=signed&download=utilities.zip",
    ],
    [
      "https://project.supabase.co/storage/v1/object/sign/" +
        "optimization-builds-private/downloads/utilities.zip" +
        "?token=&download=utilities.zip",
    ],
  ])("rejects a signed URL outside its exact private scope", async (signedUrl) => {
    const storage = createClient({ signedUrl });

    await expect(
      createSignedSupabaseDownloadUrl(download, {
        env,
        client: storage.client,
      })
    ).rejects.toThrow("invalid signed download URL");
  });
});

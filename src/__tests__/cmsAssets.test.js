import crypto from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { prepareGlobalCmsAssets } from "../server/cms/assets";

const bytes = Buffer.from("safe");
const asset = {
  _id: "file-assetid-zip",
  _type: "sanity.fileAsset",
  assetId: "assetid",
  extension: "zip",
  url: "https://cdn.sanity.io/files/9g42k3ur/production/assetid.zip",
  mimeType: "application/zip",
  size: bytes.length,
  sha1hash: crypto.createHash("sha1").update(bytes).digest("hex"),
  metadata: { dimensions: {} },
};

const bodyStream = (value) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });

describe("CMS asset promotion", () => {
  test("rejects large file assets before network or storage work", async () => {
    const largeAsset = {
      ...asset,
      size: Math.floor(3.4 * 1024 * 1024 * 1024),
    };
    const supabaseClient = {
      rpc: jest.fn(async () => ({ data: [], error: null })),
      storage: { from: jest.fn() },
    };
    const fetchImpl = jest.fn();
    await expect(
      prepareGlobalCmsAssets({
        document: {
          _id: "tool.utilities",
          _type: "tool",
          downloadFile: { asset: { _ref: largeAsset._id } },
        },
        suppliedManifest: [largeAsset],
        token: "user-token",
        supabaseClient,
        fetchImpl,
        sanityClientFactory: jest.fn(() => ({
          fetch: jest.fn(async () => [largeAsset]),
        })),
      }),
    ).rejects.toMatchObject({ status: 413, code: "CMS_ASSET_TOO_LARGE" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supabaseClient.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseClient.storage.from).not.toHaveBeenCalled();
  });

  test("reuses a previously verified large asset without transferring it again", async () => {
    const largeAsset = {
      ...asset,
      size: 100 * 1024 * 1024,
    };
    const stored = {
      legacy_sanity_asset_id: largeAsset._id,
      source_url: largeAsset.url,
      storage_bucket: "optimization-builds-private",
      storage_path: "builds/assetid.zip",
      mime_type: largeAsset.mimeType,
      byte_size: largeAsset.size,
      sha256: "a".repeat(64),
      migration_status: "verified",
    };
    const supabaseClient = {
      rpc: jest.fn(async () => ({ data: [stored], error: null })),
      storage: { from: jest.fn() },
    };
    const fetchImpl = jest.fn();
    await expect(
      prepareGlobalCmsAssets({
        document: {
          _id: "tool.existing",
          _type: "tool",
          downloadFile: { asset: { _ref: largeAsset._id } },
        },
        suppliedManifest: [largeAsset],
        token: "user-token",
        supabaseClient,
        fetchImpl,
        sanityClientFactory: jest.fn(() => ({
          fetch: jest.fn(async () => [largeAsset]),
        })),
      }),
    ).resolves.toEqual([expect.objectContaining({ sha256: "a".repeat(64) })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supabaseClient.storage.from).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "an image above the public bucket limit",
      candidate: {
        _id: "image-imageid-100x100-png",
        _type: "sanity.imageAsset",
        assetId: "imageid",
        extension: "png",
        url: "https://cdn.sanity.io/images/9g42k3ur/production/imageid-100x100.png",
        mimeType: "image/png",
        size: 21 * 1024 * 1024,
        sha1hash: "a".repeat(40),
        metadata: { dimensions: { width: 100, height: 100 } },
      },
      code: "CMS_ASSET_TOO_LARGE",
      status: 413,
    },
    {
      name: "a file MIME type outside the private bucket allowlist",
      candidate: {
        _id: "file-document-pdf",
        _type: "sanity.fileAsset",
        assetId: "document",
        extension: "pdf",
        url: "https://cdn.sanity.io/files/9g42k3ur/production/document.pdf",
        mimeType: "application/pdf",
        size: 1024,
        sha1hash: "b".repeat(40),
        metadata: { dimensions: {} },
      },
      code: "CMS_ASSET_TYPE_UNSUPPORTED",
      status: 400,
    },
  ])("rejects $name before transfer", async ({ candidate, code, status }) => {
    const supabaseClient = {
      rpc: jest.fn(async () => ({ data: [], error: null })),
      storage: { from: jest.fn() },
    };
    const fetchImpl = jest.fn();
    await expect(
      prepareGlobalCmsAssets({
        document: {
          _id: "tool.policy",
          _type: "tool",
          asset: { _ref: candidate._id },
        },
        suppliedManifest: [candidate],
        token: "user-token",
        supabaseClient,
        fetchImpl,
        sanityClientFactory: jest.fn(() => ({
          fetch: jest.fn(async () => [candidate]),
        })),
      }),
    ).rejects.toMatchObject({ code, status });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supabaseClient.storage.from).not.toHaveBeenCalled();
  });

  test("does not touch Supabase Storage until source bytes pass SHA-1 and size", async () => {
    const upload = jest.fn();
    const supabaseClient = {
      rpc: jest.fn(async () => ({ data: [], error: null })),
      storage: { from: jest.fn(() => ({ upload })) },
    };
    const sanityClientFactory = jest.fn(() => ({
      fetch: jest.fn(async () => [asset]),
    }));
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      body: bodyStream("evil"),
      headers: new Headers({
        "content-length": String(bytes.length),
        "content-type": "application/zip",
      }),
    }));

    await expect(
      prepareGlobalCmsAssets({
        document: {
          _id: "tool.one",
          _type: "tool",
          download: { _type: "file", asset: { _ref: asset._id } },
        },
        suppliedManifest: [asset],
        token: "user-token",
        supabaseClient,
        fetchImpl,
        sanityClientFactory,
      }),
    ).rejects.toMatchObject({ code: "CMS_ASSET_SOURCE_MISMATCH" });
    expect(upload).not.toHaveBeenCalled();
  });
});

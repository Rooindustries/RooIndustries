import {
  clearSupabaseAssetManifestCache,
  enrichSupabaseContentAssets,
} from "../server/supabase/assets";

describe("Supabase content asset URLs", () => {
  beforeEach(() => clearSupabaseAssetManifestCache());

  test("uses public image URLs and short-lived private build URLs", async () => {
    const manifest = [
      {
        legacy_sanity_asset_id: "image-one",
        source_url: "https://cdn.sanity.io/image-one.png",
        storage_bucket: "site-content-public",
        storage_path: "images/one.png",
        width: 1200,
        height: 800,
      },
      {
        legacy_sanity_asset_id: "file-one",
        source_url: "https://cdn.sanity.io/file-one.zip",
        storage_bucket: "optimization-builds-private",
        storage_path: "builds/one.zip",
      },
    ];
    const client = {
      rpc: jest.fn().mockResolvedValue({ data: manifest, error: null }),
      storage: {
        from: jest.fn((bucket) => ({
          getPublicUrl: (path) => ({
            data: { publicUrl: `https://storage.test/${bucket}/${path}` },
          }),
          createSignedUrl: async (path, expiresIn) => ({
            data: {
              signedUrl: `https://storage.test/private/${path}?ttl=${expiresIn}`,
            },
            error: null,
          }),
        })),
      },
    };
    const data = {
      image: { asset: { _ref: "image-one" } },
      download: "https://cdn.sanity.io/file-one.zip",
    };

    await expect(
      enrichSupabaseContentAssets({ data, client }),
    ).resolves.toEqual({
      image: {
        asset: {
          _ref: "image-one",
          _supabaseUrl:
            "https://storage.test/site-content-public/images/one.png",
        },
        dimensions: {
          width: 1200,
          height: 800,
          aspectRatio: 1.5,
        },
      },
      download: "https://storage.test/private/builds/one.zip?ttl=900",
    });
    expect(client.rpc).toHaveBeenCalledWith("roo_asset_manifest_for_refs", {
      p_asset_ids: ["image-one"],
      p_source_urls: ["https://cdn.sanity.io/file-one.zip"],
    });
    expect(client.rpc).not.toHaveBeenCalledWith("roo_asset_manifest");
  });

  test("does not load an asset manifest for content without asset references", async () => {
    const client = { rpc: jest.fn() };
    const data = {
      title: "No image",
      body: [{ children: [{ text: "Plain text" }] }],
    };
    await expect(
      enrichSupabaseContentAssets({ data, client }),
    ).resolves.toEqual(data);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test("resolves projected asset IDs when the Supabase dataset has no Sanity asset document", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            legacy_sanity_asset_id: "file-tool-zip",
            source_url: "https://cdn.sanity.io/files/tool.zip",
            storage_bucket: "optimization-builds-private",
            storage_path: "builds/tool.zip",
          },
        ],
        error: null,
      }),
      storage: {
        from: jest.fn(() => ({
          createSignedUrl: jest.fn(async () => ({
            data: { signedUrl: "https://storage.test/tool.zip?ttl=900" },
            error: null,
          })),
        })),
      },
    };
    await expect(
      enrichSupabaseContentAssets({
        data: { fileUrl: "file-tool-zip" },
        client,
      }),
    ).resolves.toEqual({
      fileUrl: "https://storage.test/tool.zip?ttl=900",
    });
    expect(client.rpc).toHaveBeenCalledWith("roo_asset_manifest_for_refs", {
      p_asset_ids: ["file-tool-zip"],
      p_source_urls: [],
    });
    const storage = client.storage.from.mock.results[0].value;
    expect(client.storage.from).toHaveBeenCalledWith("optimization-builds-private");
    expect(storage.createSignedUrl).toHaveBeenCalledWith("builds/tool.zip", 900);
  });
});

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

    await expect(enrichSupabaseContentAssets({ data, client })).resolves.toEqual({
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
  });
});

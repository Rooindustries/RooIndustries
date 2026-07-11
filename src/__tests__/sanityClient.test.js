jest.mock("@sanity/image-url", () => ({
  createImageUrlBuilder: jest.fn(() => ({})),
}));

import { urlFor } from "../sanityClient";

const SUPABASE_ORIGINAL =
  "https://ntezmxzaibrrsgtujgxu.supabase.co/storage/v1/object/public/site-content-public/images/example.png";

describe("Supabase image URL builder", () => {
  test("uses the transformation endpoint for requested WebP sizes", () => {
    expect(
      urlFor({ _supabaseUrl: SUPABASE_ORIGINAL })
        .width(800)
        .format("webp")
        .quality(60)
        .url()
    ).toBe(
      "https://ntezmxzaibrrsgtujgxu.supabase.co/storage/v1/render/image/public/site-content-public/images/example.png?width=800&quality=60"
    );
  });

  test("maps Sanity crop modes to supported Supabase resize modes", () => {
    expect(
      urlFor({ _supabaseUrl: SUPABASE_ORIGINAL })
        .width(450)
        .height(600)
        .fit("crop")
        .quality(75)
        .url()
    ).toBe(
      "https://ntezmxzaibrrsgtujgxu.supabase.co/storage/v1/render/image/public/site-content-public/images/example.png?width=450&height=600&resize=cover&quality=75"
    );
  });

  test("keeps original, SVG, and already-optimized WebP URLs direct", () => {
    expect(urlFor({ _supabaseUrl: SUPABASE_ORIGINAL }).url()).toBe(
      SUPABASE_ORIGINAL
    );
    const svg = SUPABASE_ORIGINAL.replace("example.png", "example.svg");
    expect(urlFor({ _supabaseUrl: svg }).width(64).url()).toBe(svg);
    const webp = SUPABASE_ORIGINAL.replace("example.png", "example.webp");
    expect(
      urlFor({ _supabaseUrl: webp })
        .width(800)
        .format("webp")
        .quality(60)
        .url()
    ).toBe(webp);
  });

  test("does not rewrite non-Supabase direct URLs", () => {
    const direct = "https://images.example.com/example.png";
    expect(urlFor({ asset: { url: direct } }).width(800).quality(60).url()).toBe(
      direct
    );
  });
});

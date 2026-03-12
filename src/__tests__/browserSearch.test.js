const { sanitizeBrowserSearch } = require("../lib/browserSearch.js");

describe("sanitizeBrowserSearch", () => {
  test("keeps only attribution and debug params on the homepage", () => {
    expect(
      sanitizeBrowserSearch(
        "/",
        "?ref=servi&utm_source=discord&perfdebug=1&token=drop-me"
      )
    ).toBe("?ref=servi&utm_source=discord&perfdebug=1");
  });

  test("preserves route-critical query params away from the homepage", () => {
    expect(sanitizeBrowserSearch("/referrals/reset", "?token=abc123")).toBe(
      "?token=abc123"
    );
    expect(
      sanitizeBrowserSearch("/payment", "?data=encoded-booking&ref=servi")
    ).toBe("?data=encoded-booking&ref=servi");
    expect(
      sanitizeBrowserSearch(
        "/booking",
        "?title=Vertex&price=%24199&tag=Best%20Value&ref=servi"
      )
    ).toBe("?title=Vertex&price=%24199&tag=Best+Value&ref=servi");
  });
});

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

  test("removes sensitive query params away from the homepage", () => {
    expect(sanitizeBrowserSearch("/referrals/reset", "?token=abc123")).toBe("");
    expect(
      sanitizeBrowserSearch("/payment", "?data=encoded-booking&ref=servi")
    ).toBe("?ref=servi");
    expect(
      sanitizeBrowserSearch(
        "/upgrade/test",
        "?orderId=booking.1&email=client%40example.com&ref=servi"
      )
    ).toBe("?ref=servi");
  });

  test("removes booking payload from the URL while preserving attribution", () => {
    expect(
      sanitizeBrowserSearch(
        "/booking",
        "?title=Vertex&price=%24199&tag=Best%20Value&ref=servi"
      )
    ).toBe("?ref=servi");
  });
});

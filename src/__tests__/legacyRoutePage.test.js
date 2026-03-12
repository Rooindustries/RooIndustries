const { buildQueryString } = require("../next/routeQuery.js");

describe("LegacyRoutePage", () => {
  test("preserves query params from URLSearchParams when building the initial memory route", () => {
    expect(
      buildQueryString(new URLSearchParams([["token", "abc123"]]))
    ).toBe("?token=abc123");
  });
});

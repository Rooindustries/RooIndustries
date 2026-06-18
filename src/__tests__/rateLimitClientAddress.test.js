const {
  getClientAddress,
} = require("../server/api/ref/rateLimit");
const {
  getClientAddressFromFetchHeaders,
} = require("../server/request/clientAddress");

describe("client address parsing for rate limits", () => {
  test("uses the first valid x-forwarded-for address", () => {
    expect(
      getClientAddress({
        headers: {
          "x-forwarded-for": "203.0.113.10, 10.0.0.1",
          "x-real-ip": "198.51.100.2",
        },
      })
    ).toBe("203.0.113.10");
  });

  test("ignores malformed forwarded values and falls back to real IP", () => {
    expect(
      getClientAddress({
        headers: {
          "x-forwarded-for": "not-an-ip",
          "x-real-ip": "198.51.100.2",
        },
      })
    ).toBe("198.51.100.2");
  });

  test("supports Fetch Headers used by app router routes", () => {
    const headers = new Headers({
      "x-forwarded-for": "bad, 2001:db8::1",
      "x-real-ip": "198.51.100.2",
    });

    expect(getClientAddressFromFetchHeaders(headers)).toBe("2001:db8::1");
  });

  test("returns unknown when no valid address is present", () => {
    expect(
      getClientAddress({
        headers: {
          "x-forwarded-for": "unknown",
          "x-real-ip": "",
        },
      })
    ).toBe("unknown");
  });
});

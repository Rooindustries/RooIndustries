import { getSafeErrorMetadata } from "../server/safeErrorLog";

describe("safe server error logging", () => {
  test("does not carry messages, stacks, provider responses, tokens, or customer data", () => {
    const metadata = getSafeErrorMetadata({
      name: "ProviderError",
      code: "lookup_failed",
      status: 503,
      message: "customer@example.com private-token",
      stack: "secret stack",
      response: { access_token: "provider-token" },
    });

    expect(metadata).toEqual({
      name: "ProviderError",
      code: "lookup_failed",
      status: 503,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/customer|token|stack|response/i);
  });
});

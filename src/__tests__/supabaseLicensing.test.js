import {
  activateEntitlementDevice,
  hashDeviceFingerprint,
  licensingErrorResponse,
} from "../server/supabase/licensing";

describe("Supabase app licensing", () => {
  test("stores only a deterministic HMAC of the hardware fingerprint", () => {
    const raw = "board:cpu:disk:machine-guid";
    const digest = hashDeviceFingerprint({
      fingerprint: raw,
      secret: "a-strong-device-hashing-secret-with-more-than-32-chars",
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(raw);
  });

  test("passes a hashed fingerprint and stable request ID to the RPC", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { status: "active" },
        error: null,
      }),
    };
    await activateEntitlementDevice({
      userId: "22fb353c-429e-4db2-89de-602aba57f64c",
      entitlementId: "5e186768-d210-4d7e-a594-ea3a21c452e7",
      fingerprint: "board:cpu:disk:machine-guid",
      requestId: "activation:one-request",
      env: {
        APP_DEVICE_HASH_SECRET:
          "a-strong-device-hashing-secret-with-more-than-32-chars",
      },
      client,
    });
    const args = client.rpc.mock.calls[0][1];
    expect(args.p_device_fingerprint_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_device_fingerprint_hmac).not.toContain("machine-guid");
    expect(args.p_request_id).toBe("activation:one-request");
  });

  test("maps the one-PC conflict without leaking database details", () => {
    expect(licensingErrorResponse({ code: "23505" })).toEqual({
      status: 409,
      error: "This purchase is already active on another PC.",
    });
  });
});

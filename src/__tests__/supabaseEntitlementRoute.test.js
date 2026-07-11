const mockRequireSupabaseBearerUser = jest.fn();
const mockActivateEntitlementDevice = jest.fn();
const mockClaimEntitlement = jest.fn();
const mockGetEntitlementStatus = jest.fn();
const mockRevokeEntitlementDevice = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => {
      const headers = new Map(Object.entries(init.headers || {}));
      return {
        status: init.status || 200,
        json: async () => body,
        headers: {
          get: (name) => headers.get(name) || headers.get(String(name).toLowerCase()),
          set: (name, value) => headers.set(name, value),
        },
      };
    },
  },
}));

jest.mock("../server/supabase/accounts", () => ({
  requireSupabaseBearerUser: (...args) => mockRequireSupabaseBearerUser(...args),
}));

jest.mock("../server/supabase/licensing", () => ({
  activateEntitlementDevice: (...args) => mockActivateEntitlementDevice(...args),
  claimEntitlement: (...args) => mockClaimEntitlement(...args),
  getEntitlementStatus: (...args) => mockGetEntitlementStatus(...args),
  revokeEntitlementDevice: (...args) => mockRevokeEntitlementDevice(...args),
  licensingErrorResponse: () => ({
    status: 500,
    error: "Licensing is temporarily unavailable.",
  }),
}));

jest.mock("../server/safeErrorLog", () => ({
  logSafeError: jest.fn(),
}));

const route = require("../../app/api/app/entitlements/[action]/route.js");

const makeRequest = ({ body = {}, authorization = "Bearer access-token" } = {}) => {
  const raw = JSON.stringify(body);
  return {
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === "authorization") return authorization;
        if (key === "content-type") return "application/json";
        if (key === "content-length") return String(Buffer.byteLength(raw));
        return "";
      },
    },
    text: async () => raw,
  };
};

const context = (action) => ({ params: Promise.resolve({ action }) });

describe("Supabase app entitlement route", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SUPABASE_LICENSING_ENABLED: "1",
      REF_ADMIN_KEY: "",
    };
    mockRequireSupabaseBearerUser.mockResolvedValue({
      ok: true,
      user: { id: "user-one", email: "buyer@example.com" },
      account: { roles: ["customer"] },
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("is not externally available until explicitly enabled", async () => {
    process.env.SUPABASE_LICENSING_ENABLED = "0";
    const response = await route.GET(makeRequest(), context("status"));
    expect(response.status).toBe(404);
    expect(mockRequireSupabaseBearerUser).not.toHaveBeenCalled();
  });

  test("claims only with the verified bearer identity email", async () => {
    mockClaimEntitlement.mockResolvedValue({ status: "claimed" });
    const response = await route.POST(
      makeRequest({ body: { purchaseReference: "order-one" } }),
      context("claim")
    );
    expect(response.status).toBe(200);
    expect(mockClaimEntitlement).toHaveBeenCalledWith({
      userId: "user-one",
      verifiedEmail: "buyer@example.com",
      purchaseReference: "order-one",
    });
  });

  test("rejects a chunked oversized body after reading it", async () => {
    const raw = JSON.stringify({ value: "x".repeat(17 * 1024) });
    const request = {
      headers: {
        get: (name) => {
          const key = String(name).toLowerCase();
          if (key === "content-type") return "application/json";
          if (key === "authorization") return "Bearer access-token";
          return "";
        },
      },
      text: async () => raw,
    };
    const response = await route.POST(request, context("activate"));
    expect(response.status).toBe(413);
    expect(mockActivateEntitlementDevice).not.toHaveBeenCalled();
  });

  test("requires administrator role for device revocation", async () => {
    const response = await route.POST(
      makeRequest({
        body: {
          entitlementId: "5e186768-d210-4d7e-a594-ea3a21c452e7",
          requestId: "revocation:request-one",
        },
      }),
      context("revoke")
    );
    expect(response.status).toBe(404);
    expect(mockRevokeEntitlementDevice).not.toHaveBeenCalled();
  });
});

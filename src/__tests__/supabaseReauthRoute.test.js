const mockResolveExactDomainIdentity = jest.fn();
const mockResolveAccountByUserId = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockRpc = jest.fn();
const mockConsumeAuthRateLimit = jest.fn();
const { AuthApiError, AuthError, AuthRetryableFetchError } = require("@supabase/auth-js");

const createResponse = (payload, init = {}) => {
  const headers = new Map();
  const cookies = [];
  return {
    status: init.status || 200,
    json: async () => payload,
    headers: {
      get: (name) => headers.get(String(name).toLowerCase()) || null,
      set: (name, value) => headers.set(String(name).toLowerCase(), String(value)),
    },
    cookies: {
      getAll: () => [...cookies],
      set: (...args) => cookies.push(args.length === 1 ? args[0] : args),
      values: cookies,
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (payload, init) => createResponse(payload, init) },
}));

jest.mock("../server/supabase/domainIdentity", () => ({
  resolveExactDomainIdentity: (...args) => mockResolveExactDomainIdentity(...args),
}));

jest.mock("../server/supabase/accounts", () => ({
  resolveSupabaseAccountByUserId: (...args) => mockResolveAccountByUserId(...args),
}));

jest.mock("../server/supabase/authClient", () => ({
  createSupabaseAuthClient: () => ({
    auth: { signInWithPassword: (...args) => mockSignInWithPassword(...args) },
  }),
}));

jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => ({ rpc: (...args) => mockRpc(...args) }),
}));

jest.mock("../server/supabase/authRateLimit", () => ({
  consumeAuthRateLimit: (...args) => mockConsumeAuthRateLimit(...args),
}));

jest.mock("../server/supabase/reauth", () => ({
  clearReauthCookie: (slot) => ({
    name: slot ? `roo_reauth_${slot}` : "roo_reauth_grant",
    value: "",
    maxAge: 0,
    path: "/",
  }),
  createReauthToken: () => "reauth-token",
  hashReauthToken: (value) => `hash:${value}`,
  reauthCookie: (value, slot) => ({
    name: slot ? `roo_reauth_${slot}` : "roo_reauth_grant",
    value,
    httpOnly: true,
    maxAge: 600,
    path: "/",
  }),
}));

const { POST } = require("../../app/api/auth/reauth/route.js");

const makeRequest = (payload, origin = "https://www.rooindustries.com") => {
  const body = JSON.stringify(payload);
  return {
    url: "https://www.rooindustries.com/api/auth/reauth",
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "origin") return origin;
        if (key === "content-type") return "application/json";
        if (key === "content-length") return String(Buffer.byteLength(body));
        return "";
      },
    },
    text: async () => body,
  };
};

describe("Supabase reauthentication route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        connected_providers: ["email", "google"],
        primary_email: "tourney-player+internal@auth.rooindustries.invalid",
        principal_id: "11111111-1111-4111-8111-111111111111",
      },
      user: { id: "22222222-2222-4222-8222-222222222222" },
    });
    mockConsumeAuthRateLimit.mockResolvedValue({ allowed: true, retryAfter: 60 });
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: "33333333-3333-4333-8333-333333333333" } },
      error: null,
    });
    mockResolveAccountByUserId.mockResolvedValue({
      principal_id: "11111111-1111-4111-8111-111111111111",
    });
    mockRpc.mockResolvedValue({
      data: { expires_at: "2099-01-01T00:00:00.000Z" },
      error: null,
    });
  });

  test("verifies the real Auth login while binding the grant to the active session", async () => {
    const response = await POST(
      makeRequest({
        flow: "referral",
        password: "current-password",
        purpose: "link_identity",
        slot: "primary",
      })
    );
    expect(response.status).toBe(200);
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "tourney-player+internal@auth.rooindustries.invalid",
      password: "current-password",
    });
    expect(mockRpc).toHaveBeenCalledWith("roo_create_reauth_grant", {
      p_user_id: "22222222-2222-4222-8222-222222222222",
      p_token_hash: "hash:reauth-token",
      p_purpose: "link_identity",
      p_provider: null,
    });
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_reauth_primary",
        httpOnly: true,
      })
    );
  });

  test("rejects a password that authenticates a different principal", async () => {
    mockResolveAccountByUserId.mockResolvedValue({
      principal_id: "44444444-4444-4444-8444-444444444444",
    });
    const response = await POST(
      makeRequest({
        flow: "referral",
        password: "wrong-account-password",
        purpose: "unlink_identity",
        provider: "google",
      })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Password is incorrect." });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({ name: "roo_reauth_grant", maxAge: 0 })
    );
  });

  test("distinguishes an incorrect password from an expired session", async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: null }, error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") });
    const payload = { flow: "referral", password: "incorrect-password", purpose: "link_identity" };
    const incorrect = await POST(makeRequest(payload));
    expect(incorrect.status).toBe(401);
    expect(await incorrect.json()).toEqual({ ok: false, error: "Password is incorrect.", reason: "password_incorrect" });
    expect(mockRpc).not.toHaveBeenCalled();

    mockResolveExactDomainIdentity.mockResolvedValue(null);
    mockSignInWithPassword.mockClear();
    const expired = await POST(makeRequest(payload));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ ok: false, error: "Sign in again before changing account security." });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid credentials", new AuthApiError("Invalid login credentials", 400, "invalid_credentials"), 401, "Password is incorrect.", "password_incorrect"],
    ["legacy invalid credentials", new AuthApiError("Invalid login credentials", 400), 401, "Password is incorrect.", "password_incorrect"],
    ["upstream outage", new AuthRetryableFetchError("Synthetic auth outage.", 503), 503, "Reauthentication is temporarily unavailable.", null],
    ["network failure", new AuthRetryableFetchError("Synthetic network failure.", 0), 503, "Reauthentication is temporarily unavailable.", null],
    ["missing status", new AuthError("Synthetic unknown failure."), 503, "Reauthentication is temporarily unavailable.", null],
    ["upstream rate limit", new AuthApiError("Too many requests", 429, "over_request_rate_limit"), 429, "Too many attempts. Try again shortly.", null],
    ["unconfirmed email", new AuthApiError("Email not confirmed", 400, "email_not_confirmed"), 401, "Password is incorrect.", null],
    ["other coded error", new AuthApiError("Invalid login credentials", 400, "email_not_confirmed"), 401, "Password is incorrect.", null],
    ["invalid request", new AuthApiError("Invalid request", 422, "validation_failed"), 401, "Password is incorrect.", null],
  ])("classifies %s without creating a grant", async (_label, error, status, message, reason) => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: null }, error });
    const response = await POST(makeRequest({ flow: "referral", password: "submitted-password", purpose: "link_identity" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error: message, ...(reason ? { reason } : {}) });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.cookies.values).toContainEqual(expect.objectContaining({ name: "roo_reauth_grant", maxAge: 0 }));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test("fails closed on cross-origin requests", async () => {
    const response = await POST(
      makeRequest(
        {
          flow: "referral",
          password: "current-password",
          purpose: "change_password",
        },
        "https://attacker.example"
      )
    );
    expect(response.status).toBe(403);
    expect(mockResolveExactDomainIdentity).not.toHaveBeenCalled();
  });

  test("D6/O1 reauthenticates legacy deployment labels through native Auth", async () => {
    const previousPrimary = process.env.DATA_PRIMARY_BACKEND;
    const previousCutover = process.env.SUPABASE_CUTOVER_ENABLED;
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    process.env.SUPABASE_CUTOVER_ENABLED = "1";
    try {
      const response = await POST(
        makeRequest({
          flow: "referral",
          password: "current-password",
          purpose: "change_password",
        })
      );
      expect(response.status).toBe(200);
      expect(mockResolveExactDomainIdentity).toHaveBeenCalled();
      expect(mockSignInWithPassword).toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalled();
    } finally {
      if (previousPrimary === undefined) delete process.env.DATA_PRIMARY_BACKEND;
      else process.env.DATA_PRIMARY_BACKEND = previousPrimary;
      if (previousCutover === undefined) delete process.env.SUPABASE_CUTOVER_ENABLED;
      else process.env.SUPABASE_CUTOVER_ENABLED = previousCutover;
    }
  });
});

const mockResolveExactDomainIdentity = jest.fn();
const mockCreateOAuthIntent = jest.fn();
const mockClearNextSupabaseSession = jest.fn();
const mockConsumeAuthRateLimit = jest.fn();
const mockReadReauthToken = jest.fn();
const mockReadRecovery = jest.fn();
const mockMatchesRecovery = jest.fn();
const originalTourneyDatabaseMode = process.env.TOURNEY_DATABASE_MODE;

jest.mock("../server/supabase/domainIdentity", () => ({
  resolveExactDomainIdentity: (...args) => mockResolveExactDomainIdentity(...args),
}));

jest.mock("../server/supabase/oauthIntents", () => ({
  createOAuthIntent: (...args) => mockCreateOAuthIntent(...args),
  oauthIntentCookie: (token, id) => ({
    name: `roo_oauth_intent.${id}`,
    value: token,
    httpOnly: true,
    path: "/auth/callback",
  }),
}));

jest.mock("../server/supabase/serverSession", () => ({
  clearNextSupabaseSession: (...args) => mockClearNextSupabaseSession(...args),
}));

jest.mock("../server/supabase/authRateLimit", () => ({
  consumeAuthRateLimit: (...args) => mockConsumeAuthRateLimit(...args),
}));

jest.mock("../server/supabase/reauth", () => ({
  clearReauthCookie: () => ({
    name: "roo_reauth_grant",
    value: "",
    maxAge: 0,
    path: "/",
  }),
  readReauthToken: (...args) => mockReadReauthToken(...args),
}));

jest.mock("../server/supabase/orphanIdentityReclaim", () => ({
  matchesReferralOrphanReclaim: (...args) => mockMatchesRecovery(...args),
  readReferralOrphanReclaim: (...args) => mockReadRecovery(...args),
}));

const createResponse = (payload, init = {}) => {
  const headers = new Map();
  const cookies = [];
  return {
    status: init.status || 200,
    json: async () => payload,
    headers: {
      get: (name) => headers.get(String(name).toLowerCase()) || null,
      set: (name, value) =>
        headers.set(String(name).toLowerCase(), String(value)),
    },
    cookies: {
      set: (...args) => cookies.push(args.length === 1 ? args[0] : args),
      getAll: () => [...cookies],
      values: cookies,
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (payload, init) => createResponse(payload, init) },
}));

const { POST } = require("../../app/api/auth/intent/route.js");

const makeRequest = (payload, { origin = "https://www.rooindustries.com" } = {}) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    url: "https://www.rooindustries.com/api/auth/intent",
    headers: {
      get: (name) => {
        const normalized = String(name).toLowerCase();
        if (normalized === "origin") return origin;
        if (normalized === "content-type") return "application/json";
        if (normalized === "content-length") return String(Buffer.byteLength(body));
        return "";
      },
    },
    text: async () => body,
  };
};

describe("Supabase OAuth intent route", () => {
  afterAll(() => {
    if (originalTourneyDatabaseMode === undefined) {
      delete process.env.TOURNEY_DATABASE_MODE;
    } else {
      process.env.TOURNEY_DATABASE_MODE = originalTourneyDatabaseMode;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TOURNEY_DATABASE_MODE = "supabase";
    mockClearNextSupabaseSession.mockResolvedValue(undefined);
    mockConsumeAuthRateLimit.mockResolvedValue({ allowed: true, retryAfter: 60 });
    mockReadReauthToken.mockReturnValue("recent-auth-token");
    mockReadRecovery.mockReturnValue(null);
    mockMatchesRecovery.mockReturnValue(false);
    mockCreateOAuthIntent.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      token: "opaque-one-time-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  test("rejects cross-origin intent creation", async () => {
    const response = await POST(
      makeRequest(
        { action: "signin", flow: "tourney", provider: "google" },
        { origin: "https://attacker.example" }
      )
    );

    expect(response.status).toBe(403);
    expect(mockCreateOAuthIntent).not.toHaveBeenCalled();
  });

  test.each([undefined, "   "])(
    "treats an unset or blank Tourney database mode as legacy",
    async (mode) => {
      if (mode === undefined) {
        delete process.env.TOURNEY_DATABASE_MODE;
      } else {
        process.env.TOURNEY_DATABASE_MODE = mode;
      }

      const response = await POST(
        makeRequest({ action: "signin", flow: "tourney", provider: "google" })
      );
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.code).toBe("TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE");
      expect(mockCreateOAuthIntent).not.toHaveBeenCalled();
    }
  );

  test("requires the exact custom and Supabase session before linking", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue(null);
    const response = await POST(
      makeRequest({ action: "link", flow: "tourney", provider: "discord" })
    );

    expect(response.status).toBe(409);
    expect(mockCreateOAuthIntent).not.toHaveBeenCalled();
  });

  test("binds link intents to the exact Auth user and domain subject", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: { principal_id: "d52be0ea-ec6b-47dd-9373-4e30c9dcc6a1" },
      domainSubject: "approved-player",
      user: { id: "e71a5687-daa6-4371-9700-5aef798fdd03" },
    });
    const response = await POST(
      makeRequest({
        action: "link",
        flow: "tourney",
        provider: "discord",
        returnPath: "/tourney",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.callbackUrl).toBe(
      "https://www.rooindustries.com/auth/callback?intent=11111111-1111-4111-8111-111111111111"
    );
    expect(body).not.toHaveProperty("token");
    expect(mockCreateOAuthIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "link",
        domainSubject: "approved-player",
        reauthToken: "recent-auth-token",
        targetUserId: "e71a5687-daa6-4371-9700-5aef798fdd03",
      })
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_oauth_intent.11111111-1111-4111-8111-111111111111",
        httpOnly: true,
      })
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({ name: "roo_reauth_grant", maxAge: 0 })
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("allows reauthentication only through an already-linked provider", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        connected_providers: ["email", "google"],
        principal_id: "d52be0ea-ec6b-47dd-9373-4e30c9dcc6a1",
      },
      domainSubject: "creator-one",
      user: { id: "e71a5687-daa6-4371-9700-5aef798fdd03" },
    });
    const rejected = await POST(
      makeRequest({
        action: "reauth",
        flow: "referral",
        provider: "discord",
        reauthPurpose: "link_identity",
      })
    );
    expect(rejected.status).toBe(409);
    expect(mockCreateOAuthIntent).not.toHaveBeenCalled();

    const accepted = await POST(
      makeRequest({
        action: "reauth",
        flow: "referral",
        provider: "google",
        reauthPurpose: "link_identity",
      })
    );
    expect(accepted.status).toBe(200);
    expect(mockCreateOAuthIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reauth",
        provider: "google",
        reauthPurpose: "link_identity",
      })
    );
  });

  test("rejects the unfinished OAuth merge action", async () => {
    const response = await POST(
      makeRequest({ action: "merge", flow: "referral", provider: "google" })
    );
    expect(response.status).toBe(400);
    expect(mockCreateOAuthIntent).not.toHaveBeenCalled();
  });

  test("creates referral recovery only from the signed conflict proof", async () => {
    const recovery = {
      originalIntentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: "d52be0ea-ec6b-47dd-9373-4e30c9dcc6a1",
      provider: "discord",
      targetUserId: "e71a5687-daa6-4371-9700-5aef798fdd03",
    };
    const domainIdentity = {
      account: {
        connected_providers: ["email"],
        creator_active: true,
        principal_id: recovery.principalId,
        roles: ["creator"],
        status: "active",
      },
      domainSubject: "creator-one",
      user: { id: recovery.targetUserId },
    };
    mockResolveExactDomainIdentity.mockResolvedValue(domainIdentity);
    mockReadRecovery.mockReturnValue(recovery);
    mockMatchesRecovery.mockReturnValue(true);

    const response = await POST(
      makeRequest({
        action: "reclaim",
        flow: "referral",
        provider: "discord",
        returnPath: "/referrals/dashboard",
      })
    );

    expect(response.status).toBe(200);
    expect(mockMatchesRecovery).toHaveBeenCalledWith({
      account: domainIdentity.account,
      recovery,
      user: domainIdentity.user,
    });
    expect(mockCreateOAuthIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reclaim",
        flow: "referral",
        provider: "discord",
        recoveryForIntentId: recovery.originalIntentId,
        reauthToken: "recent-auth-token",
        targetUserId: recovery.targetUserId,
      })
    );
  });

  test("uses separate cookies for concurrent tab intents", async () => {
    mockCreateOAuthIntent
      .mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        token: "first-token",
      })
      .mockResolvedValueOnce({
        id: "22222222-2222-4222-8222-222222222222",
        token: "second-token",
      });

    const first = await POST(
      makeRequest({ action: "signup", flow: "referral", provider: "google" })
    );
    const second = await POST(
      makeRequest({ action: "signup", flow: "tourney", provider: "discord" })
    );

    expect(first.cookies.values.at(-1).name).toContain("11111111");
    expect(second.cookies.values.at(-1).name).toContain("22222222");
    expect(mockClearNextSupabaseSession).toHaveBeenCalledTimes(2);
  });
});

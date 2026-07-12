const mockExchangeCodeForSession = jest.fn();
const mockClearNextSupabaseSession = jest.fn();
const mockBootstrapSupabaseNativeAccount = jest.fn();
const mockResolveSupabaseAccountByUserId = jest.fn();
const mockReadOAuthIntent = jest.fn();
const mockFinalizeOAuthIntent = jest.fn();
const mockSyncDiscordRole = jest.fn();
const mockCreateReferralSessionCookie = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();

jest.mock("../server/supabase/serverSession", () => ({
  clearNextSupabaseSession: (...args) => mockClearNextSupabaseSession(...args),
  createNextSupabaseSessionClient: () => ({
    auth: { exchangeCodeForSession: (...args) => mockExchangeCodeForSession(...args) },
  }),
}));

jest.mock("../server/supabase/accounts", () => ({
  bootstrapSupabaseNativeAccount: (...args) => mockBootstrapSupabaseNativeAccount(...args),
  resolveSupabaseAccountByUserId: (...args) => mockResolveSupabaseAccountByUserId(...args),
}));

jest.mock("../server/supabase/oauthIntents", () => ({
  OAUTH_INTENT_COOKIE: "roo_oauth_intent",
  oauthIntentCookieName: (id) => `roo_oauth_intent.${id}`,
  clearOAuthIntentCookie: (id) => ({
    name: id ? `roo_oauth_intent.${id}` : "roo_oauth_intent",
    value: "",
    maxAge: 0,
    path: "/auth/callback",
  }),
  readOAuthIntent: (...args) => mockReadOAuthIntent(...args),
  finalizeOAuthIntent: (...args) => mockFinalizeOAuthIntent(...args),
}));

jest.mock("../server/tourney/discordRoleSync", () => ({
  syncTourneyDiscordRoleAssignment: (...args) => mockSyncDiscordRole(...args),
}));

jest.mock("../server/api/ref/auth", () => ({
  REF_SESSION_COOKIE: "ref_session",
  createReferralSessionCookie: (...args) => mockCreateReferralSessionCookie(...args),
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  createTourneySessionToken: (...args) => mockCreateTourneySessionToken(...args),
  getTourneyCookieOptions: (...args) => mockGetTourneyCookieOptions(...args),
}));

const createResponse = (url, init = {}) => {
  const headerValues = new Map([["location", String(url)]]);
  const cookieValues = [];
  return {
    status: init.status || 307,
    get url() {
      return headerValues.get("location") || "";
    },
    cookies: {
      set: (...args) => cookieValues.push(args.length === 1 ? args[0] : args),
      getAll: () => cookieValues,
      values: cookieValues,
    },
    headers: {
      get: (name) => headerValues.get(String(name).toLowerCase()) || null,
      set: (name, value) => headerValues.set(String(name).toLowerCase(), String(value)),
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { redirect: (url, init) => createResponse(url, init) },
}));

const { GET } = require("../../app/auth/callback/route.js");

const intentId = "11111111-1111-4111-8111-111111111111";
const authUser = {
  id: "e71a5687-daa6-4371-9700-5aef798fdd03",
  email: "creator@example.com",
  email_confirmed_at: "2026-07-11T00:00:00.000Z",
};

const request = (url, cookie = "") => ({
  url,
  cookies: {
    get: (name) => {
      const found = cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
      return found ? { value: found.slice(name.length + 1) } : undefined;
    },
  },
  headers: {
    get: (name) => (String(name).toLowerCase() === "cookie" ? cookie : ""),
  },
});

const creatorAccount = {
  user_id: authUser.id,
  status: "active",
  roles: ["creator"],
  legacy_sanity_id: "referral.creator",
  referral_code: "creator",
};

describe("Supabase Auth callback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExchangeCodeForSession.mockResolvedValue({
      data: {
        session: { access_token: "not-returned", provider_token: "transient-provider-token" },
        user: authUser,
      },
      error: null,
    });
    mockClearNextSupabaseSession.mockResolvedValue(undefined);
    mockBootstrapSupabaseNativeAccount.mockResolvedValue({ user_id: authUser.id });
    mockCreateReferralSessionCookie.mockReturnValue({
      name: "ref_session",
      value: "ref-token",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    mockCreateTourneySessionToken.mockReturnValue("tourney-token");
    mockGetTourneyCookieOptions.mockReturnValue({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    mockSyncDiscordRole.mockResolvedValue({ applied: true, desiredRole: "participant" });
  });

  test("keeps a short compatibility path but resolves the exact Auth user id", async () => {
    mockResolveSupabaseAccountByUserId.mockResolvedValue(creatorAccount);
    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&flow=referral&next=%2Freferrals%2Fdashboard"
      )
    );
    expect(response.url).toBe("https://www.rooindustries.com/referrals/dashboard");
    expect(mockResolveSupabaseAccountByUserId).toHaveBeenCalledWith({
      userId: authUser.id,
    });
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({ name: "ref_session", value: "ref-token" })
    );
  });

  test("does not authorize an email match owned by another Auth user", async () => {
    mockResolveSupabaseAccountByUserId.mockResolvedValue(null);
    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&flow=referral"
      )
    );
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/login?oauth=unlinked"
    );
    expect(response.cookies.values).not.toContainEqual(
      expect.objectContaining({ value: "ref-token" })
    );
  });

  test("finishes a social signup from the one-time server intent", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "signup",
      flow: "referral",
      provider: "google",
      return_path: "/referrals/register",
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "signup",
      flow: "referral",
      provider: "google",
      return_path: "/referrals/register",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(null);

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );
    expect(mockFinalizeOAuthIntent).toHaveBeenCalledWith({
      guildId: "",
      provider: "google",
      token: "opaque-token",
      userId: authUser.id,
    });
    expect(mockBootstrapSupabaseNativeAccount).toHaveBeenCalledWith({
      userId: authUser.id,
    });
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/register?oauth=ready&provider=google"
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("links Discord only to the exact signed-in Tourney account and syncs its role", async () => {
    const tourneyAccount = {
      user_id: authUser.id,
      status: "active",
      roles: ["tourney_player"],
      tourney_username: "player-one",
      tourney_role: "tourney_player",
      tourney_active: true,
      credential_version: "3",
    };
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(tourneyAccount);

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );
    expect(mockCreateTourneySessionToken).toHaveBeenCalledWith({
      account: {
        authBackend: "supabase",
        role: "player",
        username: "player-one",
        version: "3",
      },
    });
    expect(mockSyncDiscordRole).toHaveBeenCalledWith({
      accessToken: "transient-provider-token",
      userId: authUser.id,
    });
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney?linked=discord"
    );
  });

  test("rejects expired intent replay before exchanging the provider code", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      status: "completed",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/login?error=expired_intent"
    );
  });

  test("preserves the current domain and Supabase sessions when linking is cancelled", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&error=access_denied`,
        `roo_oauth_intent.${intentId}=opaque-token; tourney_session=existing-session`
      )
    );
    expect(mockClearNextSupabaseSession).not.toHaveBeenCalled();
    expect(response.cookies.values).not.toContainEqual(
      expect.objectContaining({ name: "tourney_session", maxAge: 0 })
    );
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/login?error=missing_code"
    );
  });

  test("rejects a mismatched intent id without consuming the OAuth code", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      action: "signin",
      flow: "referral",
      provider: "google",
      return_path: "/referrals/dashboard",
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.url).toBe(
      "https://www.rooindustries.com/?auth_error=invalid_intent"
    );
  });
});

const mockExchangeCodeForSession = jest.fn();
const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockClearNextSupabaseSession = jest.fn();
const mockInstallNextSupabaseSession = jest.fn();
const mockBootstrapSupabaseNativeAccount = jest.fn();
const mockResolveSupabaseAccountByUserId = jest.fn();
const mockReadOAuthIntent = jest.fn();
const mockFinalizeOAuthIntent = jest.fn();
const mockFailOAuthIntent = jest.fn();
const mockCreateOrphanReclaimCookie = jest.fn();
const mockClearOrphanReclaimCookie = jest.fn();
const mockReclaimOrphanIdentity = jest.fn();
const mockQueueDiscordProjection = jest.fn();
const mockResolveQueuedDiscordProjection = jest.fn();
const mockCreateReferralSessionCookie = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();
const originalTourneyDatabaseMode = process.env.TOURNEY_DATABASE_MODE;

jest.mock("../server/supabase/serverSession", () => ({
  clearNextSupabaseSession: (...args) => mockClearNextSupabaseSession(...args),
  createNextSupabaseSessionClient: () => ({
    auth: {
      exchangeCodeForSession: (...args) => mockExchangeCodeForSession(...args),
      getSession: (...args) => mockGetSession(...args),
      getUser: (...args) => mockGetUser(...args),
    },
  }),
  installNextSupabaseSession: (...args) => mockInstallNextSupabaseSession(...args),
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
  failOAuthIntent: (...args) => mockFailOAuthIntent(...args),
  finalizeOAuthIntent: (...args) => mockFinalizeOAuthIntent(...args),
}));

jest.mock("../server/supabase/orphanIdentityReclaim", () => ({
  clearReferralOrphanReclaimCookie: (...args) =>
    mockClearOrphanReclaimCookie(...args),
  createReferralOrphanReclaimCookie: (...args) =>
    mockCreateOrphanReclaimCookie(...args),
  reclaimReferralOrphanIdentity: (...args) => mockReclaimOrphanIdentity(...args),
}));

jest.mock("../server/tourney/discordDesiredState", () => ({
  queueTourneyDiscordAuthProjection: (...args) => mockQueueDiscordProjection(...args),
  resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure: (...args) =>
    mockResolveQueuedDiscordProjection(...args),
}), { virtual: true });

jest.mock("../server/api/ref/auth", () => ({
  REF_SESSION_COOKIE: "ref_session",
  createReferralSessionCookie: (...args) => mockCreateReferralSessionCookie(...args),
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  createTourneySessionToken: (...args) => mockCreateTourneySessionToken(...args),
  getTourneyCookieOptions: (...args) => mockGetTourneyCookieOptions(...args),
}), { virtual: true });

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
  principal_id: "10000000-0000-4000-8000-000000000001",
  status: "active",
  roles: ["creator"],
  legacy_sanity_id: "referral.creator",
  referral_code: "creator",
  session_version: 7,
};

describe("Supabase Auth callback", () => {
  beforeEach(() => {
    process.env.TOURNEY_DATABASE_MODE = "supabase";
    jest.clearAllMocks();
    mockExchangeCodeForSession.mockResolvedValue({
      data: {
        session: { access_token: "not-returned", provider_token: "transient-provider-token" },
        user: authUser,
      },
      error: null,
    });
    mockClearNextSupabaseSession.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: "primary-access-token",
          refresh_token: "primary-refresh-token",
        },
      },
      error: null,
    });
    mockGetUser.mockResolvedValue({ data: { user: authUser }, error: null });
    mockInstallNextSupabaseSession.mockResolvedValue(true);
    mockFailOAuthIntent.mockResolvedValue({ failed: true });
    mockCreateOrphanReclaimCookie.mockReturnValue({
      name: "roo_referral_orphan_identity_reclaim",
      value: "signed-recovery",
      httpOnly: true,
      maxAge: 900,
      path: "/",
    });
    mockClearOrphanReclaimCookie.mockReturnValue({
      name: "roo_referral_orphan_identity_reclaim",
      value: "",
      maxAge: 0,
      path: "/",
    });
    mockReclaimOrphanIdentity.mockResolvedValue({ reclaimed: true });
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
    mockQueueDiscordProjection.mockResolvedValue({ applied: true, reason: "applied" });
    mockResolveQueuedDiscordProjection.mockResolvedValue({
      finalized: false,
      resolved: true,
    });
  });

  afterAll(() => {
    if (originalTourneyDatabaseMode === undefined) {
      delete process.env.TOURNEY_DATABASE_MODE;
    } else {
      process.env.TOURNEY_DATABASE_MODE = originalTourneyDatabaseMode;
    }
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
    expect(mockCreateReferralSessionCookie).toHaveBeenCalledWith({
      authBackend: "supabase",
      code: "creator",
      principalId: "10000000-0000-4000-8000-000000000001",
      referralId: "referral.creator",
      sessionVersion: 7,
    });
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



  test("allows Discord reauthentication through another Auth user on the same principal", async () => {
    const claimedUser = {
      ...authUser,
      id: "f82a6798-ebb7-4482-a811-6bff809fee14",
    };
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "reauth",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockExchangeCodeForSession.mockResolvedValue({
      data: {
        session: { provider_token: "transient-provider-token" },
        user: claimedUser,
      },
      error: null,
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "reauth",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(creatorAccount);

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockFinalizeOAuthIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: claimedUser.id,
    }));
    expect(mockQueueDiscordProjection).not.toHaveBeenCalled();
    expect(response.url).toBe("https://www.rooindustries.com/referrals/dashboard?reauth=ready");
  });











  test("keeps the linked referral Discord sign-in path unchanged", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "signin",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
      target_user_id: null,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "signin",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(creatorAccount);

    const response = await GET(request(
      `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
      `roo_oauth_intent.${intentId}=opaque-token`
    ));

    expect(response.url).toBe("https://www.rooindustries.com/referrals/dashboard");
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({ name: "ref_session", value: "ref-token" })
    );
    expect(mockClearNextSupabaseSession).not.toHaveBeenCalled();
  });

  test("preserves an unlinked referral Discord session for the account choice", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "signin",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
      target_user_id: null,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "signin",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(null);

    const response = await GET(request(
      `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
      `roo_oauth_intent.${intentId}=opaque-token`
    ));

    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/login?oauth=unlinked&provider=discord"
    );
    expect(mockClearNextSupabaseSession).not.toHaveBeenCalled();
    expect(response.cookies.values).not.toContainEqual(
      expect.objectContaining({ name: "ref_session" })
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: `roo_oauth_intent.${intentId}`,
        maxAge: 0,
      })
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_pending_discord_link",
        httpOnly: true,
        maxAge: 15 * 60,
        path: "/",
        sameSite: "lax",
        value: expect.any(String),
      })
    );
  });

  test("preserves an unlinked referral Google session for the account choice", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "signin",
      flow: "referral",
      provider: "google",
      return_path: "/referrals/dashboard",
      target_user_id: null,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "signin",
      flow: "referral",
      provider: "google",
      return_path: "/referrals/dashboard",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(null);

    const response = await GET(request(
      `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
      `roo_oauth_intent.${intentId}=opaque-token`
    ));

    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/login?oauth=unlinked&provider=google"
    );
    expect(response.cookies.values).toContainEqual(
      expect.objectContaining({
        name: "roo_pending_google_link",
        httpOnly: true,
        maxAge: 15 * 60,
        path: "/",
        sameSite: "lax",
        value: expect.any(String),
      })
    );
  });









  test("clears the newly exchanged Supabase session on a Discord link mismatch", async () => {
    const wrongUser = { ...authUser, id: "22222222-2222-4222-8222-222222222222" };
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { provider_token: "transient" }, user: wrongUser },
      error: null,
    });

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token; ref_session=existing-session`
      )
    );

    expect(mockClearNextSupabaseSession).toHaveBeenCalledTimes(1);
    expect(response.cookies.values).not.toContainEqual(
      expect.objectContaining({ name: "ref_session", maxAge: 0 })
    );
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/login?oauth=unlinked"
    );
  });

  test("rejects expired intent replay before exchanging the provider code", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
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
      "https://www.rooindustries.com/referrals/login?oauth=expired_intent"
    );
  });

  test("surfaces identity_already_exists and starts controlled referral recovery", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "referral",
      provider: "discord",
      principal_id: "10000000-0000-4000-8000-000000000001",
      return_path: "/referrals/dashboard",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked+to+another+user`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockFailOAuthIntent).toHaveBeenCalledWith({
      failureCode: "identity_already_exists",
      intentId,
      token: "opaque-token",
    });
    expect(mockCreateOrphanReclaimCookie).toHaveBeenCalledWith({
      originalIntentId: intentId,
      principalId: "10000000-0000-4000-8000-000000000001",
      provider: "discord",
      targetUserId: authUser.id,
    });
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/dashboard?oauth=identity_already_exists&provider=discord"
    );
    expect(response.url).not.toContain("missing_code");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  test("reclaims a proven provider-only orphan and restores the creator session", async () => {
    const orphanUser = {
      ...authUser,
      id: "394cef15-efb8-4ad3-bce5-280e91f01dbf",
    };
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "reclaim",
      flow: "referral",
      provider: "discord",
      principal_id: "10000000-0000-4000-8000-000000000001",
      return_path: "/referrals/dashboard",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockExchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "orphan-access-token",
          provider_token: "discord-provider-token",
          refresh_token: "orphan-refresh-token",
        },
        user: orphanUser,
      },
      error: null,
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(creatorAccount);

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockReclaimOrphanIdentity).toHaveBeenCalledWith({
      orphanUserId: orphanUser.id,
      provider: "discord",
      token: "opaque-token",
    });
    expect(mockInstallNextSupabaseSession).toHaveBeenCalledWith({
      request: expect.any(Object),
      response: expect.any(Object),
      session: {
        access_token: "primary-access-token",
        refresh_token: "primary-refresh-token",
      },
    });
    expect(mockFinalizeOAuthIntent).not.toHaveBeenCalled();
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/dashboard?linked=discord&reclaimed=1"
    );
  });

  test("never links an identity when the guarded owner is active", async () => {
    const activeOwner = {
      ...authUser,
      id: "22222222-2222-4222-8222-222222222222",
    };
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "reclaim",
      flow: "referral",
      provider: "google",
      principal_id: "10000000-0000-4000-8000-000000000001",
      return_path: "/referrals/dashboard",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockExchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "active-owner-access-token",
          refresh_token: "active-owner-refresh-token",
        },
        user: activeOwner,
      },
      error: null,
    });
    mockReclaimOrphanIdentity.mockResolvedValue({
      reclaimed: false,
      reason: "active_account",
    });

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockReclaimOrphanIdentity).toHaveBeenCalledTimes(1);
    expect(mockResolveSupabaseAccountByUserId).not.toHaveBeenCalled();
    expect(mockFinalizeOAuthIntent).not.toHaveBeenCalled();
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/dashboard?oauth=identity_owned_by_active_account&provider=google"
    );
  });

  test("preserves the current domain and Supabase sessions when linking is cancelled", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "referral",
      provider: "discord",
      return_path: "/referrals/dashboard",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&error=access_denied`,
        `roo_oauth_intent.${intentId}=opaque-token; ref_session=existing-session`
      )
    );
    expect(mockClearNextSupabaseSession).not.toHaveBeenCalled();
    expect(response.cookies.values).not.toContainEqual(
      expect.objectContaining({ name: "ref_session", maxAge: 0 })
    );
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/login?oauth=access_denied"
    );
    expect(mockFailOAuthIntent).toHaveBeenCalledWith({
      failureCode: "access_denied",
      intentId,
      token: "opaque-token",
    });
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

  test("referral Discord sign-in does not depend on tournament jobs for a dual-role principal", async () => {
    process.env.TOURNEY_DATABASE_MODE = "legacy";
    mockQueueDiscordProjection.mockRejectedValue(new Error("Tournament database removed"));
    mockReadOAuthIntent.mockResolvedValue({ id: intentId, action: "signin", flow: "referral", provider: "discord", return_path: "/referrals/dashboard", target_user_id: null, status: "pending", expires_at: "2099-01-01T00:00:00.000Z" });
    mockFinalizeOAuthIntent.mockResolvedValue({ action: "signin", flow: "referral", provider: "discord", return_path: "/referrals/dashboard" });
    mockResolveSupabaseAccountByUserId.mockResolvedValue({ ...creatorAccount, roles: ["creator", "tourney_player"], tourney_active: false });
    const response = await GET(request(`https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`, `roo_oauth_intent.${intentId}=opaque-token`));
    expect(response.url).toBe("https://www.rooindustries.com/referrals/dashboard");
    expect(response.cookies.values).toContainEqual(expect.objectContaining({ name: "ref_session", value: "ref-token" }));
    expect(mockFinalizeOAuthIntent).toHaveBeenCalledTimes(1);
    expect(mockQueueDiscordProjection).not.toHaveBeenCalled();
  });
  test("rejects a stored tournament OAuth intent before consuming the provider code", async () => {
    mockReadOAuthIntent.mockResolvedValue({ id: intentId, flow: "tourney", action: "signin", status: "pending", expires_at: "2099-01-01T00:00:00.000Z" });
    const response = await GET(request(`https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one&flow=referral`, `roo_oauth_intent.${intentId}=opaque-token`));
    expect(response.url).toContain("invalid_intent");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockFinalizeOAuthIntent).not.toHaveBeenCalled();
  });
});

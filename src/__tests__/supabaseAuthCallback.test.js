const mockExchangeCodeForSession = jest.fn();
const mockClearNextSupabaseSession = jest.fn();
const mockBootstrapSupabaseNativeAccount = jest.fn();
const mockResolveSupabaseAccountByUserId = jest.fn();
const mockReadOAuthIntent = jest.fn();
const mockFinalizeOAuthIntent = jest.fn();
const mockQueueDiscordProjection = jest.fn();
const mockResolveQueuedDiscordProjection = jest.fn();
const mockCreateReferralSessionCookie = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();
const originalTourneyDatabaseMode = process.env.TOURNEY_DATABASE_MODE;

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

jest.mock("../server/tourney/discordDesiredState", () => ({
  queueTourneyDiscordAuthProjection: (...args) => mockQueueDiscordProjection(...args),
  resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure: (...args) =>
    mockResolveQueuedDiscordProjection(...args),
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
      target_user_id: authUser.id,
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
    const projectionCommandId = `discord-oauth:${intentId}:${authUser.id}`;
    expect(mockQueueDiscordProjection).toHaveBeenNthCalledWith(1, {
      accountUserId: authUser.id,
      accessToken: "transient-provider-token",
      attemptExternalWork: false,
      claimedUserId: authUser.id,
      commandId: projectionCommandId,
      deferUntil: "2099-01-01T00:00:00.000Z",
      intentId,
      userId: authUser.id,
    });
    expect(mockQueueDiscordProjection).toHaveBeenNthCalledWith(2, {
      accountUserId: authUser.id,
      accessToken: "transient-provider-token",
      attemptExternalWork: true,
      claimedUserId: authUser.id,
      commandId: projectionCommandId,
      deferUntil: "2099-01-01T00:00:00.000Z",
      intentId,
      userId: authUser.id,
    });
    expect(mockQueueDiscordProjection.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockExchangeCodeForSession.mock.invocationCallOrder[0]
    );
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney?linked=discord"
    );
  });

  test("allows Discord reauthentication through another Auth user on the same principal", async () => {
    const claimedUser = {
      ...authUser,
      id: "f82a6798-ebb7-4482-a811-6bff809fee14",
    };
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
      action: "reauth",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
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

    expect(mockFinalizeOAuthIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: claimedUser.id,
    }));
    expect(mockQueueDiscordProjection).toHaveBeenLastCalledWith(expect.objectContaining({
      accessToken: "transient-provider-token",
      intentId,
      userId: authUser.id,
    }));
    expect(response.url).toBe("https://www.rooindustries.com/tourney?reauth=ready");
  });

  test("durably queues a targetless Tourney Discord sign-in for the exchanged user", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "signin",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      target_user_id: null,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "signin",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue({
      user_id: authUser.id,
      status: "active",
      roles: ["tourney_player"],
      tourney_username: "player-one",
      tourney_role: "tourney_player",
      tourney_active: true,
      credential_version: "3",
    });

    await GET(request(
      `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
      `roo_oauth_intent.${intentId}=opaque-token`
    ));

    expect(mockQueueDiscordProjection).toHaveBeenCalledTimes(2);
    expect(mockQueueDiscordProjection).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        accountUserId: authUser.id,
        claimedUserId: authUser.id,
        userId: authUser.id,
        attemptExternalWork: false,
      })
    );
    expect(mockQueueDiscordProjection.mock.invocationCallOrder[0]).toBeLessThan(
      mockFinalizeOAuthIntent.mock.invocationCallOrder[0]
    );
  });

  test("keeps a Tourney Discord signup deferred until its Auth projection exists", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "signup",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney/register",
      target_user_id: null,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockResolvedValue({
      action: "signup",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney/register",
    });
    mockResolveSupabaseAccountByUserId.mockResolvedValue(null);

    const response = await GET(request(
      `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
      `roo_oauth_intent.${intentId}=opaque-token`
    ));

    expect(mockQueueDiscordProjection).toHaveBeenCalledTimes(1);
    expect(mockQueueDiscordProjection).toHaveBeenCalledWith(expect.objectContaining({
      accountUserId: authUser.id,
      claimedUserId: authUser.id,
      attemptExternalWork: false,
      deferUntil: "2099-01-01T00:00:00.000Z",
    }));
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/register?oauth=ready&provider=discord&discord_role=pending"
    );
  });

  test("queues Discord from referral flows so dual-role principals reconcile", async () => {
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
    mockResolveSupabaseAccountByUserId.mockResolvedValue({
      ...creatorAccount,
      roles: ["creator", "tourney_player"],
    });

    await GET(request(
      `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
      `roo_oauth_intent.${intentId}=opaque-token`
    ));

    expect(mockQueueDiscordProjection).toHaveBeenCalledTimes(2);
    expect(mockQueueDiscordProjection).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountUserId: authUser.id, claimedUserId: authUser.id })
    );
  });

  test("does not consume Discord OAuth until the Tourney projection is durable", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockQueueDiscordProjection.mockRejectedValueOnce(new Error("queue unavailable"));

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(mockFinalizeOAuthIntent).not.toHaveBeenCalled();
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/login?error=unavailable"
    );
  });

  test("does not consume Discord OAuth when projection cannot be queued", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockQueueDiscordProjection.mockResolvedValueOnce({
      applied: false,
      reason: "oauth_temporarily_unavailable",
    });

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/login?error=unavailable"
    );
  });

  test.each(["pending", "not_linked", "not_configured"])(
    "accepts a benign pre-finalize Discord projection result: %s",
    async (reason) => {
      mockReadOAuthIntent.mockResolvedValue({
        id: intentId,
        action: "link",
        flow: "tourney",
        provider: "discord",
        return_path: "/tourney",
        target_user_id: authUser.id,
        status: "pending",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
      mockFinalizeOAuthIntent.mockResolvedValue({
        action: "link",
        flow: "tourney",
        provider: "discord",
        return_path: "/tourney",
      });
      mockResolveSupabaseAccountByUserId.mockResolvedValue({
        user_id: authUser.id,
        status: "active",
        roles: ["tourney_player"],
        tourney_username: "player-one",
        tourney_role: "tourney_player",
        tourney_active: true,
        credential_version: "3",
      });
      mockQueueDiscordProjection
        .mockResolvedValueOnce({ applied: false, reason })
        .mockResolvedValueOnce({ applied: true, reason: "applied" });

      const response = await GET(request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      ));

      expect(mockFinalizeOAuthIntent).toHaveBeenCalledTimes(1);
      expect(response.url).toBe(
        "https://www.rooindustries.com/tourney?linked=discord"
      );
    }
  );

  test("resolves the durable Discord projection when finalization fails", async () => {
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
      target_user_id: authUser.id,
      status: "pending",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    mockFinalizeOAuthIntent.mockRejectedValue(new Error("finalize unavailable"));

    const response = await GET(
      request(
        `https://www.rooindustries.com/auth/callback?intent=${intentId}&code=one`,
        `roo_oauth_intent.${intentId}=opaque-token`
      )
    );

    expect(mockResolveQueuedDiscordProjection).toHaveBeenCalledWith({
      claimedUserId: authUser.id,
      commandId: `discord-oauth:${intentId}:${authUser.id}`,
      intentId,
      userId: authUser.id,
    });
    expect(mockQueueDiscordProjection).toHaveBeenCalledTimes(1);
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/login?error=unavailable"
    );
  });

  test("clears the newly exchanged Supabase session on a Discord link mismatch", async () => {
    const wrongUser = { ...authUser, id: "22222222-2222-4222-8222-222222222222" };
    mockReadOAuthIntent.mockResolvedValue({
      id: intentId,
      action: "link",
      flow: "tourney",
      provider: "discord",
      return_path: "/tourney",
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
        `roo_oauth_intent.${intentId}=opaque-token; tourney_session=existing-session`
      )
    );

    expect(mockClearNextSupabaseSession).toHaveBeenCalledTimes(1);
    expect(response.cookies.values).not.toContainEqual(
      expect.objectContaining({ name: "tourney_session", maxAge: 0 })
    );
    expect(response.url).toBe(
      "https://www.rooindustries.com/tourney/login?error=unlinked"
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
      target_user_id: authUser.id,
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

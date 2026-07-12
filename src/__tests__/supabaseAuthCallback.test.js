const mockExchangeCodeForSession = jest.fn();
const mockBootstrapSupabaseNativeAccount = jest.fn();
const mockResolveSupabaseAccountAlias = jest.fn();
const mockCreateReferralSessionCookie = jest.fn();
const mockCreateTourneySessionToken = jest.fn();
const mockGetTourneyCookieOptions = jest.fn();

const mockCreateServerClient = jest.fn((_url, _key, options) => ({
  auth: {
    exchangeCodeForSession: async (code) => {
      options.cookies.setAll(
        [
          {
            name: "sb-session",
            value: "encoded-session",
            options: { httpOnly: true, path: "/", sameSite: "lax" },
          },
        ],
        {
          "Cache-Control":
            "private, no-cache, no-store, must-revalidate, max-age=0",
          Expires: "0",
          Pragma: "no-cache",
        }
      );
      return mockExchangeCodeForSession(code);
    },
  },
}));

jest.mock("@supabase/ssr", () => ({
  createServerClient: (...args) => mockCreateServerClient(...args),
}));

jest.mock("../server/supabase/accounts", () => ({
  bootstrapSupabaseNativeAccount: (...args) =>
    mockBootstrapSupabaseNativeAccount(...args),
  resolveSupabaseAccountAlias: (...args) =>
    mockResolveSupabaseAccountAlias(...args),
}));

jest.mock("../server/api/ref/auth", () => ({
  createReferralSessionCookie: (...args) =>
    mockCreateReferralSessionCookie(...args),
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  createTourneySessionToken: (...args) => mockCreateTourneySessionToken(...args),
  getTourneyCookieOptions: (...args) => mockGetTourneyCookieOptions(...args),
}));

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url, init = {}) => {
      const headers = new Map();
      const cookies = [];
      return {
        status: init.status || 307,
        url: String(url),
        cookies: { set: (...args) => cookies.push(args), values: cookies },
        headers: {
          get: (name) => headers.get(String(name).toLowerCase()) || null,
          set: (name, value) => headers.set(String(name).toLowerCase(), value),
        },
      };
    },
  },
}));

const { GET } = require("../../app/auth/callback/route.js");

const request = (url, cookie = "") => ({
  url,
  headers: {
    get: (name) => (String(name).toLowerCase() === "cookie" ? cookie : ""),
  },
});

const authUser = {
  id: "e71a5687-daa6-4371-9700-5aef798fdd03",
  email: "creator@example.com",
  email_confirmed_at: "2026-07-11T00:00:00.000Z",
};

describe("Supabase Auth callback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-key",
    };
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "not-returned" }, user: authUser },
      error: null,
    });
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
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("rejects a backslash-based cross-origin redirect", async () => {
    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&next=%2F%5Cevil.example"
      )
    );

    expect(response.url).toBe("https://www.rooindustries.com/");
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("one");
  });

  test("preserves root-scoped PKCE cookies and no-cache headers", async () => {
    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one",
        "pkce=value%2Ewith%2Eencoding"
      )
    );

    expect(response.cookies.values[0]).toEqual([
      "sb-session",
      "encoded-session",
      { httpOnly: true, path: "/", sameSite: "lax" },
    ]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(mockCreateServerClient.mock.calls[0][2].cookies.getAll()).toEqual([
      { name: "pkce", value: "value.with.encoding" },
    ]);
  });

  test("creates a referral session only for a linked creator", async () => {
    mockResolveSupabaseAccountAlias.mockResolvedValue({
      user_id: authUser.id,
      status: "active",
      roles: ["creator"],
      legacy_sanity_id: "referral.creator",
      referral_code: "creator",
    });

    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&flow=referral&next=%2Freferrals%2Fdashboard"
      )
    );

    expect(response.url).toBe("https://www.rooindustries.com/referrals/dashboard");
    expect(response.cookies.values).toHaveLength(2);
    expect(response.cookies.values[1][0]).toMatchObject({
      name: "ref_session",
      value: "ref-token",
    });
    expect(mockResolveSupabaseAccountAlias).toHaveBeenCalledWith({
      identifier: "creator@example.com",
      accountScope: "default",
    });
    expect(mockBootstrapSupabaseNativeAccount).toHaveBeenCalledWith({
      userId: authUser.id,
    });
  });

  test("uses a verified email mapping for a Tourney OAuth login", async () => {
    mockResolveSupabaseAccountAlias.mockResolvedValue({
      user_id: "5dd0c70d-e0d8-4ad2-99f1-67a320e600a4",
      status: "active",
      roles: ["tourney_player"],
      tourney_username: "player-one",
      tourney_role: "tourney_player",
      tourney_active: true,
      credential_version: "3",
    });

    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&flow=tourney&next=%2Ftourney%2Fmanage"
      )
    );

    expect(response.url).toBe("https://www.rooindustries.com/tourney/manage");
    expect(response.cookies.values).toEqual([
      [
        {
          name: "tourney_session",
          value: "tourney-token",
          path: "/",
          httpOnly: true,
          sameSite: "lax",
        },
      ],
    ]);
    expect(mockBootstrapSupabaseNativeAccount).not.toHaveBeenCalled();
    expect(mockCreateTourneySessionToken).toHaveBeenCalledWith({
      account: {
        username: "player-one",
        role: "player",
        version: "3",
        authBackend: "supabase",
      },
    });
  });

  test("rejects an OAuth identity that is not linked to the requested role", async () => {
    mockResolveSupabaseAccountAlias.mockResolvedValue(null);

    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&flow=referral&next=%2Freferrals%2Fdashboard"
      )
    );

    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/login?oauth=unlinked"
    );
    expect(response.cookies.values).toHaveLength(0);
    expect(mockBootstrapSupabaseNativeAccount).not.toHaveBeenCalled();
  });

  test("discards browser cookies when account setup fails", async () => {
    mockBootstrapSupabaseNativeAccount.mockRejectedValueOnce(
      new Error("profile conflict")
    );

    const response = await GET(
      request("https://www.rooindustries.com/auth/callback?code=one")
    );

    expect(response.url).toBe(
      "https://www.rooindustries.com/?auth_error=unavailable"
    );
    expect(response.cookies.values).toHaveLength(0);
  });
});

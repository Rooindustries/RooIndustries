const mockExchangeCodeForSession = jest.fn();
const mockBootstrapSupabaseNativeAccount = jest.fn();
const mockCreateServerClient = jest.fn((_url, _key, options) => ({
  auth: {
    exchangeCodeForSession: async (code) => {
      options.cookies.setAll([
        {
          name: "sb-session",
          value: "encoded-session",
          options: { httpOnly: true, sameSite: "lax" },
        },
      ]);
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
}));

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url, init = {}) => {
      const headers = new Map();
      const cookies = [];
      return {
        status: init.status || 307,
        url: String(url),
        cookies: { set: (cookie) => cookies.push(cookie), values: cookies },
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
      data: {
        session: { access_token: "not-returned" },
        user: { id: "e71a5687-daa6-4371-9700-5aef798fdd03" },
      },
      error: null,
    });
    mockBootstrapSupabaseNativeAccount.mockResolvedValue({
      user_id: "e71a5687-daa6-4371-9700-5aef798fdd03",
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

  test("exchanges PKCE code, preserves cookies, and disables caching", async () => {
    const response = await GET(
      request(
        "https://www.rooindustries.com/auth/callback?code=one&next=%2Freferrals%2Fdashboard",
        "pkce=value%2Ewith%2Eencoding"
      )
    );

    expect(response.status).toBe(303);
    expect(response.url).toBe(
      "https://www.rooindustries.com/referrals/dashboard"
    );
    expect(response.cookies.values).toHaveLength(1);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockBootstrapSupabaseNativeAccount).toHaveBeenCalledWith({
      userId: "e71a5687-daa6-4371-9700-5aef798fdd03",
    });
    const cookieApi = mockCreateServerClient.mock.calls[0][2].cookies;
    expect(cookieApi.getAll()).toEqual([
      { name: "pkce", value: "value.with.encoding" },
    ]);
  });

  test("does not establish a browser session when account setup fails", async () => {
    mockBootstrapSupabaseNativeAccount.mockRejectedValueOnce(
      new Error("profile conflict")
    );

    const response = await GET(
      request("https://www.rooindustries.com/auth/callback?code=one&next=%2Faccount")
    );

    expect(response.status).toBe(303);
    expect(response.url).toBe(
      "https://www.rooindustries.com/account/login?error=account_setup_failed"
    );
  });
});

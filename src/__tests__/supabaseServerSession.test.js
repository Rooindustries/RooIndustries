const mockSetSession = jest.fn();
const mockSignOut = jest.fn();
const mockGetUser = jest.fn();
const mockCreateServerClient = jest.fn();

jest.mock("@supabase/ssr", () => ({
  createServerClient: (...args) => mockCreateServerClient(...args),
}));

jest.mock("../server/supabase/authClient", () => ({
  resolveSupabaseAuthEnv: () => ({
    url: "https://ntezmxzaibrrsgtujgxu.supabase.co",
    publishableKey: "publishable-test-key",
  }),
}));

const {
  clearLegacySupabaseSession,
  getNextSupabaseUser,
  getSupabaseSessionCookieOptions,
  installLegacySupabaseSession,
} = require("../server/supabase/serverSession");

const createLegacyResponse = () => {
  const headers = new Map();
  return {
    getHeader: (name) => headers.get(String(name).toLowerCase()),
    setHeader: (name, value) => headers.set(String(name).toLowerCase(), value),
    headers,
  };
};

describe("Supabase server session bridge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetSession.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockCreateServerClient.mockImplementation((_url, _key, options) => ({
      auth: {
        setSession: async (...args) => {
          options.cookies.setAll([
            {
              name: "sb-access-token",
              value: "new-access",
              options: { httpOnly: true, sameSite: "lax", path: "/" },
            },
            {
              name: "sb-refresh-token",
              value: "new-refresh",
              options: { httpOnly: true, sameSite: "lax", path: "/" },
            },
          ]);
          return mockSetSession(...args);
        },
        signOut: (...args) => mockSignOut(...args),
        getUser: (...args) => mockGetUser(...args),
      },
    }));
  });

  test("installs both Auth cookies without overwriting another Set-Cookie header", async () => {
    const req = { headers: { cookie: "existing=value" } };
    const res = createLegacyResponse();
    res.setHeader("Set-Cookie", "ref_session=custom; Path=/; HttpOnly");

    await installLegacySupabaseSession({
      req,
      res,
      session: { access_token: "access", refresh_token: "refresh" },
    });

    expect(res.getHeader("Set-Cookie")).toHaveLength(3);
    expect(res.getHeader("Set-Cookie")[0]).toContain("ref_session=custom");
    expect(res.getHeader("Set-Cookie")[1]).toContain("sb-access-token=new-access");
    expect(res.getHeader("Set-Cookie")[2]).toContain("sb-refresh-token=new-refresh");
  });

  test("returns only a server-verified Auth user", async () => {
    const verifiedUser = { id: "e71a5687-daa6-4371-9700-5aef798fdd03" };
    mockGetUser.mockResolvedValue({ data: { user: verifiedUser }, error: null });
    const response = {
      cookies: { set: jest.fn() },
      headers: { set: jest.fn() },
    };
    const request = {
      headers: { get: (name) => (name === "cookie" ? "sb=test" : "") },
    };

    await expect(getNextSupabaseUser({ request, response })).resolves.toEqual(
      verifiedUser
    );

    mockGetUser.mockResolvedValue({ data: { user: verifiedUser }, error: new Error("bad jwt") });
    await expect(getNextSupabaseUser({ request, response })).resolves.toBeNull();
  });

  test("forces Secure on production Auth cookies without changing HttpOnly", async () => {
    const req = { headers: { cookie: "" } };
    const res = createLegacyResponse();

    await installLegacySupabaseSession({
      req,
      res,
      env: { NODE_ENV: "production" },
      session: { access_token: "access", refresh_token: "refresh" },
    });

    expect(getSupabaseSessionCookieOptions({ NODE_ENV: "production" })).toEqual({
      path: "/",
      sameSite: "lax",
      secure: true,
    });
    for (const cookie of res.getHeader("Set-Cookie")) {
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
    }
    expect(mockCreateServerClient.mock.calls.at(-1)[2].cookieOptions)
      .toMatchObject({ secure: true, sameSite: "lax", path: "/" });
  });

  test("clears only the local Supabase session", async () => {
    await clearLegacySupabaseSession({
      req: { headers: { cookie: "" } },
      res: createLegacyResponse(),
    });

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

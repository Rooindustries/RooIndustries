const mockGetNextSupabaseUser = jest.fn();
const mockSessionGetUser = jest.fn();
const mockUnlinkIdentity = jest.fn();
const mockResolveAccount = jest.fn();
const mockRpc = jest.fn();
const mockReadReauthToken = jest.fn();

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
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (payload, init) => createResponse(payload, init) },
}));

jest.mock("../server/supabase/serverSession", () => ({
  getNextSupabaseUser: (...args) => mockGetNextSupabaseUser(...args),
  createNextSupabaseSessionClient: () => ({
    auth: {
      getUser: (...args) => mockSessionGetUser(...args),
      unlinkIdentity: (...args) => mockUnlinkIdentity(...args),
    },
  }),
}));

jest.mock("../server/supabase/accounts", () => ({
  resolveSupabaseAccountByUserId: (...args) => mockResolveAccount(...args),
}));

jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => ({ rpc: (...args) => mockRpc(...args) }),
}));

jest.mock("../server/supabase/reauth", () => ({
  hashReauthToken: (value) => `hash:${value}`,
  readReauthToken: (...args) => mockReadReauthToken(...args),
}));

const route = require("../../app/api/auth/identities/route.js");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  identities: [
    { id: "email-one", provider: "email" },
    { id: "discord-one", provider: "discord" },
  ],
};

const getRequest = () => ({
  url: "https://www.rooindustries.com/api/auth/identities?flow=tourney",
  headers: { get: () => "" },
});

const postRequest = (provider = "discord") => {
  const body = JSON.stringify({ provider });
  return {
    url: "https://www.rooindustries.com/api/auth/identities",
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "origin") return "https://www.rooindustries.com";
        if (key === "content-type") return "application/json";
        if (key === "content-length") return String(Buffer.byteLength(body));
        if (key === "cookie") return "roo_reauth_grant=reauth-token";
        return "";
      },
    },
    text: async () => body,
  };
};

describe("Supabase connected identity route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetNextSupabaseUser.mockResolvedValue(user);
    mockSessionGetUser.mockResolvedValue({ data: { user }, error: null });
    mockResolveAccount.mockResolvedValue({
      connected_providers: ["email", "google", "discord"],
      creator_active: true,
      roles: ["tourney_player"],
      status: "active",
      tourney_active: true,
      tourney_role: "tourney_player",
      tourney_status: "approved",
      tourney_username: "player-one",
      verified_real_email: "player@example.com",
    });
    mockReadReauthToken.mockReturnValue("reauth-token");
    mockRpc.mockResolvedValue({ data: {}, error: null });
    mockUnlinkIdentity.mockResolvedValue({ error: null });
  });

  test("returns principal-wide providers without exposing the internal Auth address", async () => {
    const response = await route.GET(getRequest());
    const body = await response.json();
    expect(body).toMatchObject({
      authenticated: true,
      domainAccount: true,
      email: "player@example.com",
      emailVerified: true,
      providers: ["discord", "email", "google"],
      unlinkableProviders: ["discord", "email"],
    });
    expect(JSON.stringify(body)).not.toContain("@auth.rooindustries.invalid");
  });

  test("consumes a provider-bound grant before unlinking and removes Discord access", async () => {
    const response = await route.POST(postRequest("discord"));
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenNthCalledWith(1, "roo_consume_reauth_grant", {
      p_token_hash: "hash:reauth-token",
      p_user_id: user.id,
      p_purpose: "unlink_identity",
      p_provider: "discord",
    });
    expect(mockUnlinkIdentity).toHaveBeenCalledWith(user.identities[1]);
    expect(mockRpc).toHaveBeenCalledWith("roo_reconcile_auth_identity_links", {
      p_user_id: user.id,
    });
  });

  test("keeps at least one sign-in method connected", async () => {
    mockSessionGetUser.mockResolvedValue({
      data: { user: { ...user, identities: [user.identities[1]] } },
      error: null,
    });
    const response = await route.POST(postRequest("discord"));
    expect(response.status).toBe(409);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
  });
});

const mockGetNextSupabaseUser = jest.fn();
const mockSessionGetUser = jest.fn();
const mockSessionGetSession = jest.fn();
const mockUnlinkIdentity = jest.fn();
const mockResolveAccount = jest.fn();
const mockRpc = jest.fn();
const mockReadReauthToken = jest.fn();
const mockQueueIdentityUnlink = jest.fn();
const mockResolveExactDomainIdentity = jest.fn();
const originalTourneyDatabaseMode = process.env.TOURNEY_DATABASE_MODE;

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
      getSession: (...args) => mockSessionGetSession(...args),
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

jest.mock("../server/supabase/domainIdentity", () => ({
  resolveExactDomainIdentity: (...args) => mockResolveExactDomainIdentity(...args),
}));

jest.mock("../server/supabase/reauth", () => ({
  clearReauthCookie: () => ({ name: "roo_reauth_grant", value: "", maxAge: 0, path: "/" }),
  hashReauthToken: (value) => `hash:${value}`,
  readReauthToken: (...args) => mockReadReauthToken(...args),
}));

jest.mock("../server/tourney/discordDesiredState", () => ({
  queueTourneyDiscordIdentityUnlinkProjection: (...args) =>
    mockQueueIdentityUnlink(...args),
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

const postRequest = (provider = "discord", flow = "tourney") => {
  const body = JSON.stringify({ flow, provider });
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
    process.env.TOURNEY_DATABASE_MODE = "supabase";
    jest.clearAllMocks();
    mockGetNextSupabaseUser.mockResolvedValue(user);
    mockSessionGetUser.mockResolvedValue({ data: { user }, error: null });
    mockSessionGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: "short-lived-user-token",
          expires_at: 4_102_444_800,
        },
      },
      error: null,
    });
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
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        connected_providers: ["email", "google", "discord"],
        creator_active: true,
        principal_id: "22222222-2222-4222-8222-222222222222",
        roles: ["creator", "tourney_player"],
        status: "active",
        tourney_active: true,
        tourney_role: "tourney_player",
        tourney_username: "player-one",
      },
      user,
    });
    mockReadReauthToken.mockReturnValue("reauth-token");
    mockRpc.mockResolvedValue({ data: {}, error: null });
    mockUnlinkIdentity.mockResolvedValue({ error: null });
    mockQueueIdentityUnlink.mockResolvedValue({ syncPending: false });
  });

  afterAll(() => {
    if (originalTourneyDatabaseMode === undefined) {
      delete process.env.TOURNEY_DATABASE_MODE;
    } else {
      process.env.TOURNEY_DATABASE_MODE = originalTourneyDatabaseMode;
    }
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

  test("queues provider-bound grant consumption inside the durable unlink command", async () => {
    const response = await route.POST(postRequest("discord"));
    expect(response.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalledWith("roo_consume_reauth_grant", expect.anything());
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
    expect(mockQueueIdentityUnlink).toHaveBeenCalledWith({
      accessToken: "short-lived-user-token",
      commandId: `identity-unlink:discord:${user.id}:hash:reauth-token`,
      expiresAt: "2100-01-01T00:00:00.000Z",
      identityId: "discord-one",
      provider: "discord",
      reauthTokenHash: "hash:reauth-token",
      userId: user.id,
    });
  });

  test("replays the durable unlink projection after Auth already removed the identity", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        principal_id: "22222222-2222-4222-8222-222222222222",
        roles: ["tourney_player"],
        status: "active",
        tourney_active: true,
        tourney_role: "tourney_player",
        tourney_username: "player-one",
      },
      user: { ...user, identities: [user.identities[0]] },
    });

    const response = await route.POST(postRequest("discord"));

    expect(response.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
    expect(mockQueueIdentityUnlink).toHaveBeenCalledTimes(1);
  });

  test("keeps at least one sign-in method connected", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        principal_id: "22222222-2222-4222-8222-222222222222",
        roles: ["tourney_player"],
        status: "active",
        tourney_active: true,
        tourney_role: "tourney_player",
        tourney_username: "player-one",
      },
      user: { ...user, identities: [user.identities[1]] },
    });
    const response = await route.POST(postRequest("discord"));
    expect(response.status).toBe(409);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
  });

  test("keeps dual-role principals on the durable Tourney saga from referral pages", async () => {
    const response = await route.POST(postRequest("discord", "referral"));

    expect(response.status).toBe(200);
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
    expect(mockQueueIdentityUnlink).toHaveBeenCalledTimes(1);
  });

  test("uses the referral-only path only for a verified creator-only principal", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        creator_active: true,
        principal_id: "22222222-2222-4222-8222-222222222222",
        roles: ["creator"],
        status: "active",
      },
      user,
    });

    const response = await route.POST(postRequest("discord", "referral"));

    expect(response.status).toBe(200);
    expect(mockUnlinkIdentity).toHaveBeenCalledWith(user.identities[1]);
    expect(mockQueueIdentityUnlink).not.toHaveBeenCalled();
  });

  test("retries creator-only reconciliation after Auth already removed the identity", async () => {
    const creatorAccount = {
      creator_active: true,
      principal_id: "22222222-2222-4222-8222-222222222222",
      roles: ["creator"],
      status: "active",
    };
    mockResolveExactDomainIdentity.mockResolvedValue({ account: creatorAccount, user });
    mockRpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("reconcile timeout") });

    const failed = await route.POST(postRequest("discord", "referral"));

    expect(failed.status).toBe(503);
    expect(mockUnlinkIdentity).toHaveBeenCalledTimes(1);

    mockResolveExactDomainIdentity.mockResolvedValue({
      account: creatorAccount,
      user: { ...user, identities: [user.identities[0]] },
    });
    mockRpc.mockResolvedValue({ data: {}, error: null });

    const recovered = await route.POST(postRequest("discord", "referral"));

    expect(recovered.status).toBe(200);
    expect(mockUnlinkIdentity).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenLastCalledWith("roo_reconcile_auth_identity_links", {
      p_user_id: user.id,
    });
  });

  test("consumes creator-only reauthentication on an already-unlinked replay", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue({
      account: {
        creator_active: true,
        principal_id: "22222222-2222-4222-8222-222222222222",
        roles: ["creator"],
        status: "active",
      },
      user: { ...user, identities: [user.identities[0]] },
    });

    const response = await route.POST(postRequest("discord", "referral"));

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenNthCalledWith(1, "roo_consume_reauth_grant", {
      p_token_hash: "hash:reauth-token",
      p_user_id: user.id,
      p_purpose: "unlink_identity",
      p_provider: "discord",
    });
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
    expect(response.cookies.getAll()).toContainEqual(
      expect.objectContaining({ name: "roo_reauth_grant", maxAge: 0 })
    );
  });

  test("rejects a forged flow without an exact domain identity", async () => {
    mockResolveExactDomainIdentity.mockResolvedValue(null);

    const response = await route.POST(postRequest("discord", "referral"));

    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUnlinkIdentity).not.toHaveBeenCalled();
    expect(mockQueueIdentityUnlink).not.toHaveBeenCalled();
  });
});

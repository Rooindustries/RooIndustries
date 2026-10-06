const mockRpc = jest.fn();
const mockFetch = jest.fn();
const mockResolvePolicy = jest.fn();

jest.mock("../server/supabase/adminClient.js", () => ({
  createSupabaseAdminClient: () => ({ rpc: mockRpc }),
}));

jest.mock("../server/data/documentClient.js", () => ({
  createDocumentReadClient: jest.fn(() => ({ fetch: mockFetch })),
}));

jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: (...args) => mockResolvePolicy(...args),
}));

const {
  createReferralSessionCookie,
  requireReferralSession,
} = require("../server/api/ref/auth.js");

const principalId = "10000000-0000-4000-8000-000000000001";

const createReq = (overrides = {}) => {
  const cookie = createReferralSessionCookie({
    referralId: "ref_creator_1",
    code: "creator-code",
    authBackend: "supabase",
    principalId,
    sessionVersion: 7,
    credentialVersion: 7,
    ...overrides,
  });
  return { headers: { cookie: `${cookie.name}=${cookie.value}` } };
};

const privateSanityEnv = {
  SANITY_PRIVATE_PROJECT_ID: "private-project",
  SANITY_PRIVATE_DATASET: "private-dataset",
  SANITY_PRIVATE_READ_TOKEN: "private-read-token",
};
const originalPrivateSanityEnv = Object.fromEntries(
  Object.keys(privateSanityEnv).map((key) => [key, process.env[key]])
);

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const sanityAccount = (overrides = {}) => ({
  _id: "ref_creator_1",
  code: "creator-code",
  registrationStatus: "active",
  passwordResetRequired: false,
  passwordLoginEnabled: true,
  ...overrides,
});

const fallbackAuthority = (overrides = {}) => ({
  authoritySchemaVersion: 1,
  legacyCreatorId: "ref_creator_1",
  principalId,
  referralCode: "creator-code",
  principalSessionVersion: 7,
  principalStatus: "active",
  creatorActive: true,
  creatorRolePresent: true,
  credentialVersion: 7,
  credentialChangedAt: "2026-01-01T00:00:00.000Z",
  currentRecord: true,
  authorityVersion: 3,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, privateSanityEnv);
  mockResolvePolicy.mockReturnValue({
    primaryBackend: "sanity",
    cutoverEnabled: false,
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalPrivateSanityEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("D6/O1 native referral session authority", () => {
  test("uses Supabase exclusively while Supabase is primary", async () => {
    mockResolvePolicy.mockReturnValue({ primaryBackend: "supabase" });
    mockRpc.mockResolvedValue({
      data: {
        roles: ["creator"],
        creator_legacy_sanity_id: "ref_creator_1",
        referral_code: "creator-code",
        principal_id: principalId,
        session_version: 7,
      },
      error: null,
    });

    const session = await requireReferralSession(
      createReq({ authBackend: "sanity" }),
      createRes()
    );

    expect(session).toMatchObject({
      referralId: "ref_creator_1",
      principalId,
      sessionVersion: 7,
      credentialVersion: 7,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("fails closed when Supabase verification is unavailable", async () => {
    mockResolvePolicy.mockReturnValue({ primaryBackend: "supabase" });
    mockRpc.mockRejectedValue(new Error("supabase unavailable"));
    const res = createRes();

    const session = await requireReferralSession(
      createReq({ authBackend: "sanity" }),
      res
    );

    expect(session).toBeNull();
    expect(res.statusCode).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("validates a Supabase-origin session against Supabase during the rolling pre-cutover phase", async () => {
    mockRpc.mockResolvedValue({
      data: {
        roles: ["creator"],
        creator_legacy_sanity_id: "ref_creator_1",
        referral_code: "creator-code",
        principal_id: principalId,
        session_version: 7,
      },
      error: null,
    });
    mockFetch.mockResolvedValue(sanityAccount({ passwordLoginEnabled: false }));

    const session = await requireReferralSession(createReq(), createRes());

    expect(session).toMatchObject({
      referralId: "ref_creator_1",
      principalId,
      sessionVersion: 7,
      credentialVersion: 7,
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });

  test("fails closed on a Supabase verification error during the rolling pre-cutover phase", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    mockFetch.mockResolvedValue(sanityAccount());
    const res = createRes();

    const session = await requireReferralSession(createReq(), res);

    expect(session).toBeNull();
    expect(res.statusCode).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });

});

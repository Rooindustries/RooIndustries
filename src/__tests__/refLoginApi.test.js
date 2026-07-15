const bcrypt = require("bcryptjs");

let login;
let getReferralSession;
const mockAuthenticateSupabaseAccount = jest.fn();
const originalBackend = process.env.DATA_PRIMARY_BACKEND;
const originalCutover = process.env.SUPABASE_CUTOVER_ENABLED;
const originalCanaries = process.env.SUPABASE_AUTH_CANARY_ACCOUNTS;
const originalPrivateProject = process.env.SANITY_PRIVATE_PROJECT_ID;
const originalPrivateDataset = process.env.SANITY_PRIVATE_DATASET;
const originalPrivateReadToken = process.env.SANITY_PRIVATE_READ_TOKEN;
const principalId = "10000000-0000-4000-8000-000000000001";

jest.mock("../server/supabase/accounts.js", () => ({
  authenticateSupabaseAccount: (...args) => mockAuthenticateSupabaseAccount(...args),
}));

const mockFetch = jest.fn();
const mockPatchCommit = jest.fn();
const mockPatchSet = jest.fn(() => ({
  commit: mockPatchCommit,
}));
const mockPatchIfRevisionId = jest.fn(() => ({
  set: mockPatchSet,
}));
const mockPatch = jest.fn(() => ({
  ifRevisionId: mockPatchIfRevisionId,
  set: mockPatchSet,
}));
const mockCreateClient = jest.fn(() => ({
  fetch: mockFetch,
  patch: mockPatch,
}));

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

const createReq = (body = {}) => ({
  method: "POST",
  body,
  headers: {
    "x-forwarded-for": "203.0.113.24",
  },
});

const createRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  setHeader(name, value) {
    this.headers[name] = value;
    return this;
  },
  getHeader(name) {
    return this.headers[name];
  },
});

const makeReferral = async () => ({
  _id: "ref_creator_1",
  _rev: "referral-revision-1",
  name: "Creator",
  slug: { current: "creator-code" },
  creatorEmail: "creator@example.com",
  paypalEmail: "payout@example.com",
  creatorPassword: await bcrypt.hash("correct-password", 4),
});

const findReferralByIdentifier = (referral, query, identifier) => {
  const normalized = String(identifier || "").trim().toLowerCase();
  const q = String(query || "");

  if (
    q.includes("slug.current") &&
    String(referral.slug?.current || "").toLowerCase() === normalized
  ) {
    return referral;
  }
  if (
    q.includes("creatorEmail") &&
    String(referral.creatorEmail || "").toLowerCase() === normalized
  ) {
    return referral;
  }
  return null;
};

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

beforeAll(() => {
  const loginModule = require("../../src/server/api/ref/login");
  login = loginModule.default || loginModule;
  ({ getReferralSession } = require("../../src/server/api/ref/auth"));
});

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.__rooRateLimitBuckets?.clear?.();
  process.env.DATA_PRIMARY_BACKEND = "sanity";
  process.env.SANITY_PRIVATE_PROJECT_ID = "private-project";
  process.env.SANITY_PRIVATE_DATASET = "private-dataset";
  process.env.SANITY_PRIVATE_READ_TOKEN = "private-read-token";
  delete process.env.SUPABASE_CUTOVER_ENABLED;
  delete process.env.SUPABASE_AUTH_CANARY_ACCOUNTS;
});

afterAll(() => {
  if (originalBackend === undefined) delete process.env.DATA_PRIMARY_BACKEND;
  else process.env.DATA_PRIMARY_BACKEND = originalBackend;
  if (originalCutover === undefined) delete process.env.SUPABASE_CUTOVER_ENABLED;
  else process.env.SUPABASE_CUTOVER_ENABLED = originalCutover;
  if (originalCanaries === undefined) delete process.env.SUPABASE_AUTH_CANARY_ACCOUNTS;
  else process.env.SUPABASE_AUTH_CANARY_ACCOUNTS = originalCanaries;
  if (originalPrivateProject === undefined) delete process.env.SANITY_PRIVATE_PROJECT_ID;
  else process.env.SANITY_PRIVATE_PROJECT_ID = originalPrivateProject;
  if (originalPrivateDataset === undefined) delete process.env.SANITY_PRIVATE_DATASET;
  else process.env.SANITY_PRIVATE_DATASET = originalPrivateDataset;
  if (originalPrivateReadToken === undefined) delete process.env.SANITY_PRIVATE_READ_TOKEN;
  else process.env.SANITY_PRIVATE_READ_TOKEN = originalPrivateReadToken;
});

describe("referral login API", () => {
  test("logs in with a referral code", async () => {
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );

    const req = createReq({
      code: " CREATOR-CODE ",
      password: "correct-password",
      rememberMe: true,
    });
    const res = createRes();

    await login(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      creatorId: "ref_creator_1",
      name: "Creator",
      code: "creator-code",
    });
    expect(mockFetch).toHaveBeenCalledWith(expect.any(String), {
      identifier: "creator-code",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockAuthenticateSupabaseAccount).not.toHaveBeenCalled();
    expect(res.headers["Set-Cookie"]).toContain("ref_session=");
  });

  test("logs in with creatorEmail and stores the canonical referral code in the session", async () => {
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );

    const req = createReq({
      code: " CREATOR@EXAMPLE.COM ",
      password: "correct-password",
      rememberMe: true,
    });
    const res = createRes();

    await login(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBe("creator-code");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("slug.current");
    expect(mockFetch.mock.calls[0][0]).toContain("creatorEmail");

    const session = getReferralSession({
      headers: {
        cookie: res.headers["Set-Cookie"],
      },
    });
    expect(session).toEqual({
      referralId: "ref_creator_1",
      code: "creator-code",
      authBackend: "sanity",
      principalId: "",
      sessionVersion: 1,
      credentialVersion: 1,
      issuedAt: expect.any(Number),
    });
  });

  test("uses the mirrored authority for an explicit manual fallback login", async () => {
    process.env.SUPABASE_CUTOVER_ENABLED = "1";
    process.env.SUPABASE_AUTH_CANARY_ACCOUNTS = "creator-code";
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) => {
      if (String(query).includes("referralAuthAuthority")) {
        return Promise.resolve(fallbackAuthority());
      }
      return Promise.resolve(
        findReferralByIdentifier(referral, query, params.identifier)
      );
    });
    const res = createRes();

    await login(
      createReq({ code: "creator-code", password: "correct-password" }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockAuthenticateSupabaseAccount).not.toHaveBeenCalled();
    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "private-project",
        dataset: "private-dataset",
        token: "private-read-token",
      })
    );
    const session = getReferralSession({
      headers: { cookie: res.headers["Set-Cookie"] },
    });
    expect(session).toMatchObject({
      referralId: "ref_creator_1",
      principalId,
      sessionVersion: 7,
      credentialVersion: 7,
    });
  });

  test("fails closed when the manual fallback authority is missing", async () => {
    process.env.SUPABASE_CUTOVER_ENABLED = "1";
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) => {
      if (String(query).includes("referralAuthAuthority")) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        findReferralByIdentifier(referral, query, params.identifier)
      );
    });
    const res = createRes();

    await login(
      createReq({ code: "creator-code", password: "correct-password" }),
      res
    );

    expect(res.statusCode).toBe(503);
    expect(res.headers["Set-Cookie"]).toBeUndefined();
    expect(mockAuthenticateSupabaseAccount).not.toHaveBeenCalled();
  });

  test.each([
    ["disabled principal", fallbackAuthority({ principalStatus: "disabled" })],
    ["inactive creator", fallbackAuthority({ creatorActive: false })],
    ["missing creator role", fallbackAuthority({ creatorRolePresent: false })],
    ["retired authority", fallbackAuthority({ currentRecord: false })],
  ])("rejects a %s during manual fallback login", async (_label, authority) => {
    process.env.SUPABASE_CUTOVER_ENABLED = "1";
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) => {
      if (String(query).includes("referralAuthAuthority")) {
        return Promise.resolve(authority);
      }
      return Promise.resolve(
        findReferralByIdentifier(referral, query, params.identifier)
      );
    });
    const res = createRes();

    await login(
      createReq({ code: "creator-code", password: "correct-password" }),
      res
    );

    expect(res.statusCode).toBe(401);
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  test("rejects a wrong password for a valid login email", async () => {
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );

    const req = createReq({
      code: "creator@example.com",
      password: "wrong-password",
    });
    const res = createRes();

    await login(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  test("rejects an unknown email or code", async () => {
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );

    const req = createReq({
      code: "missing@example.com",
      password: "correct-password",
    });
    const res = createRes();

    await login(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
  });

  test("does not allow PayPal payout email as a login identifier", async () => {
    const referral = await makeReferral();
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );

    const req = createReq({
      code: "payout@example.com",
      password: "correct-password",
    });
    const res = createRes();

    await login(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
  });

  test("honors an explicitly requested password reset", async () => {
    const referral = {
      ...(await makeReferral()),
      passwordResetRequired: true,
    };
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );
    const res = createRes();

    await login(
      createReq({ code: "creator-code", password: "correct-password" }),
      res
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  test("preserves a legacy password and upgrades its storage after login", async () => {
    const referral = {
      ...(await makeReferral()),
      creatorPassword: "correct-password",
      passwordResetRequired: false,
    };
    mockFetch.mockImplementation((query, params = {}) =>
      Promise.resolve(findReferralByIdentifier(referral, query, params.identifier))
    );
    const res = createRes();

    await login(
      createReq({ code: "creator-code", password: "correct-password" }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, code: "creator-code" });
    expect(mockPatch).toHaveBeenCalledWith("ref_creator_1");
    expect(mockPatchIfRevisionId).toHaveBeenCalledWith("referral-revision-1");
    const storedUpgrade = mockPatchSet.mock.calls[0][0];
    expect(storedUpgrade).toMatchObject({
      credentialVersion: 2,
      passwordResetRequired: false,
    });
    expect(storedUpgrade.passwordStorageUpgradedAt).toEqual(expect.any(String));
    await expect(
      bcrypt.compare("correct-password", storedUpgrade.creatorPassword)
    ).resolves.toBe(true);
    expect(mockPatchCommit).toHaveBeenCalledWith({ visibility: "sync" });
  });
});

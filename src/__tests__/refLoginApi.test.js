const bcrypt = require("bcryptjs");

let login;
let getReferralSession;

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

beforeAll(() => {
  const loginModule = require("../../src/server/api/ref/login");
  login = loginModule.default || loginModule;
  ({ getReferralSession } = require("../../src/server/api/ref/auth"));
});

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.__rooRateLimitBuckets?.clear?.();
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
    });
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

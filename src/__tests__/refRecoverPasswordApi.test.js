const mockBcryptHash = jest.fn();
const mockClearReferralSessionCookie = jest.fn();
const mockClearLegacySupabaseSession = jest.fn();
const mockClientFetch = jest.fn();
const mockGetClaims = jest.fn();
const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockReconcileCredentialSource = jest.fn();
const mockRequireRateLimit = jest.fn();
const mockResolveAccountByUserId = jest.fn();
const mockResumeCredentialOperation = jest.fn();
const mockUpdatePassword = jest.fn();
const mockDataClientOptions = [];

jest.mock("bcryptjs", () => ({
  hash: (...args) => mockBcryptHash(...args),
}));

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: (_config, options) => {
    mockDataClientOptions.push(options);
    return { fetch: (...args) => mockClientFetch(...args) };
  },
}));

jest.mock("../server/api/ref/auth.js", () => ({
  clearReferralSessionCookie: (...args) => mockClearReferralSessionCookie(...args),
}));

jest.mock("../server/api/ref/rateLimit.js", () => ({
  getClientAddress: () => "203.0.113.42",
  requireRateLimit: (...args) => mockRequireRateLimit(...args),
}));

jest.mock("../server/supabase/accounts.js", () => ({
  buildCredentialSourceMutation: ({ passwordHash, passwordChangedAt }) => ({
    set: { creatorPassword: passwordHash, passwordChangedAt },
    unset: ["resetTokenHash"],
  }),
  buildCredentialSourcePreconditions: ({ document }) => ({
    creatorPassword: document.creatorPassword,
  }),
  completeSupabaseCredentialMirror: jest.fn(),
  markSupabaseCredentialSourceApplied: jest.fn(),
  resolveCredentialSourceRevision: ({ document }) => document._supabaseRevision,
  resolveSupabaseAccountByUserId: (...args) => mockResolveAccountByUserId(...args),
  updateSupabaseAccountPassword: (...args) => mockUpdatePassword(...args),
}));

jest.mock("../server/supabase/credentialRecovery.js", () => ({
  reconcileSupabaseCredentialSource: (...args) => mockReconcileCredentialSource(...args),
  resumeSupabaseCredentialOperation: (...args) => mockResumeCredentialOperation(...args),
}));

jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: () => ({
    cutoverEnabled: true,
    primaryBackend: "supabase",
  }),
}));

jest.mock("../server/supabase/serverSession.js", () => ({
  clearLegacySupabaseSession: (...args) => mockClearLegacySupabaseSession(...args),
  createLegacySupabaseSessionClient: () => ({
    auth: {
      getClaims: (...args) => mockGetClaims(...args),
      getSession: (...args) => mockGetSession(...args),
      getUser: (...args) => mockGetUser(...args),
    },
  }),
}));

jest.mock("../server/safeErrorLog.js", () => ({ logSafeError: jest.fn() }));

const recoverPasswordModule = require("../server/api/ref/recoverPassword.js");
const recoverPassword = recoverPasswordModule.default || recoverPasswordModule;

const createReq = (body = {}) => ({
  body,
  headers: { "x-forwarded-for": "203.0.113.42" },
  method: "POST",
});

const createRes = () => ({
  body: null,
  headers: {},
  statusCode: 200,
  getHeader(name) {
    return this.headers[name];
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  setHeader(name, value) {
    this.headers[name] = value;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
});

describe("referral authenticated recovery API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireRateLimit.mockResolvedValue(true);
    mockBcryptHash.mockResolvedValue("$2b$12$recovery-password-hash");
    mockGetUser.mockResolvedValue({
      data: { user: { id: "10000000-0000-4000-8000-000000000001" } },
      error: null,
    });
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "verified-recovery-access-token" } },
      error: null,
    });
    mockGetClaims.mockResolvedValue({
      data: {
        claims: {
          amr: ["otp"],
          iat: Math.floor(Date.now() / 1000),
          sub: "10000000-0000-4000-8000-000000000001",
        },
      },
      error: null,
    });
    mockResolveAccountByUserId.mockResolvedValue({
      creator_active: true,
      creator_legacy_sanity_id: "referral.recovery-smoke",
      primary_email: "creator@example.com",
      roles: ["creator"],
      status: "active",
    });
    mockClientFetch.mockResolvedValue({
      _id: "referral.recovery-smoke",
      _rev: "sanity-revision",
      _supabaseRevision: "supabase-revision",
      creatorEmail: "creator@example.com",
      creatorPassword: "old-hash",
      credentialVersion: 2,
      slug: { current: "recovery-smoke" },
    });
    mockResumeCredentialOperation.mockResolvedValue({ resumed: false });
    mockUpdatePassword.mockResolvedValue({
      operationKey: "credential:recovery:operation",
      updated: true,
    });
    mockReconcileCredentialSource.mockResolvedValue({ applied: true });
    mockClearLegacySupabaseSession.mockResolvedValue(undefined);
  });

  test("disables broad Supabase fallback for recovery credential reads", () => {
    expect(mockDataClientOptions).toContainEqual({ allowLegacyFallback: false });
  });

  test("updates both Auth and creator credential sources from a verified OTP session", async () => {
    const req = createReq({ password: "new-password-123" });
    const res = createRes();

    await recoverPassword(req, res);

    expect(mockGetClaims).toHaveBeenCalledWith("verified-recovery-access-token");
    expect(mockResolveAccountByUserId).toHaveBeenCalledWith({
      userId: "10000000-0000-4000-8000-000000000001",
    });
    expect(mockUpdatePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: "creator@example.com",
        operationKey: expect.stringMatching(/^credential:recovery:[a-f0-9]{64}$/),
        password: "new-password-123",
        passwordHash: "$2b$12$recovery-password-hash",
        sourceBackend: "supabase",
        sourceDocumentId: "referral.recovery-smoke",
        sourceRevision: "supabase-revision",
      })
    );
    expect(mockReconcileCredentialSource).toHaveBeenCalledWith({
      operationKey: "credential:recovery:operation",
      sourceDocumentId: "referral.recovery-smoke",
    });
    expect(mockClearReferralSessionCookie).toHaveBeenCalledWith(res);
    expect(mockClearLegacySupabaseSession).toHaveBeenCalledWith({ req, res });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      signedOut: true,
      status: "updated",
      message: "Password updated. Log in with your new password.",
    });
  });

  test("rejects a normal password session as a recovery credential", async () => {
    mockGetClaims.mockResolvedValue({
      data: {
        claims: {
          amr: ["password"],
          iat: Math.floor(Date.now() / 1000),
          sub: "10000000-0000-4000-8000-000000000001",
        },
      },
      error: null,
    });
    const res = createRes();

    await recoverPassword(createReq({ password: "new-password-123" }), res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe(
      "This recovery session is invalid or expired. Request a new link."
    );
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  test("returns an error without leaving a partial client success", async () => {
    mockUpdatePassword.mockRejectedValue(new Error("Auth unavailable"));
    const res = createRes();

    await recoverPassword(createReq({ password: "new-password-123" }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error: "Password update is temporarily unavailable. Please try again.",
    });
    expect(mockReconcileCredentialSource).not.toHaveBeenCalled();
  });

  test("surfaces an already active password operation", async () => {
    mockUpdatePassword.mockRejectedValue(
      Object.assign(new Error("operation active"), { code: "55006" })
    );
    const res = createRes();

    await recoverPassword(createReq({ password: "new-password-123" }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error:
        "A previous password change is still in progress. Please try again shortly.",
    });
  });

  test("returns an explicit pending state while the durable mirror finishes", async () => {
    mockReconcileCredentialSource.mockRejectedValue(
      Object.assign(new Error("mirror pending"), {
        code: "CREDENTIAL_MIRROR_PENDING",
      })
    );
    const res = createRes();

    await recoverPassword(createReq({ password: "new-password-123" }), res);

    expect(res.statusCode).toBe(202);
    expect(res.headers["Retry-After"]).toBe("2");
    expect(res.body).toEqual({
      ok: true,
      status: "pending",
      message: "Your password change is saving. It will finish in a moment.",
    });
    expect(mockClearLegacySupabaseSession).not.toHaveBeenCalled();
  });

  test("returns the same pending copy when an existing recovery is not ready", async () => {
    mockResumeCredentialOperation.mockRejectedValue(
      Object.assign(new Error("recovery pending"), {
        code: "CREDENTIAL_MIRROR_PENDING",
      })
    );
    const res = createRes();

    await recoverPassword(createReq({ password: "new-password-123" }), res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      status: "pending",
      message: "Your password change is saving. It will finish in a moment.",
    });
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });
});

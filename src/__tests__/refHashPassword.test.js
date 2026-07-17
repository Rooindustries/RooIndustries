const mockFetch = jest.fn();
const mockUpdateSupabaseAccountPassword = jest.fn();
const mockReconcileSupabaseCredentialSource = jest.fn();
const mockConsumeReauthGrant = jest.fn();
const mockResolvePolicy = jest.fn();
const mockPatch = jest.fn();
const mockMarkSupabaseCredentialSourceApplied = jest.fn();
const mockCompleteSupabaseCredentialMirror = jest.fn();

jest.mock("bcryptjs", () => ({
  hash: jest.fn(async () => `$2b$12$${"n".repeat(53)}`),
}));

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => ({ fetch: mockFetch, patch: mockPatch }),
}));

jest.mock("../server/api/ref/auth.js", () => ({
  clearReferralSessionCookie: jest.fn(),
  requireReferralSession: jest.fn(async () => ({
    referralId: "referral.creator",
    code: "creator-code",
  })),
}));

jest.mock("../server/api/ref/rateLimit.js", () => ({
  getClientAddress: () => "203.0.113.50",
  requireRateLimit: jest.fn(async () => true),
}));

jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: (...args) => mockResolvePolicy(...args),
}));

jest.mock("../server/supabase/accounts.js", () => {
  const actual = jest.requireActual("../server/supabase/accounts.js");
  return {
    ...actual,
    resolveSupabaseAccountAlias: jest.fn(async () => ({ user_id: "user-one" })),
    updateSupabaseAccountPassword: mockUpdateSupabaseAccountPassword,
    markSupabaseCredentialSourceApplied: mockMarkSupabaseCredentialSourceApplied,
    completeSupabaseCredentialMirror: mockCompleteSupabaseCredentialMirror,
  };
});

jest.mock("../server/supabase/adminClient.js", () => ({
  createSupabaseAdminClient: () => ({ rpc: mockConsumeReauthGrant }),
}));

jest.mock("../server/supabase/credentialRecovery.js", () => ({
  reconcileSupabaseCredentialSource: mockReconcileSupabaseCredentialSource,
}));

jest.mock("../server/supabase/serverSession.js", () => ({
  clearLegacySupabaseSession: jest.fn(async () => {}),
}));

jest.mock("../server/supabase/reauth.js", () => ({
  hashReauthToken: () => "reauth-token-hash",
  readReauthToken: () => "reauth-token",
}));

const createResponse = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  setHeader(name, value) {
    this.headers[name] = value;
  },
  getHeader(name) {
    return this.headers[name];
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe("referral password change", () => {
  let handler;

  beforeAll(() => {
    const module = require("../server/api/ref/hashPassword.js");
    handler = module.default || module;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      _id: "referral.creator",
      _rev: "source-r1",
      _supabaseRevision: "source-r1",
      creatorEmail: "creator@example.com",
      creatorPassword: `$2b$12$${"o".repeat(53)}`,
      credentialVersion: 2,
      resetTokenHash: "outstanding-reset-hash",
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      resetDeliveryToken: "v1.sealed-reset-token",
      slug: { current: "creator-code" },
    });
    mockConsumeReauthGrant.mockResolvedValue({ data: { consumed: true }, error: null });
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      cutoverEnabled: true,
    });
    mockUpdateSupabaseAccountPassword.mockImplementation(async (options) => ({
      updated: true,
      operationKey: options.operationKey,
      sourceMutation: options.sourceMutation,
    }));
    mockReconcileSupabaseCredentialSource.mockResolvedValue({ completed: true });
    mockMarkSupabaseCredentialSourceApplied.mockResolvedValue({ updated: true });
    mockCompleteSupabaseCredentialMirror.mockResolvedValue({ completed: true });
  });

  test("consumes every outstanding reset-token field in the credential saga", async () => {
    const response = createResponse();
    await handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.50" },
        body: { password: "new-password-value" },
      },
      response
    );

    expect(response.statusCode).toBe(200);
    const request = mockUpdateSupabaseAccountPassword.mock.calls[0][0];
    expect(request.password).toBe("new-password-value");
    expect(request.sourcePreconditions).toMatchObject({
      resetTokenHash: "outstanding-reset-hash",
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(request.sourceMutation.unset).toEqual([
      "resetToken",
      "resetTokenHash",
      "resetTokenExpiresAt",
      "resetDeliveryToken",
    ]);
    expect(mockReconcileSupabaseCredentialSource).toHaveBeenCalledWith({
      operationKey: "credential:change:reauth-token-hash",
      sourceDocumentId: "referral.creator",
    });
  });

  test("checkpoints the Sanity-primary source mutation before completing the mirror", async () => {
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "sanity",
      cutoverEnabled: false,
    });
    const chain = {
      ifRevisionId: jest.fn(() => chain),
      set: jest.fn(() => chain),
      unset: jest.fn(() => chain),
      commit: jest.fn(async () => ({ _rev: "source-r2" })),
    };
    mockPatch.mockReturnValue(chain);
    const response = createResponse();

    await handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.50" },
        body: { password: "new-password-value" },
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(chain.ifRevisionId).toHaveBeenCalledWith("source-r1");
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      creatorPassword: expect.stringMatching(/^\$2b\$12\$/),
    }));
    expect(chain.unset).toHaveBeenCalledWith([
      "resetToken",
      "resetTokenHash",
      "resetTokenExpiresAt",
      "resetDeliveryToken",
    ]);
    expect(mockMarkSupabaseCredentialSourceApplied).toHaveBeenCalledWith({
      operationKey: "credential:change:reauth-token-hash",
      sourceRevision: "source-r2",
    });
    expect(mockCompleteSupabaseCredentialMirror).toHaveBeenCalledWith({
      operationKey: "credential:change:reauth-token-hash",
    });
  });

  test("blocks password changes during manual authentication fallback", async () => {
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "sanity",
      cutoverEnabled: true,
    });
    const response = createResponse();

    await handler(
      { method: "POST", body: { password: "new-password-value" } },
      response
    );

    expect(response.statusCode).toBe(503);
    expect(mockUpdateSupabaseAccountPassword).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

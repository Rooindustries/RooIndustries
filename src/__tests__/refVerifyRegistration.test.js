const mockFetch = jest.fn();
const mockCommit = jest.fn();
const mockPatch = jest.fn();
const mockCreateSupabaseCreatorAccount = jest.fn();
const mockCreateVerifiedSupabaseBrowserSession = jest.fn();
const mockInstallLegacySupabaseSession = jest.fn();
const mockSetReferralSessionCookie = jest.fn();
const mockRequireRateLimit = jest.fn();

jest.mock("../server/data/documentClient", () => ({
  createDataClient: () => ({ fetch: mockFetch, patch: mockPatch }),
}));

jest.mock("../server/supabase/accounts", () => ({
  createSupabaseCreatorAccount: (...args) =>
    mockCreateSupabaseCreatorAccount(...args),
  createVerifiedSupabaseBrowserSession: (...args) =>
    mockCreateVerifiedSupabaseBrowserSession(...args),
}));

jest.mock("../server/supabase/serverSession", () => ({
  installLegacySupabaseSession: (...args) =>
    mockInstallLegacySupabaseSession(...args),
}));

jest.mock("../server/supabase/shadowStore", () => ({
  hashShadowDocument: () => "a".repeat(64),
}));

jest.mock("../server/api/ref/auth", () => ({
  setReferralSessionCookie: (...args) => mockSetReferralSessionCookie(...args),
}));

jest.mock("../server/api/ref/rateLimit", () => ({
  getClientAddress: () => "203.0.113.8",
  requireRateLimit: (...args) => mockRequireRateLimit(...args),
}));

const handlerModule = require("../server/api/ref/verifyRegistration");
const handler = handlerModule.default || handlerModule;

const createResponse = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  setHeader(name, value) {
    this.headers[name] = value;
    return this;
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

const pendingReferral = {
  _id: "referral.creator",
  _rev: "revision-one",
  _type: "referral",
  name: "Creator",
  creatorEmail: "creator@example.com",
  creatorPassword:
    "$2b$12$0Omm7D6lCqK6hK2FdfQF.eprvq8EwJ38NU4xOGVhGxIpp02jW/9Xu",
  slug: { current: "creator" },
  registrationStatus: "pending_email",
};

describe("referral registration confirmation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireRateLimit.mockResolvedValue(true);
    mockCommit.mockResolvedValue({ _rev: "revision-two" });
    const chain = {
      ifRevisionId: jest.fn(() => chain),
      set: jest.fn(() => chain),
      unset: jest.fn(() => chain),
      commit: mockCommit,
    };
    mockPatch.mockReturnValue(chain);
    mockCreateSupabaseCreatorAccount.mockResolvedValue({
      userId: "e71a5687-daa6-4371-9700-5aef798fdd03",
    });
    mockCreateVerifiedSupabaseBrowserSession.mockResolvedValue({
      account: {
        principal_id: "e71a5687-daa6-4371-9700-5aef798fdd03",
        session_version: 1,
      },
      session: { access_token: "access", refresh_token: "refresh" },
    });
    mockInstallLegacySupabaseSession.mockResolvedValue(true);
  });

  test("rejects malformed tokens before reading account data", async () => {
    const response = createResponse();
    await handler(
      { method: "POST", body: { token: "too-short" }, headers: {} },
      response
    );

    expect(response.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("imports bcrypt, revision-locks activation, and creates the domain session", async () => {
    mockFetch
      .mockResolvedValueOnce(pendingReferral)
      .mockResolvedValueOnce({
        ...pendingReferral,
        _rev: "revision-two",
        registrationStatus: "active",
        passwordResetRequired: false,
      });
    const response = createResponse();

    await handler(
      { method: "POST", body: { token: "A".repeat(43) }, headers: {} },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(mockCreateSupabaseCreatorAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        passwordHash: pendingReferral.creatorPassword,
        referral: pendingReferral,
      })
    );
    const patch = mockPatch.mock.results[0].value;
    expect(patch.ifRevisionId).toHaveBeenCalledWith("revision-one");
    expect(patch.set).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationStatus: "active",
        passwordResetRequired: false,
      })
    );
    expect(patch.unset).toHaveBeenCalledWith([
      "registrationVerificationTokenHash",
      "registrationVerificationExpiresAt",
    ]);
    expect(mockSetReferralSessionCookie).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        authBackend: "supabase",
        code: "creator",
        referralId: "referral.creator",
      }),
      true
    );
    expect(response.headers["Cache-Control"]).toBe("private, no-store");
  });

  test("does not create a session after a revision conflict", async () => {
    mockFetch.mockResolvedValueOnce(pendingReferral);
    mockCommit.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    const response = createResponse();

    await handler(
      { method: "POST", body: { token: "B".repeat(43) }, headers: {} },
      response
    );

    expect(response.statusCode).toBe(400);
    expect(mockSetReferralSessionCookie).not.toHaveBeenCalled();
  });
});

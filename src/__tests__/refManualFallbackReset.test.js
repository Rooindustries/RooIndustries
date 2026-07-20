import crypto from "node:crypto";

const rawToken = "b".repeat(64);
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
const mockUpdateSupabaseAccountPassword = jest.fn();
const mockResumeSupabaseCredentialOperation = jest.fn();
const mockSendReferralEmailDirect = jest.fn();
const mockEnqueueReferralEmailMutation = jest.fn();
const mockDeliverReferralEmailDispatch = jest.fn();
const mockDataClientOptions = [];
const mockClient = {
  fetch: jest.fn(),
  patch: jest.fn(),
  transaction: jest.fn(),
};

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: (_config, options) => {
    mockDataClientOptions.push(options);
    return mockClient;
  },
}));

jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: () => ({
    primaryBackend: "sanity",
    cutoverEnabled: true,
    shadowWritesEnabled: true,
  }),
}));

jest.mock("../server/api/ref/rateLimit.js", () => ({
  getClientAddress: () => "203.0.113.40",
  requireRateLimit: jest.fn(async () => true),
}));

jest.mock("../server/supabase/accounts.js", () => {
  const actual = jest.requireActual("../server/supabase/accounts.js");
  return {
    ...actual,
    completeSupabaseCredentialMirror: jest.fn(),
    markSupabaseCredentialSourceApplied: jest.fn(),
    updateSupabaseAccountPassword: mockUpdateSupabaseAccountPassword,
  };
});

jest.mock("../server/supabase/credentialRecovery.js", () => ({
  reconcileSupabaseCredentialSource: jest.fn(),
  resumeSupabaseCredentialOperation: mockResumeSupabaseCredentialOperation,
}));

jest.mock("../server/api/ref/referralEmailDispatches.js", () => ({
  deliverReferralEmailDispatch: mockDeliverReferralEmailDispatch,
  enqueueReferralEmailMutation: mockEnqueueReferralEmailMutation,
  sendReferralEmailDirect: mockSendReferralEmailDirect,
}));

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe("manual referral credential fallback", () => {
  let forgot;
  let reset;
  let source;

  beforeAll(() => {
    const forgotModule = require("../server/api/ref/forgot.js");
    const resetModule = require("../server/api/ref/reset.js");
    forgot = forgotModule.default || forgotModule;
    reset = resetModule.default || resetModule;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    source = {
      _id: "referral.manual",
      _rev: "referral-r1",
      creatorPassword: `$2b$12$${"c".repeat(53)}`,
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    };
  });

  test("disables broad Supabase fallback for reset credential reads", () => {
    expect(mockDataClientOptions).toContainEqual({ allowLegacyFallback: false });
  });

  test("leaves an active reset link untouched while manual failover is selected", async () => {
    const first = createResponse();
    const second = createResponse();

    await reset(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.40" },
        body: { token: rawToken, password: "new-manual-password" },
      },
      first
    );
    await reset(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.40" },
        body: { token: rawToken, password: "new-manual-password" },
      },
      second
    );

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(503);
    expect(first.body.error).toContain("Existing reset links are unchanged");
    expect(source).toMatchObject({
      creatorPassword: `$2b$12$${"c".repeat(53)}`,
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(mockClient.fetch).not.toHaveBeenCalled();
    expect(mockClient.patch).not.toHaveBeenCalled();
    expect(mockClient.transaction).not.toHaveBeenCalled();
    expect(mockUpdateSupabaseAccountPassword).not.toHaveBeenCalled();
    expect(mockResumeSupabaseCredentialOperation).not.toHaveBeenCalled();
  });

  test("does not create or email a reset link during manual failover", async () => {
    const response = createResponse();

    await forgot(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.40" },
        body: { email: "manual@example.com" },
      },
      response
    );

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toContain("temporarily unavailable");
    expect(mockClient.fetch).not.toHaveBeenCalled();
    expect(mockClient.patch).not.toHaveBeenCalled();
    expect(mockSendReferralEmailDirect).not.toHaveBeenCalled();
    expect(mockEnqueueReferralEmailMutation).not.toHaveBeenCalled();
    expect(mockDeliverReferralEmailDispatch).not.toHaveBeenCalled();
  });
});

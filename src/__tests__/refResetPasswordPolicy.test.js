const mockFetch = jest.fn();
const mockPatch = jest.fn();
const mockResume = jest.fn();
const mockUpdate = jest.fn();
const mockReconcile = jest.fn();

jest.mock("bcryptjs", () => ({ hash: jest.fn(async () => `$2b$12$${"a".repeat(53)}`) }));
jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => ({ fetch: mockFetch, patch: mockPatch }),
}));
jest.mock("../server/api/ref/rateLimit.js", () => ({
  getClientAddress: () => "203.0.113.42", requireRateLimit: jest.fn(async () => true),
}));
jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: () => ({ primaryBackend: "supabase", shadowWritesEnabled: true }),
}));
jest.mock("../server/supabase/accounts.js", () => ({
  ...jest.requireActual("../server/supabase/accounts.js"),
  updateSupabaseAccountPassword: (...args) => mockUpdate(...args),
}));
jest.mock("../server/supabase/credentialRecovery.js", () => ({
  resumeSupabaseCredentialOperation: (...args) => mockResume(...args),
  reconcileSupabaseCredentialSource: (...args) => mockReconcile(...args),
}));

const reset = require("../server/api/ref/reset.js").default;
const response = () => ({
  statusCode: 200, body: null, setHeader: jest.fn(),
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

describe("referral reset password byte limits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      _id: "referral.creator", _supabaseRevision: "source-r1", creatorEmail: "creator@example.com",
      creatorPassword: "old-hash", resetTokenHash: "existing-reset-proof",
    });
    mockResume.mockResolvedValue({ resumed: false });
    mockUpdate.mockResolvedValue({ updated: true, operationKey: "credential:reset:fixture" });
    mockReconcile.mockResolvedValue({ completed: true });
  });

  test.each(["a".repeat(73), `${"é".repeat(36)}a`, `${"🔒".repeat(18)}a`])(
    "rejects oversized plaintext before resuming or consuming the reset: %s", async (password) => {
      const res = response();
      await reset({ method: "POST", body: { token: "a".repeat(64), password } }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain("72 UTF-8 bytes");
      expect(mockResume).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockPatch).not.toHaveBeenCalled();
    }
  );

  test.each(["a".repeat(72), "é".repeat(36), "🔒".repeat(18)])(
    "installs the exact password at the UTF-8 limit: %s", async (password) => {
      const res = response();
      await reset({ method: "POST", body: { token: "a".repeat(64), password } }, res);
      expect(res.statusCode).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ password }));
    }
  );
});

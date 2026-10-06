import crypto from "node:crypto";

const rawToken = "a".repeat(64);
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
let referral;
let mockOperation;
const previousDataPrimary = process.env.DATA_PRIMARY_BACKEND;

const conflict = () =>
  Object.assign(new Error("Revision changed"), { status: 409, statusCode: 409 });

const mockClient = {
  fetch: jest.fn(async (_query, params) => {
    if (
      referral.resetTokenHash !== params.tokenHash ||
      referral.resetTokenExpiresAt <= params.now
    ) {
      return null;
    }
    return { ...referral };
  }),
  patch: jest.fn(() => {
    const operations = { revision: "", set: {}, unset: [] };
    const patch = {
      ifRevisionId(revision) {
        operations.revision = revision;
        return patch;
      },
      set(values) {
        operations.set = { ...values };
        return patch;
      },
      unset(fields) {
        operations.unset = [...fields];
        return patch;
      },
      async commit() {
        await Promise.resolve();
        if (operations.revision !== referral._rev) throw conflict();
        Object.assign(referral, operations.set);
        operations.unset.forEach((field) => delete referral[field]);
        referral._rev = `${referral._rev}-next`;
        return { ...referral };
      },
    };
    return patch;
  }),
};

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => mockClient,
}));

jest.mock("../server/supabase/accounts.js", () => ({
  ...jest.requireActual("../server/supabase/accounts.js"),
  updateSupabaseAccountPassword: jest.fn(async options => {
    if (mockOperation) throw Object.assign(new Error("Reset already used"), { code: "23505" });
    mockOperation = options;
    return { updated: true, operationKey: options.operationKey };
  }),
}));

jest.mock("../server/supabase/credentialRecovery.js", () => ({
  resumeSupabaseCredentialOperation: jest.fn(async () => ({ resumed: false })),
  reconcileSupabaseCredentialSource: jest.fn(async () => {
    Object.assign(referral, mockOperation.sourceMutation.set);
    mockOperation.sourceMutation.unset.forEach(field => delete referral[field]);
    return { completed: true };
  }),
}));

const createRes = () => ({
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
  setHeader: jest.fn(),
});

describe("referral password reset concurrency", () => {
  let reset;

  beforeAll(() => {
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    const module = require("../server/api/ref/reset");
    reset = module.default || module;
  });

  afterAll(() => {
    if (previousDataPrimary === undefined) delete process.env.DATA_PRIMARY_BACKEND;
    else process.env.DATA_PRIMARY_BACKEND = previousDataPrimary;
  });

  beforeEach(() => {
    mockOperation = null;
    referral = {
      _id: "referral.reset-test",
      _rev: "revision-1",
      creatorEmail: "creator@example.invalid",
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    globalThis.__rooRateLimitBuckets?.clear?.();
    jest.clearAllMocks();
  });

  test("K1/O1 native saga: one reset token can change the password only once under concurrency", async () => {
    const first = createRes();
    const second = createRes();
    const request = (password) => ({
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.99" },
      body: { token: rawToken, password },
    });

    await Promise.all([
      reset(request("first-password-value"), first),
      reset(request("second-password-value"), second),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
    expect(referral.resetTokenHash).toBeUndefined();
    expect(referral.creatorPassword).toMatch(/^\$2[aby]\$/);
  });
});

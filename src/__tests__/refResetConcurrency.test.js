import crypto from "node:crypto";

const rawToken = "a".repeat(64);
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
let referral;

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
    return { _id: referral._id, _rev: referral._rev };
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

jest.mock("@sanity/client", () => ({
  createClient: () => mockClient,
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
    const module = require("../server/api/ref/reset");
    reset = module.default || module;
  });

  beforeEach(() => {
    referral = {
      _id: "referral.reset-test",
      _rev: "revision-1",
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    globalThis.__rooRateLimitBuckets?.clear?.();
    jest.clearAllMocks();
  });

  test("one reset token can change the password only once under concurrency", async () => {
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

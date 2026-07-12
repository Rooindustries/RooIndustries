const documents = new Map();
const mockSendVerification = jest.fn();
const mockClient = {
  fetch: jest.fn(async () => null),
  transaction() {
    const creates = [];
    const deletes = [];
    const transaction = {
      create(document) {
        creates.push({ ...document });
        return transaction;
      },
      delete(id) {
        deletes.push(id);
        return transaction;
      },
      async commit() {
        await Promise.resolve();
        if (creates.some((document) => documents.has(document._id))) {
          throw Object.assign(new Error("Document already exists"), {
            status: 409,
            statusCode: 409,
          });
        }
        deletes.forEach((id) => documents.delete(id));
        creates.forEach((document) => documents.set(document._id, document));
        return { transactionId: `tx-${documents.size}` };
      },
    };
    return transaction;
  },
};

jest.mock("@sanity/client", () => ({
  createClient: () => mockClient,
}));

jest.mock("resend", () => ({
  Resend: class {
    constructor() {
      this.emails = { send: (...args) => mockSendVerification(...args) };
    }
  },
}));

jest.mock("../server/supabase/serverSession", () => ({
  getLegacySupabaseUser: jest.fn(async () => null),
}));

const createRes = () => ({
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

describe("referral registration identity claims", () => {
  let register;

  beforeAll(() => {
    process.env.REF_SESSION_SECRET = "registration-test-session-secret";
    process.env.RESEND_API_KEY = "re_test";
    const module = require("../server/api/ref/register");
    register = module.default || module;
  });

  beforeEach(() => {
    documents.clear();
    mockClient.fetch.mockClear();
    mockSendVerification.mockReset();
    mockSendVerification.mockResolvedValue({ data: { id: "email_fixture" }, error: null });
    globalThis.__rooRateLimitBuckets?.clear?.();
  });

  test("two concurrent registrations cannot claim the same email", async () => {
    const requestFor = (slug) => ({
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.88" },
      body: {
        discordUsername: `Creator ${slug}`,
        email: "same@example.com",
        paypalEmail: `${slug}@example.com`,
        slug,
        password: "correct-horse-battery-staple",
      },
    });
    const first = createRes();
    const second = createRes();

    await Promise.all([
      register(requestFor("creator-one"), first),
      register(requestFor("creator-two"), second),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    expect(
      [...documents.values()].filter((document) => document._type === "referral")
    ).toHaveLength(1);
    expect(
      [...documents.values()].filter(
        (document) =>
          document._type === "referralIdentityClaim" && document.kind === "email"
      )
    ).toHaveLength(1);
    expect(mockSendVerification).toHaveBeenCalledTimes(1);
  });

  test("removes the pending account and both claims when email delivery fails", async () => {
    mockSendVerification.mockResolvedValue({
      data: null,
      error: new Error("provider unavailable"),
    });
    const response = createRes();

    await register(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.91" },
        body: {
          discordUsername: "Creator Failure",
          email: "failure@example.com",
          paypalEmail: "failure@example.com",
          slug: "creator-failure",
          password: "correct-horse-battery-staple",
        },
      },
      response
    );

    expect(response.statusCode).toBe(503);
    expect([...documents.values()]).toHaveLength(0);
  });
});

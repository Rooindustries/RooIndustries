const documents = new Map();
const mockClient = {
  fetch: jest.fn(async () => null),
  transaction() {
    const creates = [];
    const transaction = {
      create(document) {
        creates.push({ ...document });
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
    const module = require("../server/api/ref/register");
    register = module.default || module;
  });

  beforeEach(() => {
    documents.clear();
    mockClient.fetch.mockClear();
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

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(
      [...documents.values()].filter((document) => document._type === "referral")
    ).toHaveLength(1);
    expect(
      [...documents.values()].filter(
        (document) =>
          document._type === "referralIdentityClaim" && document.kind === "email"
      )
    ).toHaveLength(1);
  });
});

const documents = new Map();
const mockDispatches = new Map();
const previousDataPrimary = process.env.DATA_PRIMARY_BACKEND;
const mockSendVerification = jest.fn();
const testPassword = `fixture-${"x".repeat(24)}`;
const mockClient = {
  fetch: jest.fn(async () => null),
  patch(id) {
    const unsetFields = [];
    const patch = {
      unset(fields) {
        unsetFields.push(...fields);
        return patch;
      },
      async commit() {
        const document = documents.get(id);
        if (!document) throw new Error("Document not found");
        unsetFields.forEach((field) => delete document[field]);
        return { ...document };
      },
    };
    return patch;
  },
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

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => mockClient,
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

jest.mock("../server/supabase/accounts.js", () => ({
  resolveSupabaseCreatorRegistrationConflicts: jest.fn(async () => ({ emailReserved: false, referralCodeReserved: false })),
  resolveSupabaseAccountByUserId: jest.fn(async () => null),
  createSupabaseCreatorAccount: jest.fn(),
}));

jest.mock("../server/api/ref/referralEmailDispatches.js", () => ({
  enqueueReferralEmailMutation: jest.fn(async input => {
    let tx = mockClient.transaction();
    input.mutations.forEach(mutation => { tx = tx.create(mutation.document); });
    await tx.commit();
    const key = `dispatch:${input.referralId}`;
    mockDispatches.set(key, input);
    return { idempotency_key: key };
  }),
  deliverReferralEmailDispatch: jest.fn(async ({ idempotencyKey }) => {
    const input = mockDispatches.get(idempotencyKey);
    const result = await mockSendVerification(input, { idempotencyKey });
    return { sent: result.error ? 0 : 1, pending: result.error ? 1 : 0, deadLetter: 0 };
  }),
  requeueReferralEmailDispatch: jest.fn(async ({ referralId }) => ({ requeued: true, status: "pending", idempotency_key: `dispatch:${referralId}` })),
  isReferralEmailSourceStateConflict: () => false,
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
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    process.env.REF_SESSION_SECRET = "registration-test-session-secret";
    process.env.RESEND_API_KEY = "re_test";
    const module = require("../server/api/ref/register");
    register = module.default || module;
  });

  afterAll(() => {
    if (previousDataPrimary === undefined) delete process.env.DATA_PRIMARY_BACKEND;
    else process.env.DATA_PRIMARY_BACKEND = previousDataPrimary;
  });

  beforeEach(() => {
    documents.clear();
    mockDispatches.clear();
    mockClient.fetch.mockReset();
    mockClient.fetch.mockResolvedValue(null);
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
        password: testPassword,
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

  test("rejects a referral registration that collides with a coupon code", async () => {
    mockClient.fetch.mockImplementation(async (query) =>
      String(query).includes('_type == "coupon"')
        ? { _id: "coupon.creator" }
        : null
    );
    const response = createRes();

    await register(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.93" },
        body: {
          discordUsername: "Creator Collision",
          email: "collision@example.com",
          paypalEmail: "collision@example.com",
          slug: "save10",
          password: testPassword,
        },
      },
      response
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      ok: false,
      error: "Referral code already taken",
    });
    expect(documents.size).toBe(0);
    expect(mockSendVerification).not.toHaveBeenCalled();
  });

  test("O1/C2 native email queue keeps the committed pending account when email delivery is ambiguous", async () => {
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
          password: testPassword,
        },
      },
      response
    );

    expect(response.statusCode).toBe(202);
    expect(response.body.syncPending).toBe(true);
    expect(
      [...documents.values()].filter((document) => document._type === "referral")
    ).toHaveLength(1);
    expect(
      [...documents.values()].filter(
        (document) => document._type === "referralIdentityClaim"
      )
    ).toHaveLength(2);
  });

  test("O1 native verification queue requeues the same durable dispatch", async () => {
    const request = { method: "POST", headers: { "x-forwarded-for": "203.0.113.92" }, body: { discordUsername: "Creator Retry", email: "retry@example.com", paypalEmail: "retry@example.com", slug: "creator-retry", password: testPassword } };
    mockSendVerification.mockResolvedValueOnce({ data: null, error: new Error("response timed out") });
    const first = createRes();
    await register(request, first);
    const pending = [...documents.values()].find(document => document._type === "referral");
    expect(first.statusCode).toBe(202);
    expect(first.body.syncPending).toBe(true);
    expect(mockDispatches.size).toBe(1);
    expect(pending.registrationVerificationDeliveryToken).toBeUndefined();
    mockClient.fetch.mockImplementationOnce(async () => ({ ...pending }));
    const second = createRes();
    await register(request, second);
    expect(second.statusCode).toBe(202);
    expect(mockDispatches.size).toBe(1);
    expect(mockSendVerification).toHaveBeenCalledTimes(1);
    expect(require("../server/api/ref/referralEmailDispatches.js").requeueReferralEmailDispatch).toHaveBeenCalledWith({ referralId: pending._id, dispatchKind: "registration_verification" });
  });
});

import crypto from "node:crypto";

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
const originalRefSessionSecret = process.env.REF_SESSION_SECRET;
const testPassword = `fixture-${"x".repeat(24)}`;
const testSessionSecret = `fixture-${"s".repeat(64)}`;

const loadForgotHandler = () => {
  jest.resetModules();
  const fetch = jest.fn(async () => ({
    _id: "referral.creator",
    _rev: "revision-one",
    _type: "referral",
    name: "Creator",
    creatorEmail: "creator@example.com",
    resetToken: "legacy-token",
  }));
  const patch = jest.fn();
  const enqueueReferralEmailMutation = jest.fn(async () => ({
    idempotency_key: `referral-email-${"a".repeat(64)}`,
    status: "pending",
  }));
  const deliverReferralEmailDispatch = jest.fn(async () => ({
    claimed: true,
    sent: 0,
    retry: 1,
    deadLetter: 0,
    pending: true,
  }));
  const requeueReferralEmailDispatch = jest.fn(async () => ({
    status: "retry",
    requeued: true,
    sent: false,
  }));
  jest.doMock("../server/data/documentClient.js", () => ({
    createDataClient: () => ({ fetch, patch }),
  }));
  jest.doMock("../server/supabase/runtime.js", () => ({
    resolveSupabaseRuntimePolicy: () => ({ primaryBackend: "supabase" }),
  }));
  jest.doMock("../server/api/ref/rateLimit.js", () => ({
    getClientAddress: () => "203.0.113.1",
    requireRateLimit: jest.fn(async () => true),
  }));
  jest.doMock("../server/api/ref/referralEmailDispatches.js", () => ({
    enqueueReferralEmailMutation,
    deliverReferralEmailDispatch,
    requeueReferralEmailDispatch,
    sendReferralEmailDirect: jest.fn(),
  }));
  const module = require("../server/api/ref/forgot.js");
  return {
    handler: module.default || module,
    fetch,
    patch,
    enqueueReferralEmailMutation,
    deliverReferralEmailDispatch,
    requeueReferralEmailDispatch,
  };
};

const loadRegisterHandler = () => {
  jest.resetModules();
  const fetch = jest.fn(async () => null);
  const transactionCommit = jest.fn();
  const transaction = jest.fn(() => {
    const chain = {
      create: jest.fn(() => chain),
      delete: jest.fn(() => chain),
      commit: transactionCommit,
    };
    return chain;
  });
  const enqueueReferralEmailMutation = jest.fn(async () => ({
    idempotency_key: `referral-email-${"b".repeat(64)}`,
    status: "pending",
  }));
  const deliverReferralEmailDispatch = jest.fn(async () => ({
    claimed: true,
    sent: 0,
    retry: 1,
    deadLetter: 0,
    pending: true,
  }));
  const requeueReferralEmailDispatch = jest.fn(async () => ({
    status: "retry",
    requeued: true,
    sent: false,
  }));
  jest.doMock("../server/data/documentClient.js", () => ({
    createDataClient: () => ({ fetch, transaction }),
  }));
  jest.doMock("../server/supabase/runtime.js", () => ({
    resolveSupabaseRuntimePolicy: () => ({
      primaryBackend: "supabase",
      shadowWritesEnabled: true,
    }),
  }));
  jest.doMock("../server/supabase/serverSession.js", () => ({
    getLegacySupabaseUser: jest.fn(async () => null),
  }));
  jest.doMock("../server/supabase/accounts.js", () => ({
    createSupabaseCreatorAccount: jest.fn(),
    resolveSupabaseAccountByUserId: jest.fn(),
  }));
  jest.doMock("../server/supabase/shadowStore.js", () => ({
    hashShadowDocument: jest.fn(() => "a".repeat(64)),
  }));
  jest.doMock("../server/api/ref/auth.js", () => ({
    setReferralSessionCookie: jest.fn(),
  }));
  jest.doMock("../server/api/ref/rateLimit.js", () => ({
    getClientAddress: () => "203.0.113.2",
    requireRateLimit: jest.fn(async () => true),
  }));
  jest.doMock("../server/api/ref/referralEmailDispatches.js", () => ({
    enqueueReferralEmailMutation,
    deliverReferralEmailDispatch,
    requeueReferralEmailDispatch,
    sendReferralEmailDirect: jest.fn(),
  }));
  const module = require("../server/api/ref/register.js");
  return {
    handler: module.default || module,
    fetch,
    transaction,
    transactionCommit,
    enqueueReferralEmailMutation,
    deliverReferralEmailDispatch,
    requeueReferralEmailDispatch,
  };
};

const loadSanityForgotHandler = () => {
  jest.resetModules();
  const state = {
    _id: "referral.sanity",
    _rev: "revision-one",
    _type: "referral",
    name: "Sanity Creator",
    creatorEmail: "sanity@example.com",
    registrationStatus: "active",
  };
  const patch = jest.fn(() => {
    const values = {};
    const unsetFields = [];
    let expectedRevision = "";
    const chain = {
      ifRevisionId(revision) {
        expectedRevision = revision;
        return chain;
      },
      set(next) {
        Object.assign(values, next);
        return chain;
      },
      unset(fields) {
        unsetFields.push(...fields);
        return chain;
      },
      async commit() {
        await Promise.resolve();
        if (expectedRevision && expectedRevision !== state._rev) {
          throw Object.assign(new Error("revision conflict"), {
            status: 409,
            statusCode: 409,
          });
        }
        Object.assign(state, values);
        unsetFields.forEach((field) => delete state[field]);
        state._rev = `${state._rev}-next`;
        return { ...state };
      },
    };
    return chain;
  });
  const sendReferralEmailDirect = jest
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "timeout" }))
    .mockResolvedValueOnce({ providerMessageId: "provider-message" });
  jest.doMock("../server/data/documentClient.js", () => ({
    createDataClient: () => ({
      fetch: jest.fn(async () => ({ ...state })),
      patch,
    }),
  }));
  jest.doMock("../server/supabase/runtime.js", () => ({
    resolveSupabaseRuntimePolicy: () => ({ primaryBackend: "sanity" }),
  }));
  jest.doMock("../server/api/ref/rateLimit.js", () => ({
    getClientAddress: () => "203.0.113.3",
    requireRateLimit: jest.fn(async () => true),
  }));
  jest.doMock("../server/api/ref/referralEmailDispatches.js", () => ({
    enqueueReferralEmailMutation: jest.fn(),
    deliverReferralEmailDispatch: jest.fn(),
    requeueReferralEmailDispatch: jest.fn(),
    sendReferralEmailDirect,
  }));
  const module = require("../server/api/ref/forgot.js");
  return {
    handler: module.default || module,
    state,
    patch,
    sendReferralEmailDirect,
  };
};

describe("Supabase-primary referral email routes", () => {
  beforeEach(() => {
    process.env.REF_SESSION_SECRET = testSessionSecret;
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalRefSessionSecret === undefined) delete process.env.REF_SESSION_SECRET;
    else process.env.REF_SESSION_SECRET = originalRefSessionSecret;
  });

  test("atomically saves a reset token with its dispatch and reports pending delivery", async () => {
    const loaded = loadForgotHandler();
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.1" },
        body: { email: "creator@example.com" },
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      message: "Reset link sent",
      syncPending: true,
    });
    expect(loaded.enqueueReferralEmailMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        referralId: "referral.creator",
        dispatchKind: "password_reset",
        recipientEmail: "creator@example.com",
        mutations: [
          expect.objectContaining({
            operation: "replace",
            expected_revision: "revision-one",
            document: expect.not.objectContaining({ resetToken: expect.anything() }),
          }),
        ],
      })
    );
    expect(loaded.patch).not.toHaveBeenCalled();
    expect(loaded.deliverReferralEmailDispatch).toHaveBeenCalledWith({
      idempotencyKey: `referral-email-${"a".repeat(64)}`,
    });
  });

  test("requeues a dead-lettered reset before reporting pending delivery", async () => {
    const loaded = loadForgotHandler();
    loaded.deliverReferralEmailDispatch.mockResolvedValue({
      claimed: false,
      sent: 0,
      deadLetter: 1,
      pending: false,
    });
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.1" },
        body: { email: "creator@example.com" },
      },
      response
    );

    expect(response.body).toEqual({
      ok: true,
      message: "Reset link sent",
      syncPending: true,
    });
    expect(loaded.requeueReferralEmailDispatch).toHaveBeenCalledWith({
      referralId: "referral.creator",
      dispatchKind: "password_reset",
    });
  });

  test("does not claim a blocked dead-lettered reset was sent", async () => {
    const loaded = loadForgotHandler();
    loaded.deliverReferralEmailDispatch.mockResolvedValue({
      claimed: false,
      sent: 0,
      deadLetter: 1,
      pending: false,
    });
    loaded.requeueReferralEmailDispatch.mockResolvedValue({
      status: "dead_letter",
      dead_letter: true,
      requeued: false,
      sent: false,
      recovery_blocked_reason: "delivery_token_missing",
    });
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.1" },
        body: { email: "creator@example.com" },
      },
      response
    );

    expect(response.body).toEqual({
      ok: true,
      message: "If email exists, link sent.",
    });
  });

  test("reuses the Supabase source token while a credential reset is pending", async () => {
    process.env.REF_SESSION_SECRET = testSessionSecret;
    const loaded = loadForgotHandler();
    const request = {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.1" },
      body: { email: "creator@example.com" },
    };

    await loaded.handler(request, createResponse());
    const first = loaded.enqueueReferralEmailMutation.mock.calls[0][0];
    const persisted = first.mutations[0].document;
    expect(persisted.resetDeliveryToken).toMatch(/^v1\./);
    loaded.fetch.mockResolvedValue({ ...persisted });
    loaded.enqueueReferralEmailMutation.mockResolvedValue({
      idempotency_key: `referral-email-${"a".repeat(64)}`,
      status: "sent",
      replayed: true,
    });
    loaded.deliverReferralEmailDispatch.mockResolvedValue({
      claimed: false,
      sent: 1,
      pending: false,
    });

    await loaded.handler(request, createResponse());
    const second = loaded.enqueueReferralEmailMutation.mock.calls[1][0];

    expect(second.token).toBe(first.token);
    expect(second.mutations[0].document.resetTokenHash).toBe(
      first.mutations[0].document.resetTokenHash
    );
    expect(second.mutations[0].document.resetDeliveryToken).toBe(
      persisted.resetDeliveryToken
    );
    expect(loaded.deliverReferralEmailDispatch).toHaveBeenNthCalledWith(2, {
      idempotencyKey: `referral-email-${"a".repeat(64)}`,
    });
  });

  test("concurrent Supabase requests recover the committed reset token", async () => {
    const loaded = loadForgotHandler();
    let source = {
      _id: "referral.creator",
      _rev: "revision-one",
      _type: "referral",
      name: "Creator",
      creatorEmail: "creator@example.com",
      registrationStatus: "active",
    };
    let winnerToken = "";
    let providerSends = 0;
    loaded.fetch.mockImplementation(async () => ({ ...source }));
    loaded.enqueueReferralEmailMutation.mockImplementation(async (options) => {
      if (winnerToken && options.token === winnerToken) {
        return {
          idempotency_key: `referral-email-${"a".repeat(64)}`,
          status: "sent",
          replayed: true,
        };
      }
      const mutation = options.mutations[0];
      if (mutation.expected_revision !== source._rev) {
        throw Object.assign(new Error("source changed"), { code: "40001" });
      }
      winnerToken = options.token;
      source = { ...mutation.document, _rev: "revision-two" };
      return {
        idempotency_key: `referral-email-${"a".repeat(64)}`,
        status: "sent",
      };
    });
    loaded.deliverReferralEmailDispatch.mockImplementation(async () => {
      if (providerSends === 0) {
        providerSends += 1;
        return { claimed: true, sent: 1, pending: false };
      }
      return { claimed: false, sent: 1, pending: false };
    });
    const request = {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.1" },
      body: { email: "creator@example.com" },
    };
    const first = createResponse();
    const second = createResponse();

    await Promise.all([
      loaded.handler(request, first),
      loaded.handler(request, second),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(loaded.enqueueReferralEmailMutation).toHaveBeenCalledTimes(3);
    const firstToken = loaded.enqueueReferralEmailMutation.mock.calls[0][0].token;
    const recoveredToken = loaded.enqueueReferralEmailMutation.mock.calls[2][0].token;
    expect(recoveredToken).toBe(firstToken);
    expect(source.resetTokenHash).toBe(
      crypto.createHash("sha256").update(firstToken).digest("hex")
    );
    expect(source.resetDeliveryToken).toMatch(/^v1\./);
    expect(providerSends).toBe(1);
    expect(loaded.deliverReferralEmailDispatch).toHaveBeenCalledTimes(2);
    expect(
      loaded.deliverReferralEmailDispatch.mock.calls.map(([options]) =>
        options.idempotencyKey
      )
    ).toEqual([
      `referral-email-${"a".repeat(64)}`,
      `referral-email-${"a".repeat(64)}`,
    ]);
  });

  test("replaces a corrupt sealed Supabase reset token before enqueue", async () => {
    const loaded = loadForgotHandler();
    loaded.fetch.mockResolvedValue({
      _id: "referral.creator",
      _rev: "revision-corrupt",
      _type: "referral",
      name: "Creator",
      creatorEmail: "creator@example.com",
      registrationStatus: "active",
      resetTokenHash: "f".repeat(64),
      resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      resetDeliveryToken: "v1.corrupt",
    });

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.1" },
        body: { email: "creator@example.com" },
      },
      createResponse()
    );

    const enqueue = loaded.enqueueReferralEmailMutation.mock.calls[0][0];
    const document = enqueue.mutations[0].document;
    expect(document.resetDeliveryToken).toMatch(/^v1\./);
    expect(document.resetDeliveryToken).not.toBe("v1.corrupt");
    expect(document.resetTokenHash).toBe(
      crypto.createHash("sha256").update(enqueue.token).digest("hex")
    );
  });

  test("replaces an expired sealed Supabase reset token before enqueue", async () => {
    const loaded = loadForgotHandler();
    const request = {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.1" },
      body: { email: "creator@example.com" },
    };
    await loaded.handler(request, createResponse());
    const first = loaded.enqueueReferralEmailMutation.mock.calls[0][0];
    loaded.fetch.mockResolvedValue({
      ...first.mutations[0].document,
      _rev: "revision-expired",
      resetTokenExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    await loaded.handler(request, createResponse());
    const second = loaded.enqueueReferralEmailMutation.mock.calls[1][0];

    expect(second.token).not.toBe(first.token);
    expect(second.mutations[0].document.resetDeliveryToken).not.toBe(
      first.mutations[0].document.resetDeliveryToken
    );
  });

  test("creates registration documents and the verification dispatch in one RPC", async () => {
    const loaded = loadRegisterHandler();
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.2" },
        body: {
          discordUsername: "Creator",
          email: "creator@example.com",
          paypalEmail: "creator-paypal@example.com",
          slug: "creator-code",
          password: testPassword,
        },
      },
      response
    );

    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      pendingVerification: true,
      message: "Check your email to finish creating your account.",
      syncPending: true,
    });
    const enqueue = loaded.enqueueReferralEmailMutation.mock.calls[0][0];
    expect(enqueue.dispatchKind).toBe("registration_verification");
    expect(enqueue.recipientEmail).toBe("creator@example.com");
    expect(enqueue.mutations.map((mutation) => mutation.operation)).toEqual([
      "create",
      "create",
      "create",
    ]);
    expect(enqueue.mutations.map((mutation) => mutation.document._type).sort()).toEqual([
      "referral",
      "referralIdentityClaim",
      "referralIdentityClaim",
    ]);
    expect(loaded.transaction).not.toHaveBeenCalled();
    expect(loaded.transactionCommit).not.toHaveBeenCalled();
  });

  test("requeues a dead-lettered registration before returning success", async () => {
    const loaded = loadRegisterHandler();
    loaded.deliverReferralEmailDispatch.mockResolvedValue({
      claimed: false,
      sent: 0,
      deadLetter: 1,
      pending: false,
    });
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.2" },
        body: {
          discordUsername: "Creator",
          email: "creator@example.com",
          paypalEmail: "creator-paypal@example.com",
          slug: "creator-code",
          password: testPassword,
        },
      },
      response
    );

    expect(response.statusCode).toBe(202);
    expect(response.body.syncPending).toBe(true);
    expect(loaded.requeueReferralEmailDispatch).toHaveBeenCalledWith({
      referralId: expect.stringMatching(/^referral\./),
      dispatchKind: "registration_verification",
    });
  });

  test("recovers an existing pending Supabase registration instead of returning a conflict", async () => {
    const loaded = loadRegisterHandler();
    loaded.fetch.mockResolvedValueOnce({
      _id: "referral.pending",
      _rev: "pending-revision",
      name: "Creator",
      creatorEmail: "creator@example.com",
      slug: { current: "creator-code" },
      registrationStatus: "pending_email",
      registrationVerificationExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.2" },
        body: {
          discordUsername: "Creator",
          email: "creator@example.com",
          paypalEmail: "creator-paypal@example.com",
          slug: "creator-code",
          password: testPassword,
        },
      },
      response
    );

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      pendingVerification: true,
      syncPending: true,
    });
    expect(loaded.requeueReferralEmailDispatch).toHaveBeenCalledWith({
      referralId: "referral.pending",
      dispatchKind: "registration_verification",
    });
    expect(loaded.enqueueReferralEmailMutation).not.toHaveBeenCalled();
  });

  test("renews an expired Supabase registration without deleting its identity", async () => {
    const loaded = loadRegisterHandler();
    const existing = {
      _id: "referral.expired",
      _rev: "expired-revision",
      _type: "referral",
      name: "Old Creator",
      creatorEmail: "expired@example.com",
      slug: { _type: "slug", current: "expired-code" },
      registrationStatus: "pending_email",
      registrationVerificationExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    loaded.fetch
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    const response = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.4" },
        body: {
          discordUsername: "Renewed Creator",
          email: "expired@example.com",
          paypalEmail: "renewed-paypal@example.com",
          slug: "expired-code",
          password: testPassword,
        },
      },
      response
    );

    expect(response.statusCode).toBe(202);
    const enqueue = loaded.enqueueReferralEmailMutation.mock.calls[0][0];
    expect(enqueue.referralId).toBe("referral.expired");
    expect(enqueue.mutations).toEqual([
      expect.objectContaining({
        operation: "replace",
        expected_revision: "expired-revision",
        document: expect.objectContaining({ _id: "referral.expired" }),
      }),
    ]);
    expect(loaded.transaction).not.toHaveBeenCalled();
    expect(loaded.transactionCommit).not.toHaveBeenCalled();
  });

  test("reuses a sealed reset token after an ambiguous Sanity delivery", async () => {
    process.env.REF_SESSION_SECRET = testSessionSecret;
    const loaded = loadSanityForgotHandler();
    const request = {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.3" },
      body: { email: "sanity@example.com" },
    };
    const first = createResponse();
    await loaded.handler(request, first);
    expect(first.statusCode).toBe(500);
    expect(loaded.state.resetDeliveryToken).toMatch(/^v1\./);
    const firstToken = loaded.sendReferralEmailDirect.mock.calls[0][0].token;

    const second = createResponse();
    await loaded.handler(request, second);

    expect(second.statusCode).toBe(200);
    expect(loaded.sendReferralEmailDirect).toHaveBeenCalledTimes(2);
    expect(loaded.sendReferralEmailDirect.mock.calls[1][0].token).toBe(firstToken);
    expect(loaded.state.resetDeliveryToken).toMatch(/^v1\./);
  });

  test("concurrent Sanity reset requests converge on one deliverable token", async () => {
    process.env.REF_SESSION_SECRET = testSessionSecret;
    const loaded = loadSanityForgotHandler();
    loaded.sendReferralEmailDirect.mockReset().mockResolvedValue({
      providerMessageId: "provider-message",
    });
    const request = {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.3" },
      body: { email: "sanity@example.com" },
    };
    const first = createResponse();
    const second = createResponse();

    await Promise.all([
      loaded.handler(request, first),
      loaded.handler(request, second),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(loaded.sendReferralEmailDirect).toHaveBeenCalledTimes(2);
    const tokens = loaded.sendReferralEmailDirect.mock.calls.map(
      ([options]) => options.token
    );
    expect(new Set(tokens).size).toBe(1);
    expect(
      crypto.createHash("sha256").update(tokens[0]).digest("hex")
    ).toBe(loaded.state.resetTokenHash);
  });
});

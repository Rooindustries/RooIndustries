const createResponse = () => {
  const state = { status: 200, body: null, headers: {} };
  const response = {
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
      return response;
    },
    status(value) {
      state.status = value;
      return response;
    },
    json(value) {
      state.body = value;
      return value;
    },
  };
  return { response, state };
};

const loadHandler = async ({ authorized = true } = {}) => {
  jest.resetModules();
  const syncSanityCommerceChanges = jest.fn();
  const reconcilePaymentSessions = jest.fn();
  const reconcileBookingEmailDispatches = jest.fn();
  const cleanupExpiredRateLimitBuckets = jest.fn();
  const reconcileReverseMirror = jest.fn().mockResolvedValue({
    supported: true,
    attempted: 3,
    mirrored: 3,
    failed: 0,
  });

  jest.doMock("../server/api/payment/flow.js", () => ({
    authorizeCronRequest: jest.fn(() => {
      if (!authorized) throw Object.assign(new Error("Unauthorized"), { status: 403 });
    }),
    reconcilePaymentSessions,
  }));
  jest.doMock("../server/supabase/incrementalCommerceSync.js", () => ({
    syncSanityCommerceChanges,
  }));
  jest.doMock("../server/api/ref/rateLimit.js", () => ({
    cleanupExpiredRateLimitBuckets,
  }));
  jest.doMock("../server/api/ref/bookingEmails.js", () => ({
    reconcileBookingEmailDispatches,
  }));
  jest.doMock("../server/supabase/adminClient.js", () => ({
    isSupabaseAdminConfigured: jest.fn(() => true),
  }));
  jest.doMock("../server/api/payment/backend.js", () => ({
    createPaymentBackendClient: jest.fn(() => ({
      reconcileReverseMirror,
      shadowClient: null,
    })),
  }));

  const handler = require("../server/api/payment/reconcile.js").default;
  return {
    handler,
    syncSanityCommerceChanges,
    reconcilePaymentSessions,
    reconcileBookingEmailDispatches,
    cleanupExpiredRateLimitBuckets,
    reconcileReverseMirror,
  };
};

describe("payment reconciliation route authorization", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("rejects unauthenticated requests before any sync or recovery work", async () => {
    const loaded = await loadHandler({ authorized: false });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(403);
    expect(loaded.syncSanityCommerceChanges).not.toHaveBeenCalled();
    expect(loaded.reconcilePaymentSessions).not.toHaveBeenCalled();
    expect(loaded.reconcileReverseMirror).not.toHaveBeenCalled();
  });

  test("mirror-only scope drains the outbox without payments or emails", async () => {
    const loaded = await loadHandler();
    const { response, state } = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-reconcile-scope": "mirror-only" },
      },
      response
    );

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      ok: true,
      summary: {
        reverseMirror: {
          supported: true,
          attempted: 3,
          mirrored: 3,
          failed: 0,
        },
      },
    });
    expect(loaded.reconcileReverseMirror).toHaveBeenCalledWith({
      limit: 100,
      maxBatches: 10,
    });
    expect(loaded.syncSanityCommerceChanges).not.toHaveBeenCalled();
    expect(loaded.reconcilePaymentSessions).not.toHaveBeenCalled();
    expect(loaded.reconcileBookingEmailDispatches).not.toHaveBeenCalled();
    expect(loaded.cleanupExpiredRateLimitBuckets).not.toHaveBeenCalled();
  });
});

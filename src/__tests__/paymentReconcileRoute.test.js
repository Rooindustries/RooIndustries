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
  const events = [];
  const syncSanityCommerceChanges = jest.fn(async () => {
    events.push("incremental");
    return { supported: true, changed: 0 };
  });
  const reconcilePaymentSessions = jest.fn(async ({ backend }) => {
    events.push(`payment:${backend}`);
    return { httpStatus: 200, body: { ok: true, summary: { checked: 1 } } };
  });
  const reconcileBookingEmailDispatches = jest.fn(async () => ({}));
  const cleanupExpiredRateLimitBuckets = jest.fn(async () => 0);
  const reconcileCredentialOperations = jest.fn(async () => {
    events.push("credentials");
    return { checked: 0 };
  });
  const reconcileTourneyExternalOperations = jest.fn(async () => {
    events.push("tourney-external");
    return { claimed: 0, applied: 0 };
  });
  const reconcileTourneyEmailDispatches = jest.fn(async () => ({ claimed: 0, sent: 0 }));
  const reconcileTourneyMirror = jest.fn(async () => ({ enabled: false, failed: 0 }));
  const refreshTourneyCutoverClock = jest.fn(async () => ({ clean_since: null }));
  const resolveTourneyStorePolicy = jest.fn(() => ({ mirrorEnabled: false }));
  const runTourneyParity = jest.fn(async () => ({ status: "clean" }));
  const runTourneyShadowReadSamples = jest.fn(async () => ({ sampled: 10 }));
  const adminRpc = jest.fn(async (name) => {
    events.push(`rpc:${name}`);
    return { data: {}, error: null };
  });
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
    createSupabaseAdminClient: jest.fn(() => ({ rpc: adminRpc })),
    isSupabaseAdminConfigured: jest.fn(() => true),
  }));
  jest.doMock("../server/supabase/credentialRecovery.js", () => ({
    reconcileCredentialOperations,
  }));
  jest.doMock("../server/tourney/externalOperations.js", () => ({
    reconcileTourneyExternalOperations,
  }));
  jest.doMock("../server/tourney/emailDispatch.js", () => ({
    reconcileTourneyEmailDispatches,
  }));
  jest.doMock("../server/tourney/store.js", () => ({
    reconcileTourneyMirror,
    refreshTourneyCutoverClock,
    resolveTourneyStorePolicy,
    runTourneyParity,
    runTourneyShadowReadSamples,
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
    events,
    adminRpc,
    reconcileCredentialOperations,
    reconcileTourneyExternalOperations,
    reconcileTourneyEmailDispatches,
    reconcileTourneyMirror,
    refreshTourneyCutoverClock,
    resolveTourneyStorePolicy,
    runTourneyParity,
    runTourneyShadowReadSamples,
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

  test("tourney-only scope bypasses commerce and completes parity work", async () => {
    const loaded = await loadHandler();
    loaded.resolveTourneyStorePolicy.mockReturnValue({ mirrorEnabled: true });
    loaded.reconcileTourneyMirror.mockResolvedValue({ enabled: true, failed: 0 });
    const { response, state } = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-reconcile-scope": "tourney-only" },
      },
      response
    );

    expect(state.status).toBe(200);
    expect(state.body.ok).toBe(true);
    expect(state.body.summary.tourneyParity).toEqual({ status: "clean" });
    expect(loaded.reconcileTourneyExternalOperations).toHaveBeenCalledWith({ limit: 10 });
    expect(loaded.reconcileTourneyEmailDispatches).toHaveBeenCalledWith({ limit: 10 });
    expect(loaded.reconcileTourneyMirror).toHaveBeenCalledWith({ limit: 100 });
    expect(loaded.runTourneyShadowReadSamples).toHaveBeenCalledWith({ rounds: 10 });
    expect(loaded.refreshTourneyCutoverClock).toHaveBeenCalledTimes(1);
    expect(loaded.syncSanityCommerceChanges).not.toHaveBeenCalled();
    expect(loaded.reconcilePaymentSessions).not.toHaveBeenCalled();
    expect(loaded.reconcileReverseMirror).not.toHaveBeenCalled();
  });

  test("finishes payment recovery before the durable Tourney side-effect queue", async () => {
    const previous = process.env.SUPABASE_SOCIAL_AUTH_ENABLED;
    const previousHardening = process.env.TOURNEY_HARDENING_V4_ENABLED;
    const previousGuild = process.env.DISCORD_GUILD_ID;
    process.env.SUPABASE_SOCIAL_AUTH_ENABLED = "1";
    process.env.TOURNEY_HARDENING_V4_ENABLED = "1";
    process.env.DISCORD_GUILD_ID = "111111111111111111";
    try {
      const loaded = await loadHandler();
      const { response, state } = createResponse();
      await loaded.handler({ method: "GET", headers: {} }, response);
      expect(state.status).toBe(200);
      const externalIndex = loaded.events.indexOf("tourney-external");
      const paymentIndexes = loaded.events
        .map((event, index) => (event.startsWith("payment:") ? index : -1))
        .filter((index) => index >= 0);
      expect(paymentIndexes).toHaveLength(2);
      expect(externalIndex).toBeGreaterThan(Math.max(...paymentIndexes));
      expect(loaded.reconcileTourneyExternalOperations).toHaveBeenCalledWith({
        limit: 10,
      });
      expect(loaded.adminRpc).toHaveBeenCalledWith(
        "roo_reconcile_account_security",
        { p_guild_id: null }
      );
      expect(loaded.adminRpc).toHaveBeenCalledWith(
        "roo_record_reconciliation_checkpoint",
        expect.any(Object)
      );
    } finally {
      if (previous === undefined) delete process.env.SUPABASE_SOCIAL_AUTH_ENABLED;
      else process.env.SUPABASE_SOCIAL_AUTH_ENABLED = previous;
      if (previousHardening === undefined) delete process.env.TOURNEY_HARDENING_V4_ENABLED;
      else process.env.TOURNEY_HARDENING_V4_ENABLED = previousHardening;
      if (previousGuild === undefined) delete process.env.DISCORD_GUILD_ID;
      else process.env.DISCORD_GUILD_ID = previousGuild;
    }
  });
});

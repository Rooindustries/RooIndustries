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

const loadHandler = async ({
  authorized = true,
  primaryBackend = "supabase",
  sanityConfigured = true,
} = {}) => {
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
  const reconcileReferralEmailDispatches = jest.fn(async () => ({
    claimed: 0,
    sent: 0,
    retry: 0,
    deadLetter: 0,
  }));
  const cleanupExpiredRateLimitBuckets = jest.fn(async () => 0);
  const reconcileCredentialOperations = jest.fn(async () => {
    events.push("credentials");
    return { checked: 0 };
  });
  const refreshCommerceParityIfStale = jest.fn(async () => ({
    supported: true,
    skipped: false,
    mode: "verify",
    parity: { ok: true, compared: 204, failures: 0 },
  }));
  const runTourneyReconciliation = jest.fn(async () => {
    events.push("tourney-full");
    return {
      skipped: false,
      durationMs: 25,
      summary: { tourneyParity: { status: "clean" } },
    };
  });
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
  const reconcileDocumentMirror = jest.fn().mockResolvedValue({
    supported: true,
    attempted: 2,
    applied: 2,
    deadLettered: 0,
  });

  jest.doMock("../server/safeErrorLog.js", () => ({
    logSafeError: jest.fn(),
  }));
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
  jest.doMock("../server/api/ref/referralEmailDispatches.js", () => ({
    reconcileReferralEmailDispatches,
  }));
  jest.doMock("../server/supabase/adminClient.js", () => ({
    createSupabaseAdminClient: jest.fn(() => ({ rpc: adminRpc })),
    isSupabaseAdminConfigured: jest.fn(() => true),
  }));
  jest.doMock("../server/supabase/credentialRecovery.js", () => ({
    reconcileCredentialOperations,
  }));
  jest.doMock("../server/supabase/commerceParity.js", () => ({
    refreshCommerceParityIfStale,
  }));
  jest.doMock("../server/supabase/runtime.js", () => ({
    resolveSupabaseRuntimePolicy: jest.fn(() => ({
      commercePrimaryBackend: primaryBackend,
      commerceFailoverGeneration: 1,
    })),
  }));
  jest.doMock("../server/supabase/sanityConfiguration.cjs", () => ({
    inspectSanityConfiguration: jest.fn(() => ({
      status: sanityConfigured ? "complete" : "absent",
      writeConfigured: sanityConfigured,
    })),
  }));
  jest.doMock("../server/tourney/reconcile.js", () => ({
    runTourneyReconciliation,
  }));
  jest.doMock("../server/api/payment/backend.js", () => ({
    createPaymentBackendClient: jest.fn(() => ({
      reconcileReverseMirror,
      shadowClient: null,
    })),
  }));
  jest.doMock("../server/data/documentClient.js", () => ({
    createDocumentWriteClient: jest.fn(() => ({
      reconcileReverseMirror: reconcileDocumentMirror,
    })),
  }));

  const handler = require("../server/api/payment/reconcile.js").default;
  return {
    handler,
    syncSanityCommerceChanges,
    reconcilePaymentSessions,
    reconcileBookingEmailDispatches,
    reconcileReferralEmailDispatches,
    cleanupExpiredRateLimitBuckets,
    events,
    adminRpc,
    reconcileCredentialOperations,
    refreshCommerceParityIfStale,
    runTourneyReconciliation,
    reconcileReverseMirror,
    reconcileDocumentMirror,
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
    expect(loaded.reconcileReferralEmailDispatches).not.toHaveBeenCalled();
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
        documentMirror: {
          supported: true,
          attempted: 2,
          applied: 2,
          deadLettered: 0,
        },
      },
    });
    expect(loaded.reconcileReverseMirror).toHaveBeenCalledWith({
      limit: 100,
      maxBatches: 10,
    });
    expect(loaded.reconcileDocumentMirror).toHaveBeenCalledWith({
      limit: 100,
      maxBatches: 10,
      budgetMs: 60_000,
    });
    expect(loaded.syncSanityCommerceChanges).not.toHaveBeenCalled();
    expect(loaded.reconcilePaymentSessions).not.toHaveBeenCalled();
    expect(loaded.reconcileBookingEmailDispatches).not.toHaveBeenCalled();
    expect(loaded.reconcileReferralEmailDispatches).not.toHaveBeenCalled();
    expect(loaded.cleanupExpiredRateLimitBuckets).not.toHaveBeenCalled();
  });

  test("reports unconfigured Sanity as skipped without failing Supabase reconciliation", async () => {
    const loaded = await loadHandler({ sanityConfigured: false });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(200);
    expect(loaded.reconcilePaymentSessions).toHaveBeenCalledTimes(1);
    expect(loaded.reconcilePaymentSessions).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "supabase" })
    );
    expect(state.body.summary).toMatchObject({
      backendReconciliation: {
        supabase: { ok: true },
        sanity: { skipped: true, reason: "sanity_unconfigured" },
      },
      documentMirror: { skipped: true, reason: "sanity_unconfigured" },
      reverseMirror: { skipped: true, reason: "sanity_unconfigured" },
      commerceParity: { skipped: true, reason: "sanity_unconfigured" },
    });
    expect(loaded.adminRpc).toHaveBeenCalledWith(
      "roo_cleanup_expired_supabase_holds",
      { p_cutover_generation: 1, p_limit: 100 }
    );
  });

  test("falls back to guarded canonical mutations when the cleanup RPC is absent", async () => {
    const loaded = await loadHandler({ sanityConfigured: false });
    const expired = [
      {
        _id: "slotHold.expired-one",
        _rev: "revision-one",
        _type: "slotHold",
        backendOwner: "supabase",
        cutoverGeneration: 1,
        phase: "active",
        expiresAt: "2000-01-01T00:00:00.000Z",
        holdNonce: "old-one",
      },
      {
        _id: "slotHold.expired-two",
        _rev: "revision-two",
        _type: "slotHold",
        backendOwner: "supabase",
        cutoverGeneration: 1,
        phase: "payment_pending",
        expiresAt: "2000-01-02T00:00:00.000Z",
        holdNonce: "old-two",
      },
    ];
    loaded.adminRpc.mockImplementation(async (name, args) => {
      if (name === "roo_cleanup_expired_supabase_holds") {
        return { data: null, error: { code: "PGRST202" } };
      }
      if (name === "roo_fetch_shadow_documents_targeted") {
        return { data: expired, error: null };
      }
      if (name === "roo_apply_commerce_document_mutations") {
        return { data: { event_key: `event:${args.p_mutations[0].document._id}` }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(200);
    expect(state.body.summary.expiredSupabaseHoldCleanup).toEqual({
      expired_holds: 2,
      removed_slot_claims: null,
      mirror_events_enqueued: 2,
      cutover_generation: 1,
      fallback: "canonical_document_mutations",
    });
    expect(loaded.adminRpc).toHaveBeenCalledWith(
      "roo_fetch_shadow_documents_targeted",
      expect.objectContaining({
        p_document_types: ["slotHold"],
        p_limit: 100,
      })
    );
    const mutationCalls = loaded.adminRpc.mock.calls.filter(
      ([name]) => name === "roo_apply_commerce_document_mutations"
    );
    expect(mutationCalls).toHaveLength(2);
    for (const [, args] of mutationCalls) {
      expect(args).toMatchObject({
        p_cutover_generation: 1,
        p_mutations: [
          {
            operation: "replace",
            document: {
              phase: "expired",
              releaseReason: "expired_by_operational_cleanup",
            },
          },
        ],
      });
      expect(args.p_mutations[0].expected_revision).toMatch(/^revision-/);
      expect(args.p_mutations[0].document.holdNonce).not.toMatch(/^old-/);
    }
  });

  test("does not fail Supabase reconciliation when the Sanity pass fails", async () => {
    const loaded = await loadHandler();
    loaded.reconcilePaymentSessions.mockImplementation(async ({ backend }) => {
      if (backend === "sanity") throw new Error("Sanity unavailable");
      return { httpStatus: 200, body: { ok: true, summary: { checked: 1 } } };
    });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      summary: {
        backendReconciliation: {
          supabase: { ok: true },
          sanity: { ok: false, pending: true },
        },
      },
    });
  });

  test("keeps the manual Tourney scope while the shared scheduler uses a bounded budget", async () => {
    const loaded = await loadHandler();
    const { response, state } = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-reconcile-scope": "tourney-only" },
      },
      response
    );

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      ok: true,
      skipped: false,
      durationMs: 25,
      summary: { tourneyParity: { status: "clean" } },
    });
    expect(loaded.runTourneyReconciliation).toHaveBeenCalledWith();
    expect(loaded.syncSanityCommerceChanges).not.toHaveBeenCalled();
    expect(loaded.reconcilePaymentSessions).not.toHaveBeenCalled();
  });

  test("parity-only scope verifies commerce without payments, emails, or Tourney work", async () => {
    const loaded = await loadHandler();
    const { response, state } = createResponse();

    await loaded.handler(
      {
        method: "POST",
        headers: { "x-reconcile-scope": "parity-only" },
      },
      response
    );

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      ok: true,
      summary: {
        commerceParity: {
          supported: true,
          skipped: false,
          mode: "verify",
          parity: { ok: true, compared: 204, failures: 0 },
        },
      },
    });
    expect(loaded.refreshCommerceParityIfStale).toHaveBeenCalledWith({ force: true });
    expect(loaded.reconcilePaymentSessions).not.toHaveBeenCalled();
    expect(loaded.reconcileBookingEmailDispatches).not.toHaveBeenCalled();
    expect(loaded.reconcileReferralEmailDispatches).not.toHaveBeenCalled();
    expect(loaded.runTourneyReconciliation).not.toHaveBeenCalled();
  });

  test("safely skips Tourney reconciliation while another worker holds the lease", async () => {
    const loaded = await loadHandler();
    loaded.runTourneyReconciliation.mockResolvedValue({
      skipped: true,
      reason: "already_running",
      summary: {},
    });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(200);
    expect(state.body.summary.tourneyReconciliation).toEqual({
      skipped: true,
      reason: "already_running",
    });
    expect(loaded.adminRpc).toHaveBeenCalledWith(
      "roo_record_reconciliation_checkpoint",
      expect.any(Object)
    );
  });

  test("keeps payment recovery successful when Tourney reconciliation is pending", async () => {
    const loaded = await loadHandler();
    loaded.runTourneyReconciliation.mockRejectedValue(Object.assign(
      new Error("mirror unavailable"),
      {
        failedStage: "tourneyMirror",
        partialSummary: {
          tourneyExternalOperations: { claimed: 1, applied: 1 },
        },
      }
    ));
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      summary: {
        tourneyReconciliation: {
          pending: true,
          failedStage: "tourneyMirror",
          partialSummary: {
            tourneyExternalOperations: { claimed: 1, applied: 1 },
          },
        },
      },
    });
    expect(loaded.adminRpc).toHaveBeenCalledWith(
      "roo_record_reconciliation_checkpoint",
      expect.any(Object)
    );
  });

  test("runs referral email recovery even when payment reconciliation fails", async () => {
    const loaded = await loadHandler();
    loaded.reconcilePaymentSessions.mockResolvedValue({
      httpStatus: 503,
      body: {
        ok: false,
        error: "Payment reconciliation is temporarily unavailable.",
        summary: {},
      },
    });
    loaded.reconcileReferralEmailDispatches.mockResolvedValue({
      claimed: 1,
      sent: 1,
      retry: 0,
      deadLetter: 0,
    });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(503);
    expect(loaded.reconcileReferralEmailDispatches).toHaveBeenCalledWith({
      limit: 10,
    });
    expect(state.body.summary.referralEmailRecovery).toEqual({
      claimed: 1,
      sent: 1,
      retry: 0,
      deadLetter: 0,
    });
  });

  test("runs the Tourney worker independently on the shared payment schedule", async () => {
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
      expect(loaded.events).toContain("tourney-full");
      expect(loaded.events.filter((event) => event.startsWith("payment:"))).toHaveLength(2);
      expect(loaded.runTourneyReconciliation).toHaveBeenCalledWith({
        budgetMs: 90_000,
      });
      expect(loaded.reconcileDocumentMirror).toHaveBeenCalledWith({
        limit: 25,
        maxBatches: 4,
        budgetMs: 30_000,
      });
      expect(loaded.refreshCommerceParityIfStale).toHaveBeenCalledWith();
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

  test("runs document recovery even when payment reconciliation fails", async () => {
    const loaded = await loadHandler();
    loaded.reconcilePaymentSessions.mockResolvedValue({
      httpStatus: 503,
      body: {
        ok: false,
        error: "Payment reconciliation is temporarily unavailable.",
        summary: {},
      },
    });
    const { response, state } = createResponse();

    await loaded.handler({ method: "GET", headers: {} }, response);

    expect(state.status).toBe(503);
    expect(state.body).toMatchObject({
      ok: false,
      summary: {
        documentMirror: {
          supported: true,
          attempted: 2,
          applied: 2,
          deadLettered: 0,
        },
      },
    });
    expect(loaded.reconcileDocumentMirror).toHaveBeenCalledWith({
      limit: 25,
      maxBatches: 4,
      budgetMs: 30_000,
    });
  });
});

/** @jest-environment node */

const mockRpc = jest.fn();

const commerceReadiness = (overrides = {}) => ({
  last_parity: {
    completed_at: new Date().toISOString(),
    status: "completed",
    counters: {
      parity: {
        ok: true,
        failures: 0,
        compared: 10,
        mirrorPending: 0,
        capturedWithoutBooking: 0,
      },
    },
  },
  last_mirror_checkpoint: {
    event_key: "mirror-current",
    generation: 1,
    mirrored_at: new Date().toISOString(),
  },
  mirror: { pending: 0, dead_letters: 0, oldest_pending_at: null },
  captured_without_booking: 0,
  email_retries: 0,
  email_oldest_retry_at: null,
  coupon_mismatches: 0,
  referral_ambiguous: 0,
  recent_metrics: { sample_count: 30, p95_ms: 100, error_rate: 0 },
  duplicate_active_slots: 0,
  ...overrides,
});

const commerceIntegrity = (overrides = {}) => ({
  control: {
    primary_backend: "supabase",
    generation: 1,
    starts_paused: false,
  },
  mirror: { pending: 0, dead_letters: 0, oldest_age_seconds: 0 },
  orphan_claimed_proofs: 0,
  orphan_free_proofs: 0,
  command_conflicts: 0,
  full_projector_calls_in_commands: 0,
  ...overrides,
});

const releaseReadiness = (overrides = {}) => {
  const base = {
    documentMutationMirror: {
      pending: 1,
      dead_letters: 0,
      overdue: 0,
      ready: true,
    },
    referralFallbackAuthority: { ready: true },
    credentialRecovery: { pending: 0, oldestAt: null },
    identityDrift: { missing: 0, stale: 0 },
    creatorProjectionDrift: 0,
    parityAgeSeconds: 60,
    staleProviderRecovery: 0,
    capturedWithoutBooking: 0,
    reciprocalLinkMismatches: 0,
    duplicatePaymentAliases: 0,
    providerRecoveryCases: 0,
    rescheduleCases: 0,
    discordRetry: { pending: 0, oldestAt: null },
    oauthIntents: { expiredPending: 0, terminalOlderThanSevenDays: 0 },
  };
  return {
    ...base,
    ...overrides,
    documentMutationMirror: {
      ...base.documentMutationMirror,
      ...overrides.documentMutationMirror,
    },
    referralFallbackAuthority: {
      ...base.referralFallbackAuthority,
      ...overrides.referralFallbackAuthority,
    },
    credentialRecovery: {
      ...base.credentialRecovery,
      ...overrides.credentialRecovery,
    },
    identityDrift: { ...base.identityDrift, ...overrides.identityDrift },
    discordRetry: { ...base.discordRetry, ...overrides.discordRetry },
    oauthIntents: { ...base.oauthIntents, ...overrides.oauthIntents },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => Response.json(body, init) },
}));

jest.mock("../server/safeErrorLog.js", () => ({ logSafeError: jest.fn() }));

jest.mock("../server/supabase/adminClient.js", () => ({
  createSupabaseAdminClient: jest.fn(() => ({ rpc: mockRpc })),
}));

jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: jest.fn(() => ({
    commercePrimaryBackend: "supabase",
    commerceCutoverEnabled: true,
    commerceStartsPaused: false,
    commerceFailoverGeneration: 1,
  })),
}));

describe("commerce readiness route", () => {
  const previousAdminKey = process.env.REF_ADMIN_KEY;
  const previousCmsWritesPaused = process.env.CMS_WRITES_PAUSED;
  const previousStudioCmsWritesPaused =
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED;

  beforeEach(() => {
    process.env.REF_ADMIN_KEY = "readiness-secret";
    process.env.CMS_WRITES_PAUSED = "0";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "0";
    mockRpc.mockImplementation(async (name) => {
      if (name === "roo_commerce_readiness") {
        return { data: commerceReadiness(), error: null };
      }
      if (name === "roo_commerce_integrity_readiness") {
        return { data: commerceIntegrity(), error: null };
      }
      if (name === "roo_supabase_release_readiness") {
        return { data: releaseReadiness(), error: null };
      }
      if (name === "roo_referral_email_readiness") {
        return { data: { ready: true }, error: null };
      }
      if (name === "roo_cms_publish_readiness") {
        return {
          data: {
            ready: true,
            receipts: { processing: 0, ready: true },
            content_mirror: { ready: true },
            commerce_mirror: { ready: true },
            assets: { unverified_links: 0, ready: true },
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
  });

  afterAll(() => {
    if (previousAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = previousAdminKey;
    if (previousCmsWritesPaused === undefined) {
      delete process.env.CMS_WRITES_PAUSED;
    } else {
      process.env.CMS_WRITES_PAUSED = previousCmsWritesPaused;
    }
    if (previousStudioCmsWritesPaused === undefined) {
      delete process.env.SANITY_STUDIO_CMS_WRITES_PAUSED;
    } else {
      process.env.SANITY_STUDIO_CMS_WRITES_PAUSED =
        previousStudioCmsWritesPaused;
    }
  });

  test("exposes the durable document mirror acceptance gate", async () => {
    const { GET } =
      await import("../../app/api/admin/commerce-readiness/route.js");
    const response = await GET(
      new Request("https://example.test/readiness", {
        headers: { "x-admin-key": "readiness-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      commerceReady: true,
      ready: true,
      documentMutationMirrorReady: true,
      cmsReady: true,
      cmsBlockers: [],
      cmsControl: {
        writesPaused: false,
        studioWritesPaused: false,
        matches: true,
        ready: true,
      },
      globalCmsReady: true,
      globalCmsBlockers: [],
      cms: {
        receipts: { processing: 0, ready: true },
        content_mirror: { ready: true },
        commerce_mirror: { ready: true },
        assets: { unverified_links: 0, ready: true },
      },
      portClosure: {
        documentMutationMirror: {
          pending: 1,
          dead_letters: 0,
          overdue: 0,
          ready: true,
        },
        referralFallbackAuthority: { ready: true },
      },
    });
  });

  test("fails the top-level gate when the document mirror has a dead letter", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: commerceReadiness(), error: null })
      .mockResolvedValueOnce({ data: commerceIntegrity(), error: null })
      .mockResolvedValueOnce({
        data: releaseReadiness({
          documentMutationMirror: {
            pending: 1,
            dead_letters: 1,
            overdue: 1,
            ready: false,
          },
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { ready: true }, error: null });
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      commerceReady: true,
      ready: false,
      documentMutationMirrorReady: false,
    });
  });

  test("derives health from migrated metrics and deployment control", async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: commerceReadiness({ captured_without_booking: 1 }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: commerceIntegrity({
          control: {
            primary_backend: "supabase",
            generation: 2,
            starts_paused: false,
          },
        }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: releaseReadiness(),
        error: null,
      })
      .mockResolvedValueOnce({ data: { ready: true }, error: null });
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body).toMatchObject({
      commerceReady: false,
      commerceBlockers: expect.arrayContaining(["captured_without_booking"]),
      controlMatchesDeployment: false,
      ready: false,
    });
  });

  test.each([
    [
      "stale parity",
      commerceReadiness({
        last_parity: {
          completed_at: "2020-01-01T00:00:00.000Z",
          status: "completed",
          counters: {
            parity: {
              ok: true,
              failures: 0,
              compared: 10,
              mirrorPending: 0,
              capturedWithoutBooking: 0,
            },
          },
        },
      }),
      "parity_stale",
    ],
    [
      "parity drift",
      commerceReadiness({
        last_parity: {
          completed_at: new Date().toISOString(),
          status: "failed",
          counters: {
            parity: {
              ok: false,
              failures: 1,
              compared: 10,
              mirrorPending: 0,
              capturedWithoutBooking: 0,
            },
          },
        },
      }),
      "parity_drift",
    ],
    [
      "early parity failure",
      commerceReadiness({
        last_parity: {
          completed_at: new Date().toISOString(),
          status: "failed",
          counters: { mode: "verify" },
        },
      }),
      "parity_invalid",
    ],
    [
      "missing checkpoint",
      commerceReadiness({ last_mirror_checkpoint: null }),
      "mirror_checkpoint_invalid",
    ],
    [
      "zero traffic samples",
      commerceReadiness({
        recent_metrics: { sample_count: 0, p95_ms: 0, error_rate: 0 },
      }),
      "traffic_samples_insufficient",
    ],
    [
      "high p95",
      commerceReadiness({
        recent_metrics: { sample_count: 30, p95_ms: 750, error_rate: 0 },
      }),
      "traffic_p95_exceeded",
    ],
    [
      "high error rate",
      commerceReadiness({
        recent_metrics: { sample_count: 30, p95_ms: 100, error_rate: 1 },
      }),
      "traffic_error_rate_exceeded",
    ],
    [
      "future mirror queue timestamp",
      commerceReadiness({
        mirror: {
          pending: 1,
          dead_letters: 0,
          oldest_pending_at: new Date(Date.now() + 61_000).toISOString(),
        },
      }),
      "mirror_overdue",
    ],
    [
      "future email queue timestamp",
      commerceReadiness({
        email_retries: 1,
        email_oldest_retry_at: new Date(Date.now() + 61_000).toISOString(),
      }),
      "email_retry_overdue",
    ],
  ])("blocks release readiness for %s", async (_label, metrics, blocker) => {
    mockRpc
      .mockResolvedValueOnce({ data: metrics, error: null })
      .mockResolvedValueOnce({ data: commerceIntegrity(), error: null })
      .mockResolvedValueOnce({
        data: releaseReadiness(),
        error: null,
      })
      .mockResolvedValueOnce({ data: { ready: true }, error: null });
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body.ready).toBe(false);
    expect(body.commerceBlockers).toContain(blocker);
  });

  test.each([
    [
      "overdue credential recovery",
      releaseReadiness({
        credentialRecovery: {
          pending: 1,
          oldestAt: new Date(Date.now() - 301_000).toISOString(),
        },
      }),
      "credential_recovery_overdue",
    ],
    [
      "missing identity projection",
      releaseReadiness({ identityDrift: { missing: 1 } }),
      "identity_drift_missing",
    ],
    [
      "stale identity projection",
      releaseReadiness({ identityDrift: { stale: 1 } }),
      "identity_drift_stale",
    ],
    [
      "creator projection drift",
      releaseReadiness({ creatorProjectionDrift: 1 }),
      "creator_projection_drift",
    ],
    [
      "duplicate payment alias",
      releaseReadiness({ duplicatePaymentAliases: 1 }),
      "duplicate_payment_aliases",
    ],
    [
      "stale provider recovery",
      releaseReadiness({ staleProviderRecovery: 1 }),
      "stale_provider_recovery",
    ],
    [
      "captured payment without booking",
      releaseReadiness({ capturedWithoutBooking: 1 }),
      "port_captured_without_booking",
    ],
    [
      "reciprocal payment link mismatch",
      releaseReadiness({ reciprocalLinkMismatches: 1 }),
      "reciprocal_link_mismatches",
    ],
    [
      "provider recovery case",
      releaseReadiness({ providerRecoveryCases: 1 }),
      "provider_recovery_cases",
    ],
    [
      "unresolved reschedule case",
      releaseReadiness({ rescheduleCases: 1 }),
      "reschedule_cases",
    ],
    [
      "overdue Discord retry",
      releaseReadiness({
        discordRetry: {
          pending: 1,
          oldestAt: new Date(Date.now() - 301_000).toISOString(),
        },
      }),
      "discord_retry_overdue",
    ],
    [
      "expired OAuth intent",
      releaseReadiness({ oauthIntents: { expiredPending: 1 } }),
      "oauth_intents_expired_pending",
    ],
    [
      "stale terminal OAuth intent",
      releaseReadiness({
        oauthIntents: { terminalOlderThanSevenDays: 1 },
      }),
      "oauth_intents_cleanup_overdue",
    ],
    [
      "stale port parity",
      releaseReadiness({ parityAgeSeconds: 901 }),
      "port_parity_stale",
    ],
    [
      "fallback authority not ready",
      releaseReadiness({ referralFallbackAuthority: { ready: false } }),
      "referral_fallback_authority_not_ready",
    ],
    [
      "invalid projection metric type",
      releaseReadiness({ creatorProjectionDrift: "0" }),
      "readiness_schema_invalid:portClosure.creatorProjectionDrift",
    ],
  ])("blocks port closure for %s", async (_label, portClosure, blocker) => {
    mockRpc
      .mockResolvedValueOnce({ data: commerceReadiness(), error: null })
      .mockResolvedValueOnce({ data: commerceIntegrity(), error: null })
      .mockResolvedValueOnce({ data: portClosure, error: null })
      .mockResolvedValueOnce({ data: { ready: true }, error: null });
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body.ready).toBe(false);
    expect(body.portClosureReady).toBe(false);
    expect(body.portClosureBlockers).toContain(blocker);
  });

  test("fails closed on a partial readiness RPC shape", async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: {
          ...commerceReadiness(),
          mirror: { pending: 0, oldest_pending_at: null },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: commerceIntegrity(), error: null })
      .mockResolvedValueOnce({
        data: releaseReadiness(),
        error: null,
      })
      .mockResolvedValueOnce({ data: { ready: true }, error: null });
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body.ready).toBe(false);
    expect(body.commerceBlockers).toContain(
      "readiness_schema_invalid:mirror.dead_letters"
    );
  });

  test("fails the top-level gate when CMS receipts, mirrors, or assets are unsafe", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: commerceReadiness(), error: null })
      .mockResolvedValueOnce({ data: commerceIntegrity(), error: null })
      .mockResolvedValueOnce({ data: releaseReadiness(), error: null })
      .mockResolvedValueOnce({ data: { ready: true }, error: null })
      .mockResolvedValueOnce({
        data: {
          ready: false,
          receipts: { processing: 1, ready: false },
          content_mirror: { ready: true },
          commerce_mirror: { ready: false, dead_letters: 1 },
          assets: { ready: false, unverified_links: 1 },
        },
        error: null,
      });
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body).toMatchObject({ ready: false, cmsReady: false });
  });

  test("surfaces the rollback pause and blocks global readiness", async () => {
    process.env.CMS_WRITES_PAUSED = "1";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "1";
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body).toMatchObject({
      ready: false,
      cmsReady: false,
      globalCmsReady: false,
      cmsBlockers: ["cms_writes_paused"],
      cmsControl: {
        writesPaused: true,
        studioWritesPaused: true,
        matches: true,
        ready: false,
      },
    });
  });

  test("surfaces an API and Studio pause mismatch as a blocker", async () => {
    process.env.CMS_WRITES_PAUSED = "0";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "1";
    const { GET } = await import(
      "../../app/api/admin/commerce-readiness/route.js"
    );
    const response = await GET(new Request("https://example.test/readiness", {
      headers: { "x-admin-key": "readiness-secret" },
    }));
    const body = await response.json();

    expect(body).toMatchObject({
      ready: false,
      cmsReady: false,
      globalCmsBlockers: ["cms_write_pause_mismatch"],
      globalCmsControl: {
        writesPaused: false,
        studioWritesPaused: true,
        matches: false,
      },
    });
  });
});

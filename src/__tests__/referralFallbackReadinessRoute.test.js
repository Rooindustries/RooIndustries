/** @jest-environment node */

const mockRpc = jest.fn();
const healthyCommerceReadiness = () => ({
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
});

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

const portClosure = (authorityReady = true) => ({
  documentMutationMirror: { ready: true, dead_letters: 0, overdue: 0 },
  credentialRecovery: { pending: 0, oldestAt: null },
  identityDrift: { missing: 0, stale: 0 },
  creatorProjectionDrift: 0,
  parityAgeSeconds: 60,
  staleProviderRecovery: 0,
  capturedWithoutBooking: 0,
  reciprocalLinkMismatches: 0,
  duplicatePaymentAliases: 0,
  validPaymentAliases: 0,
  paymentAliasesTotal: 0,
  invalidPaymentAliases: 0,
  providerRecoveryCases: 0,
  rescheduleCases: 0,
  openRescheduleCases: 0,
  notifiedRescheduleCases: 0,
  unnotifiedRescheduleCases: 0,
  discordRetry: { pending: 0, oldestAt: null },
  oauthIntents: { expiredPending: 0, terminalOlderThanSevenDays: 0 },
  referralFallbackAuthority: {
    ready: authorityReady,
    healthy: authorityReady,
    missingAuthorities: authorityReady ? 0 : 1,
    mirror: { actionable: authorityReady ? 0 : 1, deadLetter: 0 },
  },
});

describe("referral fallback authority readiness", () => {
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
        return { data: healthyCommerceReadiness(), error: null };
      }
      if (name === "roo_commerce_integrity_readiness") {
        return {
          data: {
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
          },
          error: null,
        };
      }
      if (name === "roo_supabase_release_readiness") {
        return { data: portClosure(true), error: null };
      }
      if (name === "roo_referral_email_readiness") {
        return { data: { ready: true }, error: null };
      }
      if (name === "roo_cms_publish_readiness") {
        return { data: { ready: true }, error: null };
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

  test("composes the existing port gates with the authority gate", async () => {
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
      ready: true,
      documentMutationMirrorReady: true,
      referralFallbackAuthorityReady: true,
      portClosure: {
        credentialRecovery: { pending: 0 },
        identityDrift: { missing: 0, stale: 0 },
        referralFallbackAuthority: { ready: true },
      },
    });
    expect(mockRpc).toHaveBeenCalledWith("roo_supabase_release_readiness");
  });

  test("blocks release readiness when the authority is incomplete", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: healthyCommerceReadiness(), error: null })
      .mockResolvedValueOnce({
        data: {
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
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: portClosure(false), error: null })
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
      documentMutationMirrorReady: true,
      referralFallbackAuthorityReady: false,
    });
  });
});

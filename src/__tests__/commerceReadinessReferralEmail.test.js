const rpc = jest.fn();
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
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => ({ rpc }),
}));
jest.mock("../server/supabase/runtime", () => ({
  resolveSupabaseRuntimePolicy: () => ({
    commercePrimaryBackend: "supabase",
    commerceCutoverEnabled: true,
    commerceStartsPaused: false,
    commerceFailoverGeneration: 1,
  }),
}));

const { GET } = require("../../app/api/admin/commerce-readiness/route");
const originalAdminKey = process.env.REF_ADMIN_KEY;
const originalCmsWritesPaused = process.env.CMS_WRITES_PAUSED;
const originalStudioCmsWritesPaused =
  process.env.SANITY_STUDIO_CMS_WRITES_PAUSED;

const request = (key = "readiness-secret") => ({
  headers: { get: (name) => (name === "x-admin-key" ? key : "") },
});
let emailReady = true;

describe("commerce readiness referral email metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REF_ADMIN_KEY = "readiness-secret";
    process.env.CMS_WRITES_PAUSED = "0";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "0";
    emailReady = true;
    rpc.mockImplementation(async (name) => {
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
        return {
          data: {
            documentMutationMirror: { ready: true },
            referralFallbackAuthority: { ready: true },
            credentialRecovery: { pending: 0, oldestAt: null },
            identityDrift: { missing: 0, stale: 0 },
            creatorProjectionDrift: 0,
            parityAgeSeconds: 60,
            staleProviderRecovery: 0,
            duplicatePaymentAliases: 0,
            capturedWithoutBooking: 0,
            reciprocalLinkMismatches: 0,
            providerRecoveryCases: 0,
            rescheduleCases: 0,
            discordRetry: { pending: 0, oldestAt: null },
            oauthIntents: {
              expiredPending: 0,
              terminalOlderThanSevenDays: 0,
            },
          },
          error: null,
        };
      }
      if (name === "roo_referral_email_readiness") {
        return {
          data: {
            ready: emailReady,
            healthy: emailReady,
            status_counts: { pending: 2, sent: 5 },
            actionable: 2,
            dead_letters: 0,
            stale_actionable: 0,
            overdue_over_300_seconds: 0,
            expired_leases: 0,
            oldest_actionable_age_seconds: 45,
            oldest_overdue_age_seconds: 0,
          },
          error: null,
        };
      }
      if (name === "roo_cms_publish_readiness") {
        return { data: { ready: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = originalAdminKey;
    if (originalCmsWritesPaused === undefined) {
      delete process.env.CMS_WRITES_PAUSED;
    } else {
      process.env.CMS_WRITES_PAUSED = originalCmsWritesPaused;
    }
    if (originalStudioCmsWritesPaused === undefined) {
      delete process.env.SANITY_STUDIO_CMS_WRITES_PAUSED;
    } else {
      process.env.SANITY_STUDIO_CMS_WRITES_PAUSED =
        originalStudioCmsWritesPaused;
    }
  });

  test("returns aggregate dispatch health without recipient fields", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.referralEmailReady).toBe(true);
    expect(body.referralEmails).toEqual({
      ready: true,
      healthy: true,
      status_counts: { pending: 2, sent: 5 },
      actionable: 2,
      dead_letters: 0,
      stale_actionable: 0,
      overdue_over_300_seconds: 0,
      expired_leases: 0,
      oldest_actionable_age_seconds: 45,
      oldest_overdue_age_seconds: 0,
    });
    expect(JSON.stringify(body.referralEmails)).not.toMatch(/email|recipient|token/i);
    expect(rpc).toHaveBeenCalledWith("roo_referral_email_readiness");
  });

  test("blocks release readiness when referral email recovery is unhealthy", async () => {
    emailReady = false;
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ready).toBe(false);
    expect(body.referralEmailReady).toBe(false);
  });
});

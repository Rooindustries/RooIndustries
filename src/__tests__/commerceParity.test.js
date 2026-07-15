import { refreshCommerceParityIfStale } from "../server/supabase/commerceParity";

const document = {
  _id: "booking-settings",
  _type: "bookingSettings",
  _updatedAt: "2026-07-15T12:00:00.000Z",
};

const typedSummary = {
  bookings: { source: 1, typed: 1 },
  payments: { source: 1, typed: 1 },
  coupons: { source: 1, typed: 1 },
  holds: { source: 1, typed: 1 },
  email_dispatches: { source: 1, typed: 1 },
  referral_ledger: { source: 1, typed: 1 },
  refunds: { source: 1, typed: 1 },
};

const clientWith = ({ readiness, targetHash = "hash-1" } = {}) => {
  const calls = [];
  const rpc = jest.fn(async (name, parameters = {}) => {
    calls.push({ name, parameters });
    const data = {
      roo_commerce_readiness: readiness || {
        last_parity: null,
        mirror: { pending: 0 },
        captured_without_booking: 0,
        email_retries: 0,
      },
      roo_start_sync_run: "run-1",
      roo_hash_canonical_documents: [{ id: document._id, hash: "hash-1" }],
      roo_commerce_canonical_manifest_for_types: [
        { id: document._id, type: document._type, hash: targetHash, tombstoned: false },
      ],
      roo_commerce_typed_gap_summary: typedSummary,
      roo_finish_sync_run: { completed: true },
    }[name];
    return { data, error: null };
  });
  return { client: { rpc }, calls, rpc };
};

const env = {
  NODE_ENV: "test",
  DATA_PRIMARY_BACKEND: "sanity",
  COMMERCE_PRIMARY_BACKEND: "supabase",
  COMMERCE_CUTOVER_ENABLED: "1",
  COMMERCE_FAILOVER_GENERATION: "1",
  COMMERCE_STARTS_PAUSED: "1",
  SANITY_REVERSE_MIRROR_WRITES: "1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

describe("Supabase-primary commerce parity refresh", () => {
  test("records a full read-only compare run without importing documents", async () => {
    const { client, rpc } = clientWith();
    const sanityClient = { fetch: jest.fn(async () => [document]) };

    const result = await refreshCommerceParityIfStale({
      env,
      force: true,
      sanityClient,
      supabaseClient: client,
    });

    expect(result).toMatchObject({
      supported: true,
      skipped: false,
      mode: "verify",
      documents: 1,
      parity: { ok: true, compared: 1, failures: 0 },
    });
    expect(rpc).toHaveBeenCalledWith("roo_start_sync_run", {
      p_direction: "compare",
      p_mode: "shadow",
      p_source_cursor: document._updatedAt,
    });
    expect(rpc).toHaveBeenCalledWith("roo_finish_sync_run", expect.objectContaining({
      p_run_id: "run-1",
      p_status: "completed",
      p_counters: expect.objectContaining({ mode: "verify" }),
    }));
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      "roo_import_and_project_commerce_shadow_batch"
    );
  });

  test("skips the Sanity read while the latest verified parity is fresh", async () => {
    const { client, rpc } = clientWith({
      readiness: {
        last_parity: {
          direction: "compare",
          status: "completed",
          completed_at: new Date().toISOString(),
          counters: { mode: "verify" },
        },
      },
    });
    const sanityClient = { fetch: jest.fn() };

    await expect(refreshCommerceParityIfStale({
      env,
      sanityClient,
      supabaseClient: client,
    })).resolves.toEqual({
      supported: true,
      skipped: true,
      reason: "parity_fresh",
    });
    expect(sanityClient.fetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("roo_start_sync_run", expect.anything());
  });

  test("records drift as a failed run and refuses a false green result", async () => {
    const { client, rpc } = clientWith({ targetHash: "different-hash" });
    const sanityClient = { fetch: jest.fn(async () => [document]) };

    await expect(refreshCommerceParityIfStale({
      env,
      force: true,
      sanityClient,
      supabaseClient: client,
    })).rejects.toMatchObject({ code: "COMMERCE_PARITY_FAILED" });
    expect(rpc).toHaveBeenCalledWith("roo_finish_sync_run", expect.objectContaining({
      p_status: "failed",
      p_counters: expect.objectContaining({
        parity: expect.objectContaining({ ok: false, failures: 1 }),
      }),
    }));
  });

  test("does nothing while Sanity remains the commerce primary", async () => {
    await expect(refreshCommerceParityIfStale({
      env: { ...env, COMMERCE_PRIMARY_BACKEND: "sanity" },
      sanityClient: { fetch: jest.fn() },
      supabaseClient: { rpc: jest.fn() },
    })).resolves.toEqual({
      supported: false,
      skipped: true,
      reason: "supabase_not_primary",
    });
  });
});

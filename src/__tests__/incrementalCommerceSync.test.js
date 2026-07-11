import { syncSanityCommerceChanges } from "../server/supabase/incrementalCommerceSync";

const env = {
  DATA_PRIMARY_BACKEND: "sanity",
  COMMERCE_PRIMARY_BACKEND: "sanity",
  SUPABASE_SHADOW_WRITES: "1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "test-secret",
};

const payment = {
  _id: "payment.one",
  _type: "paymentRecord",
  _rev: "revision-two",
  _createdAt: "2026-07-12T00:00:00.000Z",
  _updatedAt: "2026-07-12T00:05:00.000Z",
  status: "started",
};

const createSanityClient = () => ({
  fetch: jest.fn(async (query) =>
    query.includes("]._id") ? [payment._id] : [payment]
  ),
});

const createSupabaseClient = ({ targetHash = "same-hash" } = {}) => ({
  rpc: jest.fn(async (name) => {
    const responses = {
      roo_claim_commerce_sync_cursor: {
        claimed: true,
        cursor_value: null,
      },
      roo_start_sync_run: "00000000-0000-4000-8000-000000000001",
      roo_import_and_project_commerce_shadow_batch: {
        import: { imported: 1, skipped_stale: 0 },
      },
      roo_hash_canonical_documents: [
        { id: payment._id, hash: "same-hash" },
      ],
      roo_commerce_canonical_manifest_for_ids: [
        { id: payment._id, hash: targetHash, tombstoned: false },
      ],
      roo_reconcile_and_project_commerce_shadow_sources_since: {
        reconciliation: { tombstoned: 0, preserved_concurrent: 0 },
      },
      roo_complete_incremental_commerce_sync: { completed: true },
      roo_finish_sync_run: null,
      roo_release_commerce_sync_cursor: true,
    };
    return { data: responses[name], error: null };
  }),
});

describe("incremental Sanity commerce sync", () => {
  test("imports, projects, verifies, and advances one leased cursor", async () => {
    const sanityClient = createSanityClient();
    const supabaseClient = createSupabaseClient();

    await expect(
      syncSanityCommerceChanges({ env, sanityClient, supabaseClient })
    ).resolves.toMatchObject({
      supported: true,
      busy: false,
      changed: 1,
      imported: 1,
      verified: 1,
    });

    expect(supabaseClient.rpc).toHaveBeenCalledWith(
      "roo_import_and_project_commerce_shadow_batch",
      expect.objectContaining({
        p_documents: [expect.objectContaining({
          legacy_sanity_id: payment._id,
          document_type: "paymentRecord",
        })],
      })
    );
    expect(supabaseClient.rpc).toHaveBeenCalledWith(
      "roo_complete_incremental_commerce_sync",
      expect.objectContaining({
        p_cursor_value: JSON.stringify({
          updatedAt: payment._updatedAt,
          id: payment._id,
        }),
      })
    );
  });

  test("does not pull Sanity into Supabase after the commerce cutover", async () => {
    const sanityClient = createSanityClient();
    const supabaseClient = createSupabaseClient();
    await expect(
      syncSanityCommerceChanges({
        env: {
          ...env,
          COMMERCE_PRIMARY_BACKEND: "supabase",
          COMMERCE_CUTOVER_ENABLED: "1",
          SANITY_REVERSE_MIRROR_WRITES: "1",
        },
        sanityClient,
        supabaseClient,
      })
    ).resolves.toEqual({ supported: false, reason: "supabase_primary" });
    expect(supabaseClient.rpc).not.toHaveBeenCalled();
    expect(sanityClient.fetch).not.toHaveBeenCalled();
  });

  test("keeps the cursor in place when changed-record parity fails", async () => {
    const sanityClient = createSanityClient();
    const supabaseClient = createSupabaseClient({ targetHash: "drifted" });
    await expect(
      syncSanityCommerceChanges({ env, sanityClient, supabaseClient })
    ).rejects.toMatchObject({ code: "COMMERCE_INCREMENTAL_DRIFT" });
    expect(supabaseClient.rpc).not.toHaveBeenCalledWith(
      "roo_complete_incremental_commerce_sync",
      expect.anything()
    );
    expect(supabaseClient.rpc).toHaveBeenCalledWith(
      "roo_release_commerce_sync_cursor",
      expect.objectContaining({
        p_error_code: "COMMERCE_INCREMENTAL_DRIFT",
      })
    );
  });
});

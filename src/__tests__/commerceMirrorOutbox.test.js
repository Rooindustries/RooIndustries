import { drainCommerceMirrorOutbox } from "../server/supabase/commerceMirrorOutbox";

const createSanity = ({ fail = false, documents = [] } = {}) => {
  const operations = [];
  const transaction = {
    delete: jest.fn((id) => {
      operations.push({ operation: "delete", id });
      return transaction;
    }),
    createOrReplace: jest.fn((document) => {
      operations.push({ operation: "upsert", document });
      return transaction;
    }),
    patch: jest.fn((id, mutate) => {
      const values = {};
      const patch = {
        set: jest.fn((next) => {
          Object.assign(values, next);
          return patch;
        }),
      };
      mutate(patch);
      operations.push({ operation: "patch", id, values });
      return transaction;
    }),
    commit: fail
      ? jest.fn().mockRejectedValue(new Error("mirror unavailable"))
      : jest.fn().mockResolvedValue({ ok: true }),
  };
  return {
    operations,
    fetch: jest.fn().mockResolvedValue(documents),
    transaction: jest.fn(() => transaction),
  };
};

describe("commerce mirror outbox", () => {
  test("mirrors a claimed event and records its checkpoint", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `commerce-mirror:${"a".repeat(64)}`,
              documents: [
                {
                  _id: "booking.one",
                  _type: "booking",
                  _rev: "supabase-revision",
                  _supabaseCanonicalHash: "1".repeat(64),
                  status: "captured",
                },
              ],
              deleted_ids: ["hold.one"],
              delete_guards: {
                "hold.one": {
                  source_revision: "hold-revision",
                  canonical_hash: "2".repeat(64),
                  cutover_generation: 3,
                },
              },
              canonical_hash: "b".repeat(64),
              cutover_generation: 3,
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { mirrored: true }, error: null })
        .mockResolvedValueOnce({ data: { pending: 0 }, error: null }),
    };
    const sanity = createSanity({
      documents: [
        {
          _id: "hold.one",
          _rev: "hold-revision",
        },
      ],
    });

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: sanity,
        failClosed: true,
      })
    ).resolves.toMatchObject({ supported: true, mirrored: 1, failed: 0 });
    expect(sanity.operations[0]).toEqual({ operation: "delete", id: "hold.one" });
    expect(sanity.operations[1]).toMatchObject({
      operation: "upsert",
      document: {
        _id: "booking.one",
        status: "captured",
        _supabaseRevision: "supabase-revision",
        _supabaseCanonicalHash: "1".repeat(64),
        _commerceCutoverGeneration: 3,
      },
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      "roo_claim_commerce_mirror_events",
      expect.objectContaining({ p_force: true })
    );
  });

  test("keeps the event retryable and fails a critical barrier", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `commerce-mirror:${"c".repeat(64)}`,
              documents: [{ _id: "booking.two", _type: "booking" }],
              deleted_ids: [],
              canonical_hash: "d".repeat(64),
              cutover_generation: 4,
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { mirrored: false }, error: null }),
    };

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: createSanity({ fail: true }),
        failClosed: true,
      })
    ).rejects.toMatchObject({ code: "COMMERCE_MIRROR_PENDING", status: 503 });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "roo_complete_commerce_mirror_event",
      expect.objectContaining({ p_success: false })
    );
  });

  test("never deletes a newer Sanity replacement", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `commerce-mirror:${"4".repeat(64)}`,
              documents: [],
              deleted_ids: ["hold.replaced"],
              delete_guards: {
                "hold.replaced": {
                  source_revision: "old-supabase-revision",
                  canonical_hash: "5".repeat(64),
                  cutover_generation: 7,
                },
              },
              canonical_hash: "6".repeat(64),
              cutover_generation: 7,
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { mirrored: false }, error: null }),
    };
    const sanity = createSanity({
      documents: [
        {
          _id: "hold.replaced",
          _rev: "new-sanity-revision",
        },
      ],
    });

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: sanity,
        failClosed: true,
      })
    ).rejects.toMatchObject({ code: "COMMERCE_MIRROR_PENDING" });
    expect(sanity.operations).toEqual([]);
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "roo_complete_commerce_mirror_event",
      expect.objectContaining({
        p_success: false,
        p_error_code: "COMMERCE_MIRROR_DELETE_CONFLICT",
      })
    );
  });

  test("mirrors only referral accounting and never creator credentials", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `commerce-mirror:${"e".repeat(64)}`,
              documents: [
                {
                  _id: "referral.creator",
                  _type: "referral",
                  _rev: "supabase-referral-revision",
                  successfulReferrals: 7,
                  maxCommissionPercent: 20,
                  currentCommissionPercent: 10,
                  currentDiscountPercent: 10,
                  bypassUnlock: true,
                  owedTotal: 25,
                  creatorPassword: "must-not-be-mirrored",
                  resetTokenHash: "must-not-be-mirrored",
                  creatorEmail: "must-not-be-mirrored@example.com",
                },
              ],
              deleted_ids: [],
              canonical_hash: "f".repeat(64),
              cutover_generation: 5,
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { mirrored: true }, error: null })
        .mockResolvedValueOnce({ data: { pending: 0 }, error: null }),
    };
    const sanity = createSanity();

    await drainCommerceMirrorOutbox({
      supabaseClient: supabase,
      sanityClient: sanity,
      failClosed: true,
    });

    expect(sanity.operations).toHaveLength(1);
    expect(sanity.operations[0]).toMatchObject({
      operation: "patch",
      id: "referral.creator",
      values: {
        successfulReferrals: 7,
        maxCommissionPercent: 20,
        currentCommissionPercent: 10,
        currentDiscountPercent: 10,
        bypassUnlock: true,
        owedTotal: 25,
        _commerceCutoverGeneration: 5,
      },
    });
    expect(sanity.operations[0].values).not.toHaveProperty("creatorPassword");
    expect(sanity.operations[0].values).not.toHaveProperty("resetTokenHash");
    expect(sanity.operations[0].values).not.toHaveProperty("creatorEmail");
  });

  test("supersedes a stale retry when Sanity already has a newer Supabase sequence", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              sequence_no: 8,
              event_key: `commerce-mirror:${"8".repeat(64)}`,
              document_ids: ["booking.sequence"],
              documents: [
                {
                  _id: "booking.sequence",
                  _type: "booking",
                  _supabaseSequence: 8,
                  status: "captured",
                },
              ],
              deleted_ids: [],
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { status: "superseded" }, error: null })
        .mockResolvedValueOnce({ data: { pending: 0 }, error: null }),
    };
    const sanity = createSanity({
      documents: [
        {
          _id: "booking.sequence",
          _supabaseSequence: 9,
          status: "completed",
        },
      ],
    });

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: sanity,
        failClosed: true,
      })
    ).resolves.toMatchObject({ mirrored: 0, failed: 0 });
    expect(sanity.operations).toEqual([]);
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "roo_complete_commerce_mirror_event",
      expect.objectContaining({
        p_success: true,
        p_error_code: "SUPERSEDED_BY_NEWER_SEQUENCE",
      })
    );
  });

  test("does not let an unrelated dead letter block a required payment mirror", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `commerce-mirror:${"1".repeat(64)}`,
              document_ids: ["booking.unrelated"],
              documents: [{ _id: "booking.unrelated", _type: "booking" }],
              deleted_ids: [],
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { mirrored: false }, error: null })
        .mockResolvedValueOnce({ data: { pending: 0 }, error: null }),
    };

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: createSanity({ fail: true }),
        failClosed: true,
        requiredDocumentIds: ["payment.required"],
      })
    ).resolves.toMatchObject({ supported: true, failed: 1 });
    expect(supabase.rpc).toHaveBeenLastCalledWith(
      "roo_commerce_mirror_status_for_ids",
      { p_document_ids: ["payment.required"] }
    );
  });

  test("still fails closed when the failed event contains a required record", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `commerce-mirror:${"2".repeat(64)}`,
              document_ids: ["payment.required"],
              documents: [{ _id: "payment.required", _type: "paymentRecord" }],
              deleted_ids: [],
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { mirrored: false }, error: null }),
    };

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: createSanity({ fail: true }),
        failClosed: true,
        requiredDocumentIds: ["payment.required"],
      })
    ).rejects.toMatchObject({ code: "COMMERCE_MIRROR_PENDING", status: 503 });
  });
});

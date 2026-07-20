import { drainCommerceMirrorOutbox } from "../server/supabase/commerceMirrorOutbox";

const clone = (value) => JSON.parse(JSON.stringify(value));

const createSanity = ({ fail = false, documents = [] } = {}) => {
  const operations = [];
  const state = new Map(
    documents.map((document) => [document._id, clone(document)])
  );
  const client = {
    operations,
    state,
    fetch: jest.fn(async (_query, params = {}) => {
      const ids = Array.isArray(params.ids) ? params.ids : [...state.keys()];
      return ids.map((id) => state.get(id)).filter(Boolean).map(clone);
    }),
    transaction: jest.fn(() => {
      const pending = [];
      const transaction = {
        delete: jest.fn((id) => {
          const operation = { operation: "delete", id };
          operations.push(operation);
          pending.push(operation);
          return transaction;
        }),
        createOrReplace: jest.fn((document) => {
          const operation = {
            operation: "upsert",
            document: clone(document),
          };
          operations.push(operation);
          pending.push(operation);
          return transaction;
        }),
        createIfNotExists: jest.fn((document) => {
          const operation = {
            operation: "create_if_missing",
            document: clone(document),
          };
          operations.push(operation);
          pending.push(operation);
          return transaction;
        }),
        patch: jest.fn((id, mutate) => {
          const update = {
            operation: "patch",
            id,
            values: {},
            unset: [],
            expectedRevision: "",
          };
          const patch = {
            ifRevisionId: jest.fn((revision) => {
              update.expectedRevision = revision;
              return patch;
            }),
            set: jest.fn((next) => {
              Object.assign(update.values, clone(next));
              return patch;
            }),
            unset: jest.fn((fields) => {
              update.unset.push(...fields);
              return patch;
            }),
          };
          mutate(patch);
          operations.push(update);
          pending.push(update);
          return transaction;
        }),
        commit: jest.fn(async () => {
          if (fail) throw new Error("mirror unavailable");
          for (const operation of pending) {
            if (operation.operation === "delete") {
              state.delete(operation.id);
              continue;
            }
            if (operation.operation === "upsert") {
              state.set(operation.document._id, clone(operation.document));
              continue;
            }
            if (operation.operation === "create_if_missing") {
              if (!state.has(operation.document._id)) {
                state.set(operation.document._id, clone(operation.document));
              }
              continue;
            }
            const current = state.get(operation.id);
            if (!current) {
              throw Object.assign(new Error("patch target missing"), {
                status: 409,
                statusCode: 409,
              });
            }
            if (
              operation.expectedRevision &&
              operation.expectedRevision !== current._rev
            ) {
              throw Object.assign(new Error("revision conflict"), {
                status: 409,
                statusCode: 409,
              });
            }
            const updated = { ...current, ...clone(operation.values) };
            operation.unset.forEach((field) => delete updated[field]);
            state.set(operation.id, updated);
          }
          return { ok: true };
        }),
      };
      return transaction;
    }),
  };
  return client;
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
                  backendOwner: "supabase",
                  cutoverGeneration: 5,
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
        .mockResolvedValueOnce({
          data: [{ _id: "referral.creator", _type: "referral" }],
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
      operation: "create_if_missing",
      document: {
        _id: "referral.creator",
        _type: "referral",
        backendOwner: "supabase",
        cutoverGeneration: 5,
        successfulReferrals: 7,
        maxCommissionPercent: 20,
        currentCommissionPercent: 10,
        currentDiscountPercent: 10,
        bypassUnlock: true,
        owedTotal: 25,
        _commerceCutoverGeneration: 5,
      },
    });
    expect(sanity.operations[0].document).not.toHaveProperty("creatorPassword");
    expect(sanity.operations[0].document).not.toHaveProperty("resetTokenHash");
    expect(sanity.operations[0].document).not.toHaveProperty("creatorEmail");
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "roo_fetch_shadow_documents_targeted",
      expect.objectContaining({
        p_document_types: ["referral"],
        p_ids: ["referral.creator"],
      })
    );
  });

  test("does not recreate a referral after its authoritative source was deleted", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              sequence_no: "12",
              event_key: `commerce-mirror:${"9".repeat(64)}`,
              document_ids: ["referral.deleted"],
              documents: [
                {
                  _id: "referral.deleted",
                  _type: "referral",
                  owedTotal: 40,
                },
              ],
              deleted_ids: [],
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: [], error: null })
        .mockResolvedValueOnce({ data: { status: "superseded" }, error: null })
        .mockResolvedValueOnce({ data: { pending: 0 }, error: null }),
    };
    const sanity = createSanity();

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: sanity,
        failClosed: true,
      })
    ).resolves.toMatchObject({ mirrored: 0, failed: 0 });

    expect(sanity.operations).toEqual([]);
    expect(sanity.state.has("referral.deleted")).toBe(false);
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "roo_fetch_shadow_documents_targeted",
      expect.objectContaining({
        p_document_types: ["referral"],
        p_ids: ["referral.deleted"],
      })
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      3,
      "roo_complete_commerce_mirror_event",
      expect.objectContaining({
        p_success: true,
        p_error_code: "SUPERSEDED_BY_NEWER_SEQUENCE",
      })
    );
  });

  test("applies a delayed commerce referral event without overwriting newer global state", async () => {
    const supabase = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              sequence_no: "8",
              event_key: `commerce-mirror:${"7".repeat(64)}`,
              document_ids: ["referral.delayed"],
              documents: [
                {
                  _id: "referral.delayed",
                  _type: "referral",
                  _rev: "supabase-referral-revision",
                  owedTotal: 40,
                  creatorEmail: "must-not-be-mirrored@example.com",
                },
              ],
              deleted_ids: [],
              canonical_hash: "8".repeat(64),
              cutover_generation: 6,
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
          _id: "referral.delayed",
          _rev: "sanity-referral-revision",
          _type: "referral",
          _supabaseSequence: "99",
          _supabaseSequences: { global: "13", commerce: "7" },
          creatorEmail: "preserved@example.com",
          creatorPassword: "preserved-password-hash",
          owedTotal: 25,
          paidTotal: 10,
        },
      ],
    });

    await expect(
      drainCommerceMirrorOutbox({
        supabaseClient: supabase,
        sanityClient: sanity,
        failClosed: true,
      })
    ).resolves.toMatchObject({ mirrored: 1, failed: 0 });

    expect(sanity.operations[0]).toMatchObject({
      operation: "patch",
      id: "referral.delayed",
      expectedRevision: "sanity-referral-revision",
      unset: ["paidTotal"],
    });
    expect(sanity.state.get("referral.delayed")).toMatchObject({
      creatorEmail: "preserved@example.com",
      creatorPassword: "preserved-password-hash",
      owedTotal: 40,
      _supabaseSequence: "99",
      _supabaseSequences: { global: "13", commerce: "8" },
    });
    expect(sanity.state.get("referral.delayed")).not.toHaveProperty("paidTotal");
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
          _supabaseSequences: { commerce: "9" },
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

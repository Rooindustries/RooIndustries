import {
  createReverseMirroringSupabaseClient,
  retryReverseMirrorFailures,
} from "../server/supabase/reverseMirroringClient";

const createSanityClient = ({ current = [] } = {}) => {
  const operations = [];
  const state = { current: [...current] };
  const transaction = {
    createOrReplace: jest.fn((document) => {
      operations.push({ operation: "createOrReplace", document });
      return transaction;
    }),
    delete: jest.fn((id) => {
      operations.push({ operation: "delete", id });
      return transaction;
    }),
    commit: jest.fn(async () => {
      for (const operation of operations) {
        if (operation.operation === "delete") {
          state.current = state.current.filter((item) => item._id !== operation.id);
        } else {
          state.current = [
            ...state.current.filter(
              (item) => item._id !== operation.document._id
            ),
            operation.document,
          ];
        }
      }
      return { ok: true };
    }),
  };
  return {
    operations,
    state,
    fetch: jest.fn(async () => state.current),
    transaction: jest.fn(() => transaction),
  };
};

describe("Supabase to Sanity rollback mirroring", () => {
  test("removes backend-managed fields before writing to Sanity", async () => {
    const supabaseClient = {
      create: jest.fn().mockResolvedValue({ _id: "booking.one" }),
      fetch: jest.fn().mockResolvedValue([
        {
          _id: "booking.one",
          _type: "booking",
          _rev: "supabase-rev",
          _createdAt: "2026-07-11T00:00:00Z",
          _updatedAt: "2026-07-11T00:00:01Z",
          status: "captured",
        },
      ]),
    };
    const sanityClient = createSanityClient();
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
    });

    await client.create({
      _id: "booking.one",
      _type: "booking",
      status: "captured",
    });

    expect(sanityClient.operations).toEqual([
      {
        operation: "createOrReplace",
        document: {
          _id: "booking.one",
          _type: "booking",
          status: "captured",
        },
      },
    ]);
  });

  test("allows commerce holds to defer an already-durable outbox mirror", async () => {
    const supabaseClient = {
      commerceOnly: true,
      create: jest.fn().mockResolvedValue({ _id: "slotHold.deferred" }),
      fetch: jest.fn(),
    };
    const sanityClient = createSanityClient();
    const recoveryClient = { rpc: jest.fn() };
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
      recoveryClient,
    });

    await expect(
      client.create(
        { _id: "slotHold.deferred", _type: "slotHold" },
        { deferMirror: true }
      )
    ).resolves.toEqual({ _id: "slotHold.deferred" });

    expect(recoveryClient.rpc).not.toHaveBeenCalled();
    expect(sanityClient.transaction).not.toHaveBeenCalled();
  });

  test("does not allow non-commerce writes to defer rollback mirroring", async () => {
    const supabaseClient = {
      create: jest.fn().mockResolvedValue({ _id: "content.immediate" }),
      fetch: jest.fn().mockResolvedValue([
        { _id: "content.immediate", _type: "siteSettings" },
      ]),
    };
    const sanityClient = createSanityClient();
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
    });

    await client.create(
      { _id: "content.immediate", _type: "siteSettings" },
      { deferMirror: true }
    );

    expect(sanityClient.operations).toContainEqual({
      operation: "createOrReplace",
      document: { _id: "content.immediate", _type: "siteSettings" },
    });
  });

  test("drains the atomic generic outbox after a primary write", async () => {
    const supabaseClient = {
      create: jest.fn().mockResolvedValue({ _id: "content.durable" }),
      fetch: jest.fn(),
    };
    const sanityClient = createSanityClient();
    const recoveryClient = {
      rpc: jest.fn(async (name, args) => {
        if (name === "roo_claim_document_mutation_mirror_events") {
          expect(args.p_preferred_document_ids).toEqual(["content.durable"]);
          return {
            data: [{
              sequence_no: 4,
              event_key: "44444444-4444-4444-8444-444444444444",
              document_ids: ["content.durable"],
              documents: [{
                _id: "content.durable",
                _type: "siteSettings",
                _supabaseCanonicalHash: "4".repeat(64),
                _supabaseRevision: "revision-four",
                _supabaseSequence: 4,
              }],
              deleted_documents: [],
            }],
            error: null,
          };
        }
        if (name === "roo_complete_document_mutation_mirror_event") {
          return { data: { status: "applied" }, error: null };
        }
        if (name === "roo_document_mutation_mirror_status_for_ids") {
          return { data: { pending: 0, dead_letters: 0 }, error: null };
        }
        return { data: { pending: 0, dead_letters: 0, ready: true }, error: null };
      }),
    };
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
      recoveryClient,
    });

    await expect(client.create({
      _id: "content.durable",
      _type: "siteSettings",
    })).resolves.toEqual({ _id: "content.durable" });

    expect(supabaseClient.fetch).not.toHaveBeenCalled();
    expect(sanityClient.operations).toContainEqual({
      operation: "createOrReplace",
      document: expect.objectContaining({
        _id: "content.durable",
        _supabaseCanonicalHash: "4".repeat(64),
        _supabaseSequence: "4",
      }),
    });
  });

  test("mirrors Supabase deletes as Sanity deletes", async () => {
    const supabaseClient = {
      delete: jest.fn().mockResolvedValue({ deleted: true }),
      fetch: jest.fn(),
    };
    const sanityClient = createSanityClient();
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
    });

    await client.delete("hold.one");

    expect(sanityClient.operations).toEqual([
      { operation: "delete", id: "hold.one" },
    ]);
    expect(supabaseClient.fetch).not.toHaveBeenCalled();
  });

  test("durably queues a failed rollback mirror without losing the primary result", async () => {
    const supabaseClient = {
      create: jest.fn().mockResolvedValue({ _id: "booking.queued" }),
      fetch: jest.fn().mockResolvedValue([
        { _id: "booking.queued", _type: "booking", status: "captured" },
      ]),
    };
    const sanityClient = createSanityClient();
    sanityClient.transaction().commit.mockRejectedValueOnce(
      Object.assign(new Error("Sanity unavailable"), { code: "ETIMEDOUT" })
    );
    const recoveryClient = {
      rpc: jest.fn(async (name) =>
        name === "roo_claim_document_mutation_mirror_events"
          ? { data: null, error: { code: "PGRST202" } }
          : { data: { queued: true }, error: null }
      ),
    };
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
      recoveryClient,
    });

    await expect(
      client.create({ _id: "booking.queued", _type: "booking" })
    ).resolves.toEqual({ _id: "booking.queued" });
    expect(recoveryClient.rpc).toHaveBeenCalledWith(
      "roo_record_mirror_failure",
      expect.objectContaining({
        p_operation: "supabase_to_sanity_upsert",
        p_ids: ["booking.queued"],
        p_error_code: "ETIMEDOUT",
      })
    );
  });

  test("fails closed when neither the rollback mirror nor its queue is available", async () => {
    const supabaseClient = {
      create: jest.fn().mockResolvedValue({ _id: "booking.unrecorded" }),
      fetch: jest.fn().mockResolvedValue([
        { _id: "booking.unrecorded", _type: "booking" },
      ]),
    };
    const sanityClient = createSanityClient();
    sanityClient.transaction().commit.mockRejectedValueOnce(
      new Error("Sanity unavailable")
    );
    const recoveryClient = {
      rpc: jest.fn(async (name) => ({
        data: null,
        error: {
          code: name === "roo_claim_document_mutation_mirror_events"
            ? "PGRST202"
            : "PGRST500",
        },
      })),
    };
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
      recoveryClient,
    });

    await expect(
      client.create({ _id: "booking.unrecorded", _type: "booking" })
    ).rejects.toMatchObject({ code: "REVERSE_MIRROR_UNRECORDED" });
  });

  test("retries queued rollback mirrors and converges removed documents", async () => {
    const supabaseClient = { fetch: jest.fn().mockResolvedValue([]) };
    const sanityClient = createSanityClient();
    const recoveryClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `mirror:${"a".repeat(64)}`,
              operation: "supabase_to_sanity_upsert",
              ids: ["hold.removed"],
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { resolved: true }, error: null }),
    };

    await expect(
      retryReverseMirrorFailures({
        supabaseClient,
        sanityClient,
        recoveryClient,
      })
    ).resolves.toEqual({ attempted: 1, mirrored: 1, queued: 0 });
    expect(sanityClient.operations).toContainEqual({
      operation: "delete",
      id: "hold.removed",
    });
    expect(recoveryClient.rpc).toHaveBeenLastCalledWith(
      "roo_resolve_mirror_failure",
      expect.objectContaining({ p_event_key: expect.stringMatching(/^mirror:/) })
    );
  });

  test("legacy recovery never overwrites a document owned by the durable outbox", async () => {
    const supabaseClient = {
      fetch: jest.fn().mockResolvedValue([
        { _id: "settings.protected", _type: "siteSettings", title: "Old" },
      ]),
    };
    const sanityClient = createSanityClient({
      current: [
        {
          _id: "settings.protected",
          _type: "siteSettings",
          _supabaseSequence: "12",
          _supabaseCanonicalHash: "c".repeat(64),
          title: "Durable",
        },
      ],
    });
    const recoveryClient = {
      rpc: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              event_key: `mirror:${"c".repeat(64)}`,
              operation: "supabase_to_sanity_upsert",
              ids: ["settings.protected"],
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({ data: { resolved: true }, error: null }),
    };

    await expect(
      retryReverseMirrorFailures({
        supabaseClient,
        sanityClient,
        recoveryClient,
      })
    ).resolves.toEqual({ attempted: 1, mirrored: 1, queued: 0 });
    expect(sanityClient.fetch).toHaveBeenCalledWith(
      expect.any(String),
      { ids: ["settings.protected"] },
      { perspective: "raw" }
    );
    expect(supabaseClient.fetch).not.toHaveBeenCalled();
    expect(sanityClient.transaction).not.toHaveBeenCalled();
    expect(sanityClient.state.current[0].title).toBe("Durable");
    expect(recoveryClient.rpc).toHaveBeenLastCalledWith(
      "roo_resolve_mirror_failure",
      expect.objectContaining({ p_event_key: expect.stringMatching(/^mirror:/) })
    );
  });
});

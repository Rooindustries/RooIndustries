import {
  createReverseMirroringSupabaseClient,
  retryReverseMirrorFailures,
} from "../server/supabase/reverseMirroringClient";

const createSanityClient = () => {
  const operations = [];
  const transaction = {
    createOrReplace: jest.fn((document) => {
      operations.push({ operation: "createOrReplace", document });
      return transaction;
    }),
    delete: jest.fn((id) => {
      operations.push({ operation: "delete", id });
      return transaction;
    }),
    commit: jest.fn().mockResolvedValue({ ok: true }),
  };
  return {
    operations,
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
      rpc: jest.fn().mockResolvedValue({ data: { queued: true }, error: null }),
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
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST500" },
      }),
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
});

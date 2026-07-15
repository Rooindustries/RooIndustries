import { drainDocumentMutationOutbox } from "../server/supabase/documentMutationOutbox";

const hash = "a".repeat(64);

const event = (overrides = {}) => ({
  sequence_no: "7",
  event_key: "77777777-7777-4777-8777-777777777777",
  document_ids: ["settings.site"],
  documents: [
    {
      _id: "settings.site",
      _type: "siteSettings",
      _rev: "source-revision",
      _supabaseCanonicalHash: hash,
      _supabaseSequence: 7,
      title: "Current",
    },
  ],
  deleted_documents: [],
  ...overrides,
});

const createSanityClient = ({ current = [], afterCommit = null } = {}) => {
  const state = { current: [...current], commits: 0, operations: [] };
  const client = {
    fetch: jest.fn(async () => state.current),
    transaction: jest.fn(() => {
      const operations = [];
      const transaction = {
        createOrReplace: jest.fn((document) => {
          operations.push({ operation: "upsert", document });
          return transaction;
        }),
        delete: jest.fn((id) => {
          operations.push({ operation: "delete", id });
          return transaction;
        }),
        commit: jest.fn(async () => {
          state.commits += 1;
          state.operations.push(...operations);
          for (const operation of operations) {
            if (operation.operation === "delete") {
              state.current = state.current.filter((item) => item._id !== operation.id);
            } else {
              state.current = [
                ...state.current.filter((item) => item._id !== operation.document._id),
                operation.document,
              ];
            }
          }
          if (afterCommit) afterCommit(state);
          return { ok: true };
        }),
      };
      return transaction;
    }),
  };
  return { client, state };
};

const backlog = {
  pending: 0,
  retry: 0,
  dead_letters: 0,
  overdue: 0,
  ready: true,
};

describe("document mutation mirror outbox", () => {
  test("applies and completes a leased event with idempotency markers", async () => {
    const queued = event();
    const rpc = jest.fn(async (name, args) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        expect(args.p_preferred_document_ids).toEqual(["settings.site"]);
        expect(args.p_limit).toBe(1);
        return { data: [queued], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        expect(args.p_lease_id).toEqual(expect.any(String));
        return { data: { status: "applied" }, error: null };
      }
      if (name === "roo_document_mutation_mirror_backlog") {
        return { data: backlog, error: null };
      }
      if (name === "roo_document_mutation_mirror_status_for_ids") {
        return { data: { pending: 0, dead_letters: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const sanity = createSanityClient();

    await expect(
      drainDocumentMutationOutbox({
        supabaseClient: { rpc },
        sanityClient: sanity.client,
        requiredDocumentIds: ["settings.site"],
        maxBatches: 1,
      })
    ).resolves.toMatchObject({
      supported: true,
      attempted: 1,
      applied: 1,
      mutations: 1,
      backlog,
      required: { pending: 0, dead_letters: 0 },
    });
    expect(sanity.state.current[0]).toMatchObject({
      _id: "settings.site",
      _supabaseCanonicalHash: hash,
      _supabaseRevision: "source-revision",
      _supabaseSequence: "7",
    });
    expect(sanity.client.fetch).toHaveBeenCalledTimes(2);
    for (const call of sanity.client.fetch.mock.calls) {
      expect(call[2]).toEqual({ perspective: "raw" });
    }
    expect(
      sanity.client.transaction.mock.results[0].value.commit
    ).toHaveBeenCalledWith({ visibility: "sync" });
  });

  test("does not deliver twice after Sanity accepted but completion timed out", async () => {
    const queued = event();
    let run = 0;
    let successCompletions = 0;
    const rpc = jest.fn(async (name, args) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        return { data: [queued], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        if (args.p_success) {
          successCompletions += 1;
          if (successCompletions === 1) {
            return { data: null, error: { code: "ETIMEDOUT" } };
          }
          return { data: { status: "applied" }, error: null };
        }
        run += 1;
        return { data: { status: "retry" }, error: null };
      }
      if (name === "roo_document_mutation_mirror_backlog") {
        return { data: backlog, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const sanity = createSanityClient();

    const first = await drainDocumentMutationOutbox({
      supabaseClient: { rpc },
      sanityClient: sanity.client,
      maxBatches: 1,
    });
    sanity.state.current[0]._originalId = "settings.site";
    sanity.state.current[0]._system = { base: { id: "settings.site" } };
    const second = await drainDocumentMutationOutbox({
      supabaseClient: { rpc },
      sanityClient: sanity.client,
      maxBatches: 1,
    });

    expect(first).toMatchObject({ attempted: 1, applied: 0, retried: 1 });
    expect(second).toMatchObject({ attempted: 1, applied: 1, idempotent: 1 });
    expect(run).toBe(1);
    expect(sanity.state.commits).toBe(1);
  });

  test("never overwrites a newer Sanity sequence", async () => {
    const sanity = createSanityClient({
      current: [
        {
          _id: "settings.site",
          _type: "siteSettings",
          _supabaseSequence: "9",
          _supabaseCanonicalHash: "b".repeat(64),
          title: "Newer",
        },
      ],
    });
    const rpc = jest.fn(async (name) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        return { data: [event()], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        return { data: { status: "applied" }, error: null };
      }
      return { data: backlog, error: null };
    });

    const result = await drainDocumentMutationOutbox({
      supabaseClient: { rpc },
      sanityClient: sanity.client,
      maxBatches: 1,
    });

    expect(result).toMatchObject({ applied: 1, superseded: 1, mutations: 0 });
    expect(sanity.state.commits).toBe(0);
    expect(sanity.state.current[0].title).toBe("Newer");
  });

  test("does not trust unchanged markers after manual target drift", async () => {
    const sanity = createSanityClient({
      current: [
        {
          _id: "settings.site",
          _type: "siteSettings",
          _supabaseSequence: "7",
          _supabaseCanonicalHash: hash,
          _supabaseRevision: "source-revision",
          title: "Manually changed",
        },
      ],
    });
    const rpc = jest.fn(async (name, args) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        return { data: [event()], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        expect(args.p_success).toBe(false);
        return { data: { status: "retry" }, error: null };
      }
      return { data: { ...backlog, pending: 1 }, error: null };
    });

    const result = await drainDocumentMutationOutbox({
      supabaseClient: { rpc },
      sanityClient: sanity.client,
      maxBatches: 1,
    });

    expect(result).toMatchObject({ attempted: 1, applied: 0, retried: 1 });
    expect(sanity.state.commits).toBe(0);
  });

  test("retries when the post-commit target no longer matches the source event", async () => {
    const sanity = createSanityClient({
      afterCommit: (state) => {
        state.current[0] = { ...state.current[0], title: "Concurrent drift" };
      },
    });
    const rpc = jest.fn(async (name, args) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        return { data: [event()], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        expect(args.p_success).toBe(false);
        expect(args.p_error_code).toBe("DOCUMENT_MIRROR_VERIFICATION_FAILED");
        return { data: { status: "retry" }, error: null };
      }
      return { data: { ...backlog, pending: 1 }, error: null };
    });

    const result = await drainDocumentMutationOutbox({
      supabaseClient: { rpc },
      sanityClient: sanity.client,
      limit: 100,
      maxBatches: 1,
    });

    expect(result).toMatchObject({ attempted: 1, applied: 0, retried: 1 });
    expect(rpc).toHaveBeenCalledWith(
      "roo_claim_document_mutation_mirror_events",
      expect.objectContaining({ p_limit: 1 })
    );
  });

  test("refuses to delete an untracked Sanity document that changed", async () => {
    const deleted = event({
      documents: [],
      deleted_documents: [
        {
          _id: "settings.site",
          _type: "siteSettings",
          _supabaseSequence: 7,
          title: "Old",
        },
      ],
    });
    const sanity = createSanityClient({
      current: [{ _id: "settings.site", _type: "siteSettings", title: "Changed" }],
    });
    const rpc = jest.fn(async (name, args) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        return { data: [deleted], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        expect(args.p_success).toBe(false);
        expect(args.p_error_code).toBe("DOCUMENT_MIRROR_SEQUENCE_CONFLICT");
        return { data: { status: "retry" }, error: null };
      }
      return { data: { ...backlog, pending: 1, ready: true }, error: null };
    });

    const result = await drainDocumentMutationOutbox({
      supabaseClient: { rpc },
      sanityClient: sanity.client,
      maxBatches: 1,
    });

    expect(result).toMatchObject({ attempted: 1, applied: 0, retried: 1 });
    expect(sanity.state.commits).toBe(0);
    expect(sanity.state.current).toHaveLength(1);
  });

  test("reads the raw perspective while deleting a draft document", async () => {
    const deleted = event({
      document_ids: ["drafts.settings"],
      documents: [],
      deleted_documents: [
        {
          _id: "drafts.settings",
          _type: "siteSettings",
          _supabaseSequence: 7,
          title: "Draft",
        },
      ],
    });
    const sanity = createSanityClient({
      current: [
        { _id: "drafts.settings", _type: "siteSettings", title: "Draft" },
      ],
    });
    const rpc = jest.fn(async (name) => {
      if (name === "roo_claim_document_mutation_mirror_events") {
        return { data: [deleted], error: null };
      }
      if (name === "roo_complete_document_mutation_mirror_event") {
        return { data: { status: "applied" }, error: null };
      }
      return { data: backlog, error: null };
    });

    await expect(
      drainDocumentMutationOutbox({
        supabaseClient: { rpc },
        sanityClient: sanity.client,
        maxBatches: 1,
      })
    ).resolves.toMatchObject({ applied: 1, mutations: 1 });
    expect(sanity.state.current).toEqual([]);
    expect(sanity.client.fetch).toHaveBeenCalledWith(
      expect.any(String),
      { ids: ["drafts.settings"] },
      { perspective: "raw" }
    );
  });

  test("reports rolling-deployment fallback when the claim RPC is absent", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST202" },
    });
    const sanity = createSanityClient();

    await expect(
      drainDocumentMutationOutbox({
        supabaseClient: { rpc },
        sanityClient: sanity.client,
      })
    ).resolves.toMatchObject({ supported: false, attempted: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

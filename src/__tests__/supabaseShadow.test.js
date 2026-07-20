import {
  deterministicCanaryBucket,
  resolveSupabaseRuntimePolicy,
  selectCanaryBackend,
} from "../server/supabase/runtime";
import {
  buildCommerceCommandId,
  fetchUpgradeBookingChain,
  hashShadowDocument,
  importShadowDocuments,
  normalizeShadowDocument,
} from "../server/supabase/shadowStore";
import { SupabaseDocumentClient } from "../server/supabase/documentClient";
import { createSupabaseAdminFetch } from "../server/supabase/adminClient";

const createRpcClient = (seed = []) => {
  const documents = new Map(seed.map((document) => [document._id, document]));
  let revision = 1;
  return {
    documents,
    rpc: jest.fn(async (name, args = {}) => {
      if (name === "roo_fetch_shadow_documents_targeted") {
        const requested = args.p_document_types;
        const requestedIds = args.p_ids;
        return {
          data: [...documents.values()].filter(
            (document) =>
              (!requested || requested.includes(document._type)) &&
              (!requestedIds || requestedIds.includes(document._id))
          ),
          error: null,
        };
      }
      if (name === "roo_fetch_shadow_documents") {
        const requested = args.p_document_types;
        return {
          data: [...documents.values()].filter(
            (document) => !requested || requested.includes(document._type)
          ),
          error: null,
        };
      }
      if (
        name === "roo_apply_document_mutations" ||
        name === "roo_apply_commerce_document_mutations"
      ) {
        const results = [];
        for (const mutation of args.p_mutations || []) {
          const id = mutation.id || mutation.document?._id;
          const current = documents.get(id);
          if (
            mutation.expected_revision &&
            current?._rev !== mutation.expected_revision
          ) {
            return { data: null, error: { code: "40001" } };
          }
          if (mutation.operation === "delete") {
            documents.delete(id);
            results.push({ _id: id, deleted: true });
            continue;
          }
          if (mutation.operation === "create" && current) {
            return { data: null, error: { code: "23505" } };
          }
          if (mutation.operation === "create_if_missing" && current) {
            results.push(current);
            continue;
          }
          const document = {
            ...mutation.document,
            _rev: `rev${revision++}`,
          };
          documents.set(id, document);
          results.push(document);
        }
        return {
          data:
            name === "roo_apply_commerce_document_mutations"
              ? { results, event_key: `commerce-mirror:${"a".repeat(64)}` }
              : results,
          error: null,
        };
      }
      if (name === "roo_refresh_operational_shadow") {
        return {
          data: { projection: {}, cleanup: {} },
          error: null,
        };
      }
      if (name === "roo_fetch_commerce_availability") {
        return {
          data: {
            bookings: [{ _id: "booking.typed", _type: "booking" }],
            holds: [],
            slotLocks: [],
          },
          error: null,
        };
      }
      return { data: null, error: { code: "UNKNOWN_RPC" } };
    }),
  };
};

describe("Supabase runtime policy", () => {
  test("defaults to Supabase with optional migration features disabled", () => {
    expect(resolveSupabaseRuntimePolicy({ NODE_ENV: "test" })).toMatchObject({
      primaryBackend: "supabase",
      commercePrimaryBackend: "supabase",
      shadowWritesEnabled: false,
      contentCanaryPercentage: 0,
      commerceCanaryPercentage: 0,
    });
  });

  test("requires the explicit production cutover guard", () => {
    expect(() =>
      resolveSupabaseRuntimePolicy({
        NODE_ENV: "production",
        DATA_PRIMARY_BACKEND: "supabase",
      })
    ).toThrow(/SUPABASE_CUTOVER_ENABLED/);
  });

  test("canary assignment is deterministic", () => {
    expect(deterministicCanaryBucket("same-key")).toBe(
      deterministicCanaryBucket("same-key")
    );
    expect(selectCanaryBackend({ key: "x", percentage: 100 })).toBe("supabase");
    expect(selectCanaryBackend({ key: "x", percentage: 0 })).toBe("sanity");
  });
});

describe("Supabase shadow document utilities", () => {
  test("hashing is stable across object key order", () => {
    expect(hashShadowDocument({ b: 2, a: 1 })).toBe(
      hashShadowDocument({ a: 1, b: 2 })
    );
  });

  test("commerce command IDs are stable across object key order", () => {
    const left = buildCommerceCommandId({
      cutoverGeneration: 3,
      mutations: [{ operation: "create", document: { b: 2, a: 1 } }],
    });
    const right = buildCommerceCommandId({
      mutations: [{ document: { a: 1, b: 2 }, operation: "create" }],
      cutoverGeneration: 3,
    });
    expect(left).toBe(right);
  });

  test("normalization preserves Sanity identity and timestamps", () => {
    expect(
      normalizeShadowDocument({
        _id: "booking.fixture",
        _type: "booking",
        _rev: "one",
        _createdAt: "2026-01-01T00:00:00Z",
      })
    ).toMatchObject({
      legacy_sanity_id: "booking.fixture",
      document_type: "booking",
      source_revision: "one",
    });
  });

  test("keyset-paginates upgrade chains beyond 500 rows without truncation", async () => {
    const bookings = Array.from({ length: 601 }, (_, index) => ({
      _id: `booking.${String(index).padStart(4, "0")}`,
      status: "captured",
    }));
    const client = {
      rpc: jest.fn(async (_name, params) => {
        const start = params.p_after_id
          ? bookings.findIndex((booking) => booking._id > params.p_after_id)
          : 0;
        return {
          data: start < 0 ? [] : bookings.slice(start, start + params.p_limit),
          error: null,
        };
      }),
    };
    await expect(
      fetchUpgradeBookingChain({ client, rootId: "booking.0000", pageSize: 250 })
    ).resolves.toHaveLength(601);
    expect(client.rpc).toHaveBeenCalledTimes(3);
    expect(client.rpc.mock.calls[1][1].p_after_id).toBe("booking.0249");
  });

  test("reports stale batches instead of counting them as imported", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { imported: 0, skipped_stale: 1 },
        error: null,
      }),
    };

    await expect(
      importShadowDocuments({
        documents: [
          {
            _id: "rateLimitBucket.one",
            _type: "refRateLimitBucket",
            _rev: "older",
            _updatedAt: "2026-07-11T01:00:00.000Z",
          },
        ],
        client,
      })
    ).resolves.toEqual({ imported: 0, skippedStale: 1 });
  });

  test("imports shadow rows in stable ID order", async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { imported: 2, skipped_stale: 0 },
        error: null,
      }),
    };

    await importShadowDocuments({
      documents: [
        { _id: "zeta", _type: "booking" },
        { _id: "alpha", _type: "booking" },
      ],
      client,
    });

    const batch = client.rpc.mock.calls[0][1].p_documents;
    expect(batch.map((document) => document.legacy_sanity_id)).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});

describe("Supabase document compatibility client", () => {
  test("evaluates GROQ against Supabase-backed documents", async () => {
    const shadowClient = createRpcClient([
      { _id: "package.one", _type: "package", title: "One", _rev: "a" },
      { _id: "booking.one", _type: "booking", status: "captured", _rev: "b" },
    ]);
    const client = new SupabaseDocumentClient({ shadowClient });
    await expect(
      client.fetch(`*[_type == "package"][0]{title}`)
    ).resolves.toEqual({ title: "One" });
  });

  test("supports revision-guarded set, unset, and increments", async () => {
    const shadowClient = createRpcClient([
      {
        _id: "coupon.one",
        _type: "coupon",
        _rev: "a",
        count: 1,
        removeMe: true,
      },
    ]);
    const client = new SupabaseDocumentClient({ shadowClient });
    const updated = await client
      .patch("coupon.one")
      .ifRevisionId("a")
      .set({ active: true })
      .inc({ count: 2 })
      .unset(["removeMe"])
      .commit();
    expect(updated).toMatchObject({ active: true, count: 3 });
    expect(updated).not.toHaveProperty("removeMe");
  });

  test("commits multi-document operations through one atomic RPC", async () => {
    const shadowClient = createRpcClient([
      { _id: "hold.one", _type: "slotHold", _rev: "a", phase: "active" },
    ]);
    const client = new SupabaseDocumentClient({ shadowClient });
    await client
      .transaction()
      .patch("hold.one", (patch) => patch.ifRevisionId("a").set({ phase: "payment" }))
      .create({ _id: "payment.one", _type: "paymentRecord", status: "started" })
      .commit();

    const mutationCalls = shadowClient.rpc.mock.calls.filter(
      ([name]) => name === "roo_apply_document_mutations"
    );
    expect(mutationCalls).toHaveLength(1);
    expect(shadowClient.documents.get("hold.one").phase).toBe("payment");
    expect(shadowClient.documents.get("payment.one").status).toBe("started");
  });

  test("uses the idempotent commerce command RPC for commerce writes", async () => {
    const shadowClient = createRpcClient([]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
      cutoverGeneration: 7,
    });

    await client.create({
      _id: "payment.one",
      _type: "paymentRecord",
      status: "started",
    });

    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_apply_commerce_document_mutations",
      expect.objectContaining({
        p_command_id: expect.any(String),
        p_cutover_generation: 7,
      })
    );
    expect(shadowClient.rpc).not.toHaveBeenCalledWith(
      "roo_refresh_operational_shadow",
      expect.anything()
    );
  });

  test("forwards an explicit business command ID through a transaction", async () => {
    const shadowClient = createRpcClient([]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
      cutoverGeneration: 9,
    });

    await client
      .transaction()
      .create({ _id: "payment.stable", _type: "paymentRecord" })
      .commit({ commandId: "payment-start:stable-scope" });

    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_apply_commerce_document_mutations",
      expect.objectContaining({ p_command_id: "payment-start:stable-scope" })
    );
  });

  test("reuses one generated command ID when the same transaction instance is retried", async () => {
    const shadowClient = createRpcClient([]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });
    const transaction = client
      .transaction()
      .create({ _id: "payment.retry", _type: "paymentRecord" });

    await transaction.commit();
    await expect(transaction.commit()).rejects.toMatchObject({ status: 409 });
    const commandIds = shadowClient.rpc.mock.calls
      .filter(([name]) => name === "roo_apply_commerce_document_mutations")
      .map(([, args]) => args.p_command_id);
    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  test("uses a new command ID for a separate identical create after deletion", async () => {
    const shadowClient = createRpcClient([]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });
    const document = { _id: "hold.recreated", _type: "slotHold" };

    await client.create(document);
    await client.delete(document._id);
    await client.create(document);
    const commandIds = shadowClient.rpc.mock.calls
      .filter(([name]) => name === "roo_apply_commerce_document_mutations")
      .map(([, args]) => args.p_command_id);
    expect(new Set(commandIds).size).toBe(3);
  });

  test("keeps exact document reads inside the commerce payload guard", async () => {
    const shadowClient = createRpcClient([
      {
        _id: "payment.oversized",
        _type: "paymentRecord",
        payload: "x".repeat(260 * 1024),
      },
    ]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });

    await expect(client.getDocument("payment.oversized")).rejects.toMatchObject({
      code: "COMMERCE_PAYLOAD_BUDGET_EXCEEDED",
      statusCode: 503,
    });
    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_fetch_shadow_documents_targeted",
      expect.objectContaining({ p_ids: ["payment.oversized"] })
    );
  });

  test("loads availability from the typed bounded RPC", async () => {
    const shadowClient = createRpcClient([]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });
    await expect(client.fetchAvailability()).resolves.toEqual({
      bookings: [{ _id: "booking.typed", _type: "booking" }],
      holds: [],
      slotLocks: [],
    });
    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_fetch_commerce_availability"
    );
    expect(shadowClient.rpc).not.toHaveBeenCalledWith(
      "roo_fetch_shadow_documents_targeted",
      expect.anything()
    );
  });

  test("uses the caller revision when deleting a repaired hold", async () => {
    const shadowClient = createRpcClient([
      { _id: "hold.stale", _type: "slotHold", _rev: "current" },
    ]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });

    await expect(
      client
        .transaction()
        .delete("hold.stale", { ifRevisionId: "older" })
        .commit({ commandId: "integrity-repair:stale-hold" })
    ).rejects.toMatchObject({ status: 409 });
    expect(shadowClient.documents.has("hold.stale")).toBe(true);
  });

  test("fails closed before an unscoped commerce read can download the dataset", async () => {
    const shadowClient = createRpcClient([]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });

    await expect(client.fetch(`*[]`)).rejects.toMatchObject({
      code: "COMMERCE_QUERY_SCOPE_REQUIRED",
      statusCode: 503,
    });
    expect(shadowClient.rpc).not.toHaveBeenCalled();
  });

  test("does not use the broad compatibility RPC when targeted reads are unavailable", async () => {
    const shadowClient = {
      rpc: jest.fn(async (name) =>
        name === "roo_fetch_shadow_documents_targeted"
          ? { data: null, error: { code: "PGRST202" } }
          : { data: [], error: null }
      ),
    };
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });

    await expect(
      client.fetch(`*[_type == "booking"]`)
    ).rejects.toMatchObject({
      code: "COMMERCE_TARGETED_READ_UNAVAILABLE",
      statusCode: 503,
    });
    expect(shadowClient.rpc).not.toHaveBeenCalledWith(
      "roo_fetch_shadow_documents",
      expect.anything()
    );
  });

  test("keeps the global compatibility fallback enabled by default", async () => {
    const shadowClient = {
      rpc: jest.fn(async (name) => {
        if (name === "roo_fetch_shadow_documents_targeted") {
          return { data: null, error: { code: "PGRST202" } };
        }
        if (name === "roo_fetch_shadow_documents") {
          return {
            data: [
              {
                _id: "referral.compatibility",
                _type: "referral",
                creatorEmail: "creator@example.com",
              },
            ],
            error: null,
          };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };
    const client = new SupabaseDocumentClient({ shadowClient });

    await expect(
      client.fetch(`*[_type == "referral" && _id == $id][0]`, {
        id: "referral.compatibility",
      })
    ).resolves.toMatchObject({ _id: "referral.compatibility" });
    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_fetch_shadow_documents",
      { p_document_types: ["referral"] }
    );
  });

  test("can disable broad fallback for credential-sensitive global reads", async () => {
    const shadowClient = {
      rpc: jest.fn(async (name) =>
        name === "roo_fetch_shadow_documents_targeted"
          ? { data: null, error: { code: "PGRST202" } }
          : { data: [], error: null }
      ),
    };
    const client = new SupabaseDocumentClient({
      shadowClient,
      allowLegacyFallback: false,
    });

    await expect(client.getDocument("referral.sensitive")).rejects.toMatchObject({
      code: "COMMERCE_TARGETED_READ_UNAVAILABLE",
      statusCode: 503,
    });
    expect(shadowClient.rpc).toHaveBeenCalledWith(
      "roo_fetch_shadow_documents_targeted",
      expect.objectContaining({ p_ids: ["referral.sensitive"] })
    );
    expect(shadowClient.rpc).not.toHaveBeenCalledWith(
      "roo_fetch_shadow_documents",
      expect.anything()
    );
  });

  test("enforces the 250 KB commerce database payload budget", async () => {
    const shadowClient = createRpcClient([
      {
        _id: "booking.oversized",
        _type: "booking",
        notes: "x".repeat(260 * 1024),
      },
    ]);
    const client = new SupabaseDocumentClient({
      shadowClient,
      commerceOnly: true,
    });

    await expect(
      client.fetch(`*[_type == "booking"]`)
    ).rejects.toMatchObject({
      code: "COMMERCE_PAYLOAD_BUDGET_EXCEEDED",
      statusCode: 503,
    });
  });
});

describe("Supabase admin PostgREST transport", () => {
  const response = (code, status) => ({
    status,
    clone: () => ({ json: async () => ({ code }) }),
  });

  test("retries PGRST303 exactly once and does not retry pool timeouts", async () => {
    const recovered = response("", 200);
    const jwtFetch = jest
      .fn()
      .mockResolvedValueOnce(response("PGRST303", 401))
      .mockResolvedValueOnce(recovered);
    await expect(
      createSupabaseAdminFetch({ fetchImpl: jwtFetch })("https://example.test")
    ).resolves.toBe(recovered);
    expect(jwtFetch).toHaveBeenCalledTimes(2);

    const poolTimeout = response("PGRST003", 503);
    const poolFetch = jest.fn(async () => poolTimeout);
    await expect(
      createSupabaseAdminFetch({ fetchImpl: poolFetch })("https://example.test")
    ).resolves.toBe(poolTimeout);
    expect(poolFetch).toHaveBeenCalledTimes(1);

    const persistentJwtFetch = jest.fn(async () => response("PGRST303", 401));
    await createSupabaseAdminFetch({ fetchImpl: persistentJwtFetch })(
      "https://example.test"
    );
    expect(persistentJwtFetch).toHaveBeenCalledTimes(2);
  });
});

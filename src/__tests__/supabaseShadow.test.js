import {
  deterministicCanaryBucket,
  resolveSupabaseRuntimePolicy,
  selectCanaryBackend,
} from "../server/supabase/runtime";
import {
  hashShadowDocument,
  normalizeShadowDocument,
} from "../server/supabase/shadowStore";
import { SupabaseDocumentClient } from "../server/supabase/documentClient";

const createRpcClient = (seed = []) => {
  const documents = new Map(seed.map((document) => [document._id, document]));
  let revision = 1;
  return {
    documents,
    rpc: jest.fn(async (name, args = {}) => {
      if (name === "roo_fetch_shadow_documents") {
        const requested = args.p_document_types;
        return {
          data: [...documents.values()].filter(
            (document) => !requested || requested.includes(document._type)
          ),
          error: null,
        };
      }
      if (name === "roo_apply_document_mutations") {
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
        return { data: results, error: null };
      }
      if (name === "roo_refresh_operational_shadow") {
        return {
          data: { projection: {}, cleanup: {} },
          error: null,
        };
      }
      return { data: null, error: { code: "UNKNOWN_RPC" } };
    }),
  };
};

describe("Supabase runtime policy", () => {
  test("defaults to Sanity with every migration feature disabled", () => {
    expect(resolveSupabaseRuntimePolicy({ NODE_ENV: "test" })).toMatchObject({
      primaryBackend: "sanity",
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
});

import { executeGlobalCmsCommand } from "../server/cms/publishCommand";

const baseBody = {
  projectId: "9g42k3ur",
  dataset: "production",
  operation: "publish",
  type: "about",
  documentId: "about.main",
  sourceRevision: "studio-revision",
  document: {
    _id: "drafts.about.main",
    _type: "about",
    _rev: "studio-revision",
    title: "About",
  },
  assetManifest: [],
};

const createClient = ({
  current = [],
  replayed = false,
  pending = 0,
} = {}) => ({
  rpc: jest.fn(async (name, args) => {
    if (name === "roo_cms_publish_command_result") {
      return { data: null, error: null };
    }
    if (name === "roo_fetch_shadow_documents_targeted") {
      return { data: current, error: null };
    }
    if (name === "roo_apply_cms_publish_command") {
      return { data: { replayed, results: args.p_mutations }, error: null };
    }
    if (
      name === "roo_document_mutation_mirror_status_for_ids" ||
      name === "roo_commerce_mirror_status_for_ids"
    ) {
      return { data: { pending, dead_letters: 0 }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  }),
});

const execute = ({ body = baseBody, client = createClient() } = {}) =>
  executeGlobalCmsCommand({
    body,
    authorization: "Bearer user-token",
    supabaseClient: client,
    env: {
      CMS_WRITES_PAUSED: "0",
      SANITY_STUDIO_CMS_WRITES_PAUSED: "0",
    },
    identifyCaller: jest.fn(async () => ({
      actor: "sanity:user-1",
      token: "user-token",
    })),
    verifyMutation: jest.fn(async () => {}),
    prepareAssets: jest.fn(async () => []),
    drainContentMirror: jest.fn(),
    drainCommerceMirror: jest.fn(),
  });

describe("Supabase-authoritative CMS command", () => {
  test.each(["publish", "unpublish", "delete"])(
    "blocks %s before authentication or database access while paused",
    async (operation) => {
      const client = createClient();
      const identifyCaller = jest.fn();
      await expect(
        executeGlobalCmsCommand({
          body: {
            ...baseBody,
            operation,
            ...(operation === "publish"
              ? {}
              : { document: null, assetManifest: [] }),
          },
          authorization: "Bearer user-token",
          supabaseClient: client,
          env: {
            CMS_WRITES_PAUSED: "1",
            SANITY_STUDIO_CMS_WRITES_PAUSED: "1",
          },
          identifyCaller,
        }),
      ).rejects.toMatchObject({ code: "CMS_WRITES_PAUSED", status: 503 });
      expect(identifyCaller).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  test("allows publishing again after both rollback controls are disabled", async () => {
    await expect(execute()).resolves.toMatchObject({
      committed: true,
      operation: "publish",
    });
  });

  test("creates a durable content mutation and returns pending backup state", async () => {
    const client = createClient({ pending: 1 });
    const result = await execute({ client });
    expect(result).toMatchObject({
      committed: true,
      documentId: "about.main",
      operation: "publish",
      replayed: false,
      syncPending: true,
    });
    const call = client.rpc.mock.calls.find(
      ([name]) => name === "roo_apply_cms_publish_command",
    );
    expect(call[1].p_mutations).toEqual([
      {
        operation: "create",
        id: "about.main",
        document: { _id: "about.main", _type: "about", title: "About" },
      },
    ]);
    expect(call[1].p_command_id).toMatch(/^cms:[0-9a-f]{64}$/);
  });

  test("updates with the Supabase revision and reports a receipt replay", async () => {
    const client = createClient({
      current: [
        { _id: "about.main", _type: "about", _rev: "supabase-revision" },
      ],
      replayed: true,
    });
    await expect(execute({ client })).resolves.toMatchObject({
      replayed: true,
    });
    const call = client.rpc.mock.calls.find(
      ([name]) => name === "roo_apply_cms_publish_command",
    );
    expect(call[1].p_mutations[0]).toMatchObject({
      operation: "replace",
      expected_revision: "supabase-revision",
    });
  });

  test("keeps a committed command successful when mirror status is unavailable", async () => {
    const client = createClient();
    client.rpc.mockImplementation(async (name, args) => {
      if (name === "roo_cms_publish_command_result") {
        return { data: null, error: null };
      }
      if (name === "roo_fetch_shadow_documents_targeted") {
        return { data: [], error: null };
      }
      if (name === "roo_apply_cms_publish_command") {
        return {
          data: { replayed: false, results: args.p_mutations },
          error: null,
        };
      }
      if (name === "roo_document_mutation_mirror_status_for_ids") {
        return { data: null, error: { code: "PGRST000" } };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    await expect(execute({ client })).resolves.toMatchObject({
      committed: true,
      syncPending: true,
    });
  });

  test("attempts the Sanity backup with the standard private server variables", async () => {
    const drainContentMirror = jest.fn(async () => {});
    const sanityClient = { mutate: jest.fn() };
    const sanityClientFactory = jest.fn(() => sanityClient);
    await executeGlobalCmsCommand({
      body: baseBody,
      authorization: "Bearer user-token",
      supabaseClient: createClient(),
      env: {
        CMS_WRITES_PAUSED: "0",
        SANITY_STUDIO_CMS_WRITES_PAUSED: "0",
        SANITY_PRIVATE_PROJECT_ID: "other-project",
        SANITY_PRIVATE_DATASET: "other-dataset",
        SANITY_PRIVATE_WRITE_TOKEN: "other-write-token",
        SANITY_PROJECT_ID: "9g42k3ur",
        SANITY_DATASET: "production",
        SANITY_WRITE_TOKEN: "server-write-token",
      },
      identifyCaller: jest.fn(async () => ({
        actor: "sanity:user-1",
        token: "user-token",
      })),
      verifyMutation: jest.fn(async () => {}),
      prepareAssets: jest.fn(async () => []),
      sanityClientFactory,
      drainContentMirror,
    });

    expect(sanityClientFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "9g42k3ur",
        dataset: "production",
        token: "server-write-token",
      }),
    );
    expect(drainContentMirror).toHaveBeenCalledWith(
      expect.objectContaining({
        sanityClient,
        requiredDocumentIds: ["about.main"],
      }),
    );
  });

  test("replays a committed receipt without requiring the old Sanity revision", async () => {
    const verifyMutation = jest.fn();
    const client = createClient();
    client.rpc.mockImplementation(async (name) => {
      if (name === "roo_cms_publish_command_result") {
        return { data: { replayed: true }, error: null };
      }
      if (name === "roo_document_mutation_mirror_status_for_ids") {
        return { data: { pending: 0, dead_letters: 0 }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    await expect(
      executeGlobalCmsCommand({
        body: baseBody,
        authorization: "Bearer user-token",
        supabaseClient: client,
        env: {
          CMS_WRITES_PAUSED: "0",
          SANITY_STUDIO_CMS_WRITES_PAUSED: "0",
        },
        identifyCaller: jest.fn(async () => ({
          actor: "sanity:user-1",
          token: "user-token",
        })),
        verifyMutation,
        prepareAssets: jest.fn(),
      }),
    ).resolves.toMatchObject({ committed: true, replayed: true });
    expect(verifyMutation).not.toHaveBeenCalled();
  });

  test.each(["delete", "unpublish"])(
    "%s uses a revision-guarded authoritative delete",
    async (operation) => {
      const client = createClient({
        current: [{ _id: "about.main", _type: "about", _rev: "current" }],
      });
      await execute({
        client,
        body: { ...baseBody, operation, document: null, assetManifest: [] },
      });
      const call = client.rpc.mock.calls.find(
        ([name]) => name === "roo_apply_cms_publish_command",
      );
      expect(call[1].p_mutations).toEqual([
        { operation: "delete", id: "about.main", expected_revision: "current" },
      ]);
    },
  );

  test.each(["bookingSettings", "coupon", "package", "upgradeLink"])(
    "routes %s readiness through the commerce outbox",
    async (type) => {
      const client = createClient();
      await execute({
        client,
        body: {
          ...baseBody,
          type,
          documentId: `${type}.one`,
          document: { _id: `drafts.${type}.one`, _type: type, title: "Value" },
        },
      });
      expect(client.rpc).toHaveBeenCalledWith(
        "roo_commerce_mirror_status_for_ids",
        { p_document_ids: [`${type}.one`] },
      );
      expect(client.rpc).not.toHaveBeenCalledWith(
        "roo_document_mutation_mirror_status_for_ids",
        expect.anything(),
      );
    },
  );

  test("rejects wrong project, dataset, type, and unexpected delete assets", async () => {
    await expect(
      execute({ body: { ...baseBody, dataset: "production-in" } }),
    ).rejects.toMatchObject({ status: 400, code: "CMS_TARGET_INVALID" });
    await expect(
      execute({ body: { ...baseBody, type: "booking" } }),
    ).rejects.toMatchObject({ status: 400, code: "CMS_COMMAND_UNSUPPORTED" });
    await expect(
      execute({
        body: {
          ...baseBody,
          operation: "delete",
          document: null,
          assetManifest: [{ _id: "file-one-bin" }],
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "CMS_ASSET_UNEXPECTED" });
  });

  test("reports malformed document IDs and document shapes as client errors", async () => {
    await expect(
      execute({ body: { ...baseBody, documentId: "versions.about.main" } }),
    ).rejects.toMatchObject({ status: 400, code: "CMS_DOCUMENT_ID_INVALID" });
    await expect(
      execute({
        body: {
          ...baseBody,
          document: { ...baseBody.document, _id: "drafts.about.other" },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "CMS_DOCUMENT_INVALID" });
  });
});

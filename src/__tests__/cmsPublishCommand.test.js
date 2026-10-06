import { executeGlobalCmsCommand, createIntentDocumentId } from "../server/cms/publishCommand";

const intent = "4ef1c604-dabe-434c-9b4a-6b5e74c6fbc5";
const id = createIntentDocumentId(intent);
const baseBody = { operation: "create", type: "benchmark", createIntentId: intent, document: { title: "Synthetic native content" } };
const createClient = ({ current = [], replayed = false } = {}) => ({
  rpc: jest.fn(async (name, args) => {
    if (name === "roo_cms_publish_command_result") return { data: null, error: null };
    if (name === "roo_fetch_shadow_documents_targeted") return { data: current, error: null };
    if (name === "roo_apply_cms_publish_command") return { data: { replayed, results: [{ _id: args.p_mutations[0].id, _rev: "committed-revision" }] }, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  }),
});
const execute = ({ body = baseBody, client = createClient(), env = { CMS_WRITES_PAUSED: "0" } } = {}) => executeGlobalCmsCommand({ body, supabaseClient: client, env });

describe("D6/P4 native authoritative CMS command", () => {
  test.each(["create", "replace", "delete"])("blocks %s before database access while paused", async operation => {
    const client = createClient();
    await expect(execute({ body: { ...baseBody, operation }, client, env: { CMS_WRITES_PAUSED: "1" } })).rejects.toMatchObject({ code: "CMS_WRITES_PAUSED", status: 423 });
    expect(client.rpc).not.toHaveBeenCalled();
  });
  test("publishes with the single native pause flag", async () => {
    await expect(execute({ env: { CMS_WRITES_PAUSED: "0", SANITY_STUDIO_CMS_WRITES_PAUSED: "1" } })).resolves.toEqual({ committed: true, replayed: false, documentId: id, revision: "committed-revision" });
  });
  test("creates a durable native content mutation and committed revision", async () => {
    const client = createClient();
    await expect(execute({ client })).resolves.toMatchObject({ committed: true, documentId: id, revision: "committed-revision" });
    const [, args] = client.rpc.mock.calls.find(([name]) => name === "roo_apply_cms_publish_command");
    expect(args.p_mutations).toEqual([{ operation: "create", id, document: expect.objectContaining({ _id: id, _type: "benchmark", title: baseBody.document.title }) }]);
    expect(args.p_actor).toBe("admin:key");
    expect(args.p_command_id).toMatch(/^cms:[0-9a-f]{64}$/);
    expect(args.p_assets).toEqual([]);
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["roo_cms_publish_command_result", "roo_fetch_shadow_documents_targeted", "roo_apply_cms_publish_command"]);
  });
  test("uses the editor's loaded revision and reports receipt replay", async () => {
    const client = createClient({ current: [{ _id: id, _type: "benchmark", _rev: "current-revision" }], replayed: true });
    const body = { operation: "replace", type: "benchmark", documentId: id, expectedRevision: "loaded-revision", document: { title: "Updated" } };
    await expect(execute({ client, body })).resolves.toMatchObject({ replayed: true });
    const [, args] = client.rpc.mock.calls.find(([name]) => name === "roo_apply_cms_publish_command");
    expect(args.p_mutations[0]).toMatchObject({ operation: "replace", expected_revision: "loaded-revision" });
  });
  test("replays a committed receipt without another document write", async () => {
    const client = createClient();
    client.rpc.mockImplementation(async name => {
      if (name === "roo_cms_publish_command_result") return { data: { replayed: true, results: [{ _id: id, _rev: "original-revision" }] }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    await expect(execute({ client })).resolves.toMatchObject({ committed: true, replayed: true, revision: "original-revision" });
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
  test("delete uses the loaded authoritative revision", async () => {
    const client = createClient({ current: [{ _id: id, _type: "benchmark", _rev: "current" }] });
    await execute({ client, body: { operation: "delete", type: "benchmark", documentId: id, expectedRevision: "loaded" } });
    const [, args] = client.rpc.mock.calls.find(([name]) => name === "roo_apply_cms_publish_command");
    expect(args.p_mutations).toEqual([{ operation: "delete", id, expected_revision: "loaded" }]);
  });
  test("rejects unsupported commands and fields", async () => {
    for (const body of [{ ...baseBody, projectId: "retired" }, { ...baseBody, operation: "publish" }, { ...baseBody, type: "booking" }, { operation: "delete", type: "benchmark", documentId: id, document: {} }]) await expect(execute({ body })).rejects.toMatchObject({ status: 400, code: "CMS_VALIDATION_FAILED" });
  });
  test("rejects mismatched document identities and malformed ids", async () => {
    await expect(execute({ body: { operation: "delete", type: "benchmark", documentId: "versions.invalid" } })).rejects.toMatchObject({ status: 400, code: "CMS_VALIDATION_FAILED" });
    await expect(execute({ body: { ...baseBody, document: { ...baseBody.document, _id: "other" } } })).rejects.toMatchObject({ status: 400, code: "CMS_VALIDATION_FAILED" });
  });
});

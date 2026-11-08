const { randomUUID } = require("node:crypto");
const { expect } = require("@playwright/test");
const { fixtureOrigin } = require("./fixture-ports.cjs");

const ADMIN_KEY = "synthetic-admin-key";
const CONTENT_READ = "^roo_fetch_";

const controlOrigin = (baseURL) => fixtureOrigin(baseURL, "TOOLING_ADMIN_CONTROL_PORT");

const createContentGate = (request, baseURL) => {
  const control = controlOrigin(baseURL);
  const post = async (path, body) => {
    const response = await request.post(`${control}${path}`, { data: body });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await request.get(`${control}${path}`)).json();

  const traced = (requestId = randomUUID()) => {
    const headers = { "x-roo-test-request-id": requestId };
    return {
      requestId,
      headers,
      rules: (rules) => post("/store-rules", { requestId, rules }),
      calls: () => get(`/store-calls?requestId=${requestId}`),
      contentReads: async () => (await get(`/store-calls?requestId=${requestId}`)).filter((rpc) => new RegExp(CONTENT_READ).test(rpc)),
      keptAlive: () => get(`/kept-alive?requestId=${requestId}`),
      purges: async () => (await get("/purges")).filter((purge) => purge.requestId === requestId),
      waitForHold: () =>
        expect.poll(async () => (await get(`/store-holds?requestId=${requestId}`)).length, { timeout: 15000, intervals: [100, 250, 500] }).toBeGreaterThan(0),
      release: () => post("/store-release", { requestId }),
      content: (path) => request.get(path, { headers }),
      cms: async (path, body) => {
        const response = await request.fetch(path, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...headers, "x-admin-key": ADMIN_KEY },
          ...(body === undefined ? {} : { data: body }),
        });
        return { status: response.status(), body: await response.json() };
      },
    };
  };

  const admin = traced();
  const cms = async (path, body) => {
    const { status, body: payload } = await admin.cms(path, body);
    expect(status, JSON.stringify(payload)).toBe(200);
    return payload.data;
  };
  const document = (id) => cms(`/api/admin/content/documents/${id}`);
  const replaceCommand = (original, changes) => ({
    operation: "replace",
    type: original.document._type,
    documentId: original.document._id,
    expectedRevision: original.revision,
    document: { ...original.document, ...changes },
  });

  return {
    control,
    traced,
    admin,
    cms,
    document,
    replaceCommand,
    publish: (original, changes) => cms("/api/admin/content/publish", replaceCommand(original, changes)),
    publishElsewhere: (original, changes) => post("/publish-elsewhere", replaceCommand(original, changes)),
    restore: async (id, document) => {
      const current = await cms(`/api/admin/content/documents/${id}`);
      await cms("/api/admin/content/publish", replaceCommand(current, document));
    },
  };
};

module.exports = { CONTENT_READ, createContentGate };

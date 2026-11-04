const { randomUUID } = require("node:crypto");
const { expect } = require("@playwright/test");

const ADMIN_KEY = "synthetic-admin-key";
const CONTENT_READ = "^roo_fetch_";

const controlOrigin = (baseURL) => {
  const origin = new URL(baseURL);
  origin.port = String(Number(origin.port) + 6);
  return origin.origin;
};

const createContentGate = (request, baseURL) => {
  const control = controlOrigin(baseURL);
  const post = async (path, body) => {
    const response = await request.post(`${control}${path}`, { data: body });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await request.get(`${control}${path}`)).json();

  const traced = (trace = randomUUID()) => {
    const headers = { "x-roo-test-trace": trace };
    return {
      trace,
      headers,
      rules: (rules) => post("/store-rules", { trace, rules }),
      calls: () => get(`/store-calls?trace=${trace}`),
      contentReads: async () => (await get(`/store-calls?trace=${trace}`)).filter((rpc) => new RegExp(CONTENT_READ).test(rpc)),
      waitForHold: () =>
        expect.poll(async () => (await get(`/store-holds?trace=${trace}`)).length, { timeout: 15000, intervals: [100, 250, 500] }).toBeGreaterThan(0),
      release: () => post("/store-release", { trace }),
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

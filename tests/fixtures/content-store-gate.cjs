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

  const traced = (trace = randomUUID()) => {
    const headers = { "x-roo-test-trace": trace };
    return {
      trace,
      headers,
      rules: (rules) => post("/store-rules", { trace, rules }),
      calls: () => get(`/store-calls?trace=${trace}`),
      contentReads: async () => (await get(`/store-calls?trace=${trace}`)).filter((rpc) => new RegExp(CONTENT_READ).test(rpc)),
      keptAlive: () => get(`/kept-alive?trace=${trace}`),
      purges: async () => (await get("/purges")).filter((purge) => purge.trace === trace),
      waitForHold: () =>
        expect.poll(async () => (await get(`/store-holds?trace=${trace}`)).length, { timeout: 15000, intervals: [100, 250, 500] }).toBeGreaterThan(0),
      release: () => post("/store-release", { trace }),
      close: () => post("/store-close", { trace }),
      reset: async () => {
        const response = await request.get("/api/admin/content/documents/tooling-hero", { headers: { "x-admin-key": ADMIN_KEY, "x-roo-test-reset-controls": trace } });
        expect(response.ok()).toBe(true);
      },
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
    clearRounds: async () => {
      const response = await request.get("/api/admin/content/documents/tooling-hero", { headers: { "x-admin-key": ADMIN_KEY, "x-roo-test-clear-rounds": "1" } });
      expect(response.ok()).toBe(true);
    },
    rebuild: async (paths) => {
      const writes = await get("/test-page-writes");
      const results = await Promise.allSettled(paths.map(async (path) => {
        try {
          const count = writes.filter((entry) => entry.key === path).length;
          const response = await request.get(path, { headers: { accept: "text/html" } });
          expect(response.ok()).toBe(true);
          if (response.headers()["x-nextjs-cache"] === "STALE") {
            const query = new URLSearchParams({ kind: "write", key: path, count: String(count + 1) });
            expect((await request.get(`${control}/await-test-event?${query}`)).ok()).toBe(true);
          }
        } catch (error) { throw new Error(`rebuild ${path}: ${error.message}`, { cause: error }); }
      }));
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    },
    cleanup: async (...actions) => {
      let failure;
      for (const action of actions) {
        try { await action(); } catch (error) { failure ||= error; }
      }
      if (failure) throw failure;
    },
    restore: async (id, document) => {
      const current = await cms(`/api/admin/content/documents/${id}`);
      await cms("/api/admin/content/publish", replaceCommand(current, document));
    },
  };
};

module.exports = { CONTENT_READ, createContentGate };

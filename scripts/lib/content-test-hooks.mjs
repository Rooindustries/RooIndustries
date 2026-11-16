import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";

const control = process.env.ROO_CONTENT_TEST_CONTROL_URL;

if (control) {
  const traces = new AsyncLocalStorage();
  const refreshControls = new AsyncLocalStorage();
  const activeControls = new Map();
  const failures = new Map();
  const scheduledRounds = new Set();
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (refreshControls.getStore()?.publish && [5000, 60000].includes(ms)) scheduledRounds.add(timer);
    return timer;
  };
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, request, ...rest) {
    if (event !== "request") return emit.call(this, event, request, ...rest);
    if (request?.headers?.["x-roo-test-inspect-controls"] === "1") {
      const controls = globalThis[Symbol.for("roo.test.controls")];
      const response = rest[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ failures: failures.size, active: activeControls.size, timers: scheduledRounds.size, storeDelayMs: controls?.storeDelayMs || 0 }));
      return true;
    }
    const trace = request?.headers?.["x-roo-test-trace"];
    if (typeof trace === "string" && (request?.headers?.["x-roo-test-fail-content-purge"] === "1" || request?.headers?.["x-roo-test-fail-page-mark"] === "1")) {
      failures.set(trace, { content: request.headers["x-roo-test-fail-content-purge"] === "1", pages: request.headers["x-roo-test-fail-page-mark"] === "1" });
    }
    const testControls = (globalThis[Symbol.for("roo.test.controls")] ||= { storeDelayMs: 0 });
    if (request?.headers?.["x-roo-test-clear-rounds"] === "1") {
      for (const timer of scheduledRounds) clearTimeout(timer);
      scheduledRounds.clear();
    }
    const reset = request?.headers?.["x-roo-test-reset-controls"];
    if (typeof reset === "string") {
      testControls.storeDelayMs = 0;
      failures.delete(reset);
      const active = activeControls.get(reset);
      if (active) {
        active.hangContentPurge = false;
        active.hangPageMark = false;
        for (const release of active.holds) release();
        active.holds.clear();
        activeControls.delete(reset);
      }
    }
    const requestControls = {
      hangContentPurge: request?.headers?.["x-roo-test-hang-content-purge"] === "1",
      hangPageMark: request?.headers?.["x-roo-test-hang-page-mark"] === "1",
      holds: new Set(),
      publish: request?.method === "POST" && request?.url?.split("?")[0] === "/api/admin/content/publish",
    };
    if (typeof trace === "string" && (requestControls.hangContentPurge || requestControls.hangPageMark)) activeControls.set(trace, requestControls);
    if (/^\d+$/.test(request?.headers?.["x-roo-test-delay-page-store"] || "")) testControls.storeDelayMs = Number(request.headers["x-roo-test-delay-page-store"]);
    return traces.run(typeof trace === "string" ? trace : null, () => refreshControls.run(requestControls, () => emit.call(this, event, request, ...rest)));
  };

  const baseFetch = globalThis.fetch;
  const report = async (path, body, timeoutMs = 5000) => {
    const response = await baseFetch(`${control}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Content test control refused ${path}.`);
    return response.json();
  };

  const rpcPrefix = `${new URL(process.env.SUPABASE_URL).origin}/rest/v1/rpc/`;
  globalThis.fetch = async (input, init) => {
    const trace = traces.getStore();
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (!trace || !url.startsWith(rpcPrefix)) return baseFetch(input, init);
    const rpc = new URL(url).pathname.slice(new URL(rpcPrefix).pathname.length);
    let types = "";
    try { types = (JSON.parse(typeof init?.body === "string" ? init.body : "{}").p_document_types || []).join(","); } catch {}
    const { action } = await report("/store-calls", { trace, rpc, types });
    if (action === "fail") {
      return new Response(JSON.stringify({ code: "PGRST000", message: "Store unavailable." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const response = await baseFetch(input, init);
    if (action === "hold") await report("/store-holds", { trace, rpc }, 25000);
    if (action === "lose") {
      await response.arrayBuffer();
      throw new TypeError("fetch failed");
    }
    if (action === "gateway") {
      await response.arrayBuffer();
      return new Response("<html><body>504 Gateway Time-out</body></html>", { status: 504, headers: { "Content-Type": "text/html" } });
    }
    if (action.startsWith("error:")) {
      await response.arrayBuffer();
      return new Response(JSON.stringify({ code: action.slice(6), message: "Store error after the call." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    if (action === "garble") {
      await response.arrayBuffer();
      return new Response("{\"results\": [", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return response;
  };

  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args);
    try {
      const event = JSON.parse(args[0]);
      if (event.event === "public_pages_refresh") void report("/refresh-events", { trace: traces.getStore() ?? null, event }).catch(() => {});
    } catch {}
  };

  const originalError = console.error;
  console.error = (...args) => {
    originalError(...args);
    if (typeof args[0] === "string" && /^Public (content CDN purge|pages mark) (failed|did not answer in time)$/.test(args[0])) {
      void report("/refresh-errors", { trace: traces.getStore() ?? null, label: args[0] }).catch(() => {});
    }
    if (typeof args[0] === "string" && args[0].includes("keeping the previous page")) {
      void report("/page-refusals", { label: args[0] }).catch(() => {});
    }
  };

  const marks = (globalThis[Symbol.for("roo.test.pageMarks")] ||= { at: 0 });
  const record = (operation) => async (target, options) => {
    const testControls = refreshControls.getStore();
    const failure = failures.get(traces.getStore());
    if ((failure?.content && [target].flat().includes("public-content")) || (failure?.pages && [target].flat().includes("_N_T_/layout"))) throw Object.assign(new Error("Refresh unavailable."), { code: "FIXTURE_REFRESH_FAILURE" });
    if (testControls?.hangPageMark && [target].flat().includes("_N_T_/layout")) await new Promise(resolve => testControls.holds.add(resolve));
    if (operation === "invalidateByTag" && [target].flat().includes("_N_T_/layout")) marks.at = Date.now();
    await report("/purges", { operation, target, options: options ?? null, trace: traces.getStore() ?? null });
    if (testControls?.hangContentPurge && [target].flat().includes("public-content")) await new Promise(resolve => testControls.holds.add(resolve));
  };
  const purge = {
    invalidateByTag: record("invalidateByTag"),
    dangerouslyDeleteByTag: record("dangerouslyDeleteByTag"),
    invalidateBySrcImage: record("invalidateBySrcImage"),
    dangerouslyDeleteBySrcImage: record("dangerouslyDeleteBySrcImage"),
  };
  const waitUntil = (promise) => {
    const trace = traces.getStore();
    if (!trace) return;
    void report("/kept-alive", { trace, state: "registered" }).catch(() => {});
    Promise.resolve(promise).then(
      () => report("/kept-alive", { trace, state: "settled" }).catch(() => {}),
      () => report("/kept-alive", { trace, state: "settled" }).catch(() => {}),
    );
  };
  globalThis[Symbol.for("@vercel/request-context")] = { get: () => ({ purge, waitUntil }) };
}

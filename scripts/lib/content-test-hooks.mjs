import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";

const control = process.env.ROO_CONTENT_TEST_CONTROL_URL;

if (control) {
  const traces = new AsyncLocalStorage();
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, request, ...rest) {
    if (event !== "request") return emit.call(this, event, request, ...rest);
    const trace = request?.headers?.["x-roo-test-trace"];
    return traces.run(typeof trace === "string" ? trace : null, () => emit.call(this, event, request, ...rest));
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
    const { action } = await report("/store-calls", { trace, rpc });
    if (action === "fail") {
      return new Response(JSON.stringify({ code: "PGRST000", message: "Store unavailable." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const response = await baseFetch(input, init);
    if (action === "hold") await report("/store-holds", { trace, rpc }, 25000);
    return response;
  };
}

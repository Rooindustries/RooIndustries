import http from "node:http";
import { localOrigin, refuseEnvFiles } from "../../scripts/lib/test-target-safety.mjs";

export function auditProviderProxyOrigin(baseURL) {
  const target = new URL(localOrigin(baseURL));
  const port = Number(target.port) + 4;
  if (port > 65535) throw new Error("Invalid audit proxy port.");
  target.port = String(port);
  return localOrigin(target.origin);
}

export async function startAuditProviderProxy(baseURL, { status, body }) {
  refuseEnvFiles();
  const upstream = localOrigin(baseURL);
  const origin = auditProviderProxyOrigin(upstream);
  const server = http.createServer((request, response) => {
    const target = new URL(request.url, upstream);
    if (target.origin !== upstream) {
      response.writeHead(400).end();
      return;
    }
    if (target.pathname === "/api/payment/providers") {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const forwarded = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: new URL(upstream).host },
    }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    forwarded.on("error", () => response.writeHead(502).end());
    request.pipe(forwarded);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const target = new URL(origin);
    server.listen(Number(target.port), target.hostname, resolve);
  });
  return {
    origin,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

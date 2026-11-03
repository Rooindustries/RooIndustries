import http from "node:http";
import { localOrigin, refuseEnvFiles } from "../../scripts/lib/test-target-safety.mjs";
import { listenOnPort } from "../../scripts/lib/free-tcp-port.mjs";

export async function startAuditProviderProxy(baseURL) {
  refuseEnvFiles();
  const upstream = localOrigin(baseURL);
  let reply = null;
  const server = http.createServer((request, response) => {
    const target = new URL(request.url, upstream);
    if (target.origin !== upstream) {
      response.writeHead(400).end();
      return;
    }
    if (target.pathname === "/booking" && typeof reply?.bookingHtml === "string") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(reply.bookingHtml);
      return;
    }
    if (target.pathname === "/api/payment/providers" && reply) {
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply.body));
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
  await listenOnPort(server, new URL(upstream).hostname, 0);
  const origin = new URL(upstream);
  origin.port = String(server.address().port);
  return {
    origin: localOrigin(origin.origin),
    respond: next => { reply = next; },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

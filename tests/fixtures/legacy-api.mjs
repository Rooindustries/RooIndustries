import http from 'node:http';
import { Readable } from 'node:stream';
import { localOrigin } from '../../scripts/lib/test-target-safety.mjs';
import { runLegacyApiHandler } from '../../src/lib/nextApiAdapter.js';

export async function createLegacyApiFixture({ origin, pathname, handler }) {
  const target = new URL(localOrigin(origin));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname !== pathname) {
        res.writeHead(404);
        res.end();
        return;
      }
      const method = req.method || 'GET';
      const request = new Request(url, {
        method,
        headers: req.headers,
        ...(!['GET', 'HEAD'].includes(method)
          ? { body: Readable.toWeb(req), duplex: 'half' }
          : {}),
      });
      const response = await runLegacyApiHandler({ request, handler });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Fixture route failed.' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(target.port), target.hostname, resolve);
  });
  return {
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

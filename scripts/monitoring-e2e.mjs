import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';

refuseEnvFiles();
const require = createRequire(import.meta.url);
const sdkEntry = pathToFileURL(join(dirname(require.resolve('@sentry/nextjs/package.json')), 'build/esm/index.server.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@sentry/nextjs') return next(sdkEntry, context);
    try { return next(specifier, context); } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
      throw error;
    }
  },
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifact = join(root, 'test-results', 'monitoring-e2e', new Date().toISOString().replace(/[:.]/g, '-'), 'report.json');
const checks = [];
const timing = [];
const received = [];
let sdk;
let reportError;
let relay;
let origin;
const check = (name, actual, expected) => {
  const ok = isDeepStrictEqual(actual, expected);
  checks.push({ name, ok, actual, expected });
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(actual)}`}`);
};
const events = () => received.flatMap(({ body }) => {
  const lines = body.split('\n').filter(Boolean);
  const result = [];
  for (let index = 1; index + 1 < lines.length; index += 2) {
    if (JSON.parse(lines[index]).type === 'event') result.push({ raw: body, event: JSON.parse(lines[index + 1]) });
  }
  return result;
});

const ingest = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const bytes = Buffer.concat(chunks);
    const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString();
    received.push({ body, headers: request.headers, path: request.url });
    response.writeHead(body.includes('fixture-upstream-failure') ? 503 : 200);
    response.end('{}');
  });
});
const api = http.createServer(async (request, response) => {
  try {
    if (request.url === '/caught') {
      const error = new Error('hidden buyer@example.com 4242424242424242');
      error.code = 'ECONNREFUSED';
      reportError('Fixture caught failure', error);
      response.writeHead(500);
      response.end('Unexpected server error.');
      return;
    }
    if (request.url === '/sdk') {
      sdk.withScope(scope => {
        scope.setTransactionName('GET /payment/4242424242424242');
        scope.setExtra('billing', { cvv: 'fixture-private-cvv' });
        scope.setExtra('buyer@example.com', 'useful diagnostic');
        scope.setExtra('reference', '4242 4242 4242 4243');
        scope.setExtra('4242-4242-4242-4243', 'card-shaped key');
        scope.setExtra('span_id', '4242424242424242');
        scope.setExtra('diagnostic_values', Array(8).fill('a'.repeat(16000)));
        scope.addEventProcessor(event => ({
          ...event,
          contexts: { ...event.contexts, trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '1234567890123456', parent_span_id: '2345678901234567' } },
        }));
        sdk.captureException(new Error('Fixture SDK buyer@example.com 4242424242424242 play?token=fixture-private-query ?token=fixture-query-only'));
      });
      response.end('{}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await relay(new Request(`${origin}/api/client-report`, { method: 'POST', headers: request.headers, body: Buffer.concat(chunks) }));
    response.writeHead(result.status);
    response.end();
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => ingest.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => api.listen(0, process.env.ROO_TEST_HOST || '127.0.0.1', resolve));
const ingestOrigin = `http://127.0.0.1:${ingest.address().port}`;
origin = `http://${process.env.ROO_TEST_HOST || '127.0.0.1'}:${api.address().port}`;
const dsn = `http://fixturekey@127.0.0.1:${ingest.address().port}/42`;
const restoreGuard = installNetworkGuard([origin, ingestOrigin]);
process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
process.env.NEXT_RUNTIME = 'nodejs';
process.env.SENTRY_RELEASE = 'monitoring-e2e';

try {
  sdk = await import('@sentry/nextjs');
  ({ POST: relay } = await import('../app/api/client-report/route.js'));
  const { startServerMonitoring } = await import('../src/lib/monitoring/server.js');
  ({ logSafeError: reportError } = await import('../src/server/safeErrorLog.js'));
  startServerMonitoring(dsn);
  const envelope = (target, message) => `${JSON.stringify({ dsn: target })}\n{"type":"event"}\n${JSON.stringify({ message })}\n`;
  const post = (body, headers = {}) => fetch(`${origin}/api/client-report`, {
    method: 'POST',
    body,
    headers: { origin, 'content-type': 'text/plain', ...headers },
  });
  check('same-origin envelope is accepted', (await post(envelope(dsn, 'fixture-relay'), { cookie: 'fixture-private-cookie', authorization: 'Bearer fixture-private-auth', 'x-forwarded-for': '203.0.113.42' })).status, 200);
  const relayed = received.find(item => item.body.includes('fixture-relay'));
  check('relay targets this DSN project', relayed?.path, '/api/42/envelope/');
  check('relay forwards no visitor headers', ['cookie', 'authorization', 'origin', 'x-forwarded-for', 'sentry-trace', 'baggage'].filter(name => name in (relayed?.headers || {})), []);
  check('foreign DSN is refused', (await post(envelope('https://foreign@ingest.invalid/7', 'fixture-foreign'))).status, 400);
  check('cross-origin report is refused', (await post(envelope(dsn, 'fixture-cross'), { origin: 'https://foreign.invalid' })).status, 403);
  check('oversized report is refused', (await post(envelope(dsn, 'x'.repeat(300 * 1024)))).status, 413);
  check('invalid envelope is refused', (await post('not json')).status, 400);
  check('upstream refusal stays a failure', (await post(envelope(dsn, 'fixture-upstream-failure'))).status, 502);
  process.env.NEXT_PUBLIC_SENTRY_DSN = '';
  check('disabled reporting returns 404', (await post(envelope(dsn, 'fixture-disabled'))).status, 404);
  process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
  check('refused envelopes never reach ingest', received.filter(item => /fixture-(foreign|cross|disabled)/.test(item.body)).length, 0);
  const caughtResponse = await fetch(`${origin}/caught`);
  check('caught application failure keeps its status', caughtResponse.status, 500);
  check('caught application failure keeps its generic response', await caughtResponse.text(), 'Unexpected server error.');
  const cpuBefore = process.cpuUsage();
  await fetch(`${origin}/sdk`);
  await sdk.flush(5000);
  const sdkCpu = process.cpuUsage(cpuBefore);
  const sdkCpuMs = (sdkCpu.user + sdkCpu.system) / 1000;
  timing.push({ name: 'SDK event with eight 16KiB tokens', length: 16000, count: 8, cpuMs: sdkCpuMs });
  const caught = events().find(item => item.event.exception?.values?.[0]?.value === 'Fixture caught failure');
  check('caught errors reach the real Next SDK', Boolean(caught), true);
  check('caught reports contain no original error message', /hidden|buyer@example.com|4242424242424242/.test(caught?.raw || ''), false);
  const reported = events().find(item => item.event.exception?.values?.[0]?.value?.startsWith('Fixture SDK'));
  check('SDK error text and relative queries are scrubbed', reported?.event.exception?.values?.[0]?.value, 'Fixture SDK [email] [card] play?[query] ?[query]');
  check('SDK transaction text is scrubbed', reported?.event.transaction, 'GET /payment/[card]');
  check('payment fields are filtered', reported?.event.extra?.billing, '[Filtered]');
  check('dynamic email keys are scrubbed without losing diagnostics', reported?.event.extra?.['[email]'], 'useful diagnostic');
  check('invalid card-shaped values are scrubbed', reported?.event.extra?.reference, '[card]');
  check('card-shaped keys are scrubbed', reported?.event.extra?.['[card]'], 'card-shaped key');
  check('valid numeric trace identifiers retain their links', reported?.event.contexts?.trace, { trace_id: '0123456789abcdef0123456789abcdef', span_id: '1234567890123456', parent_span_id: '2345678901234567' });
  check('customer data named span_id still scrubs cards', reported?.event.extra?.span_id, '[card]');
  check('16KiB tokens remain usable diagnostic data', reported?.event.extra?.diagnostic_values?.map?.(value => value.length), Array(8).fill(16000));
  check('16KiB tokens stay below 250ms of SDK CPU', sdkCpuMs < 250, true);
  check('stack frames remain available', Boolean(reported?.event.exception?.values?.[0]?.stacktrace?.frames?.length), true);
  check('private values appear nowhere in SDK envelope', ['buyer@example.com', '4242424242424242', '4242 4242 4242 4243', '4242-4242-4242-4243', 'fixture-private-cvv', 'fixture-private-query', 'fixture-query-only'].filter(value => reported?.raw.includes(value)), []);
} catch (error) {
  check('monitoring E2E completes', error.message, null);
} finally {
  await sdk?.close?.(5000);
  api.closeAllConnections();
  ingest.closeAllConnections();
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => ingest.close(resolve))]);
  restoreGuard();
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, JSON.stringify({ ok: checks.length > 0 && checks.every(item => item.ok), checks, events: events().map(item => item.event), timing, sdkEntry }, null, 2));
  console.log(`report: ${artifact}`);
  process.exitCode = checks.length > 0 && checks.every(item => item.ok) ? 0 : 1;
}

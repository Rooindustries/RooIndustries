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
const browserEntry = createRequire(require.resolve('@sentry/nextjs/package.json')).resolve('@sentry/browser');
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
const caughtCases = [
  { name: 'bare', label: 'Fixture bare continuation', build: () => new Error('request failed\n    at fixture-private-bare') },
  { name: 'frame', label: 'Fixture frame continuation', build: () => new Error('request failed\n    at fake (fixture-private-frame.invalid:42:7)') },
  { name: 'subclass', label: 'Fixture named error', build: () => { const error = new Error('fixture-private-subclass'); error.name = 'FixtureError'; return error; } },
  { name: 'changed', label: 'Fixture changed message', build: () => { const error = new Error('fixture-private-old-message'); void error.stack; error.message = 'fixture-private-new-message'; return error; }, emptyFrames: true },
  { name: 'empty', label: 'Fixture empty message', build: () => new Error('') },
  { name: 'cause', label: 'Fixture appended cause', build: () => { const error = new Error('fixture-private-cause-message'); error.stack += '\nCaused by: fixture-private-cause\n    at fake (fixture-private-cause.invalid:1:1)'; return error; } },
  { name: 'paypal', label: 'Payment recovery requires owner review: paymentRecord.paypal.FIXTUREORDER123', prefix: 'Payment recovery requires owner review', build: () => new Error('fixture-private-paypal-message') },
  { name: 'razorpay', label: 'Captured upgrade requires owner review: paymentRecord.razorpay.payment.FIXTUREPAY123', prefix: 'Captured upgrade requires owner review', build: () => new Error('fixture-private-razorpay-message') },
  { name: 'getter', label: 'Fixture throwing stack', build: () => Object.defineProperty(new Error(), 'stack', { get() { throw new Error('fixture-private-getter'); } }), emptyFrames: true },
  { name: 'string', label: 'Fixture thrown string', build: () => 'fixture-private-string', emptyFrames: true },
];
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

let streamingResponseClosed = false;
const ingest = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const bytes = Buffer.concat(chunks);
    const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString();
    received.push({ body, headers: request.headers, path: request.url });
    if (body.includes('fixture-upstream-network-error')) { request.socket.destroy(); return; }
    response.writeHead(body.includes('fixture-quota-all') ? 429 : body.includes('fixture-upstream-failure') ? 503 : 200, {
      'Set-Cookie': 'provider-only=fixture-private; Path=/',
      ...(body.includes('fixture-quota-category') ? { 'X-Sentry-Rate-Limits': '60:error:organization' } : {}),
      ...(body.includes('fixture-quota-all') ? { 'Retry-After': '60' } : {}),
    });
    if (body.includes('fixture-upstream-stream')) {
      response.once('close', () => { streamingResponseClosed = true; });
      response.write('provider-private-body');
      return;
    }
    response.end('{}');
  });
});
const api = http.createServer(async (request, response) => {
  try {
    if (request.url === '/caught' || request.url.startsWith('/caught?')) {
      const fixture = caughtCases.find(item => item.name === new URL(request.url, origin).searchParams.get('case'));
      const error = fixture ? fixture.build() : new Error('hidden buyer@example.com 4242424242424242');
      if (error && typeof error === 'object') error.code = 'ECONNREFUSED';
      reportError(fixture?.label || 'Fixture caught failure', error);
      response.writeHead(500);
      response.end('Unexpected server error.');
      return;
    }
    if (request.url === '/sdk') {
      sdk.withScope(scope => {
        scope.setTransactionName('GET /payment/4242424242424242');
        scope.setExtra('billing', { cvv: 'fixture-private-cvv' });
        scope.setExtra('payment_details', { amount: 42, currency: 'USD' });
        scope.setExtra('payment_id', 'fixture-private-payment-id');
        scope.setExtra('buyer@example.com', 'useful diagnostic');
        scope.setExtra('reference', '4242 4242 4242 4243');
        scope.setExtra('4242-4242-4242-4243', 'card-shaped key');
        scope.setExtra('span_id', '4242424242424242');
        scope.setExtra('release', 'buyer@example.com');
        scope.setExtra('headers', { 'X-Fixture': 'fixture-extra-header' });
        scope.setContext('fixture', { Headers: { 'X-Fixture': 'fixture-context-header' }, diagnostic: 'keep' });
        scope.addBreadcrumb({ category: 'fixture', data: { HEADERS: { 'X-Fixture': 'fixture-breadcrumb-header' }, diagnostic: 'keep' } });
        scope.setExtra('diagnostic_values', Array(8).fill('a'.repeat(16000)));
        scope.setExtra('diagnostic_urls', ['http://fixture-user:fixture-secret@localhost/path?token=fixture-url', '//fixture-user:fixture-secret@localhost/path?token=fixture-url', 'http://localhost/path']);
        scope.setExtra('text_examples', ['@carol@example.com', '@team,john@example.com', 'δοκιμή@παράδειγμα.δοκιμή', 'foo/@bar.com', '4242\u00a04242\u00a04242\u00a04242', '4242\t4242\t4242\t4242', '4242.4242.4242.4242', '4242_4242_4242_4242']);
        scope.setExtra('path_examples', ['file:///app/node_modules/@sentry/core/build/esm/index.js', '/@fs/source/app.js', '/@vite/client.js', `file:///app/${'@scope/'.repeat(1800)}index.js`]);
        scope.addEventProcessor(event => ({
          ...event,
          request: { ...event.request, headers: { 'User-Agent': 'fixture-agent', 'user-agent': 'fixture-agent-lower', Authorization: 'fixture-authorization' } },
          contexts: { ...event.contexts, trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '1234567890123456', parent_span_id: '2345678901234567' } },
          exception: { ...event.exception, values: event.exception?.values?.map(value => ({ ...value, stacktrace: { ...value.stacktrace, frames: [...value.stacktrace?.frames ?? [], { function: 'fixtureCredentials', filename: 'http://fixture-user:fixture-secret@localhost/script.js?token=fixture-url' }, { function: 'fixtureScoped', filename: 'file:///app/node_modules/@sentry/core/build/esm/index.js', module: '@sentry/core' }, { function: 'fixtureVite', filename: '/@fs/source/app.js', abs_path: '/@vite/client.js' }] } })) },
        }));
        sdk.captureException(new Error('Fixture SDK buyer@example.com 4242424242424242 play?token=fixture-private-query ?token=fixture-query-only'));
      });
      response.end('{}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await relay(new Request(`${origin}/api/client-report`, { method: 'POST', headers: request.headers, body: Buffer.concat(chunks) }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
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
process.env.SENTRY_RELEASE = 'rooindustries@0.2.0';
process.env.NEXT_PUBLIC_VERCEL_ENV = 'carol@example.invalid 4242-4242-4242-4242 ?token=fixture-env';

try {
  sdk = await import('@sentry/nextjs');
  const browser = await import(pathToFileURL(browserEntry).href);
  const { makeFetchTransport } = browser.default ?? browser;
  ({ POST: relay } = await import('../app/api/client-report/route.js'));
  const { startServerMonitoring } = await import('../src/lib/monitoring/server.js');
  ({ logSafeError: reportError } = await import('../src/server/safeErrorLog.js'));
  startServerMonitoring(dsn);
  check('adverse environment is replaced before SDK initialization', sdk.getClient().getOptions().environment, 'unknown');
  const { monitoringDsn } = await import('../src/lib/monitoring/scrub.js');
  check('external HTTP is refused while external HTTPS and loopback HTTP remain valid', [monitoringDsn('http://fixturekey@public.invalid/42') ?? null, monitoringDsn('https://fixturekey@public.invalid/42'), monitoringDsn(dsn)], [null, 'https://fixturekey@public.invalid/42', dsn]);
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
  const streamedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(envelope(dsn, `fixture-stream-oversize ${'x'.repeat(300 * 1024)}`)));
      controller.close();
    },
  });
  check('chunked oversized report without Content-Length is refused', (await fetch(`${origin}/api/client-report`, {
    method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: streamedBody, duplex: 'half',
  })).status, 413);
  check('streamed oversized report never reaches ingest', received.filter(item => item.body.includes('fixture-stream-oversize')).length, 0);
  check('invalid envelope is refused', (await post('not json')).status, 400);
  check('upstream failure status is preserved', (await post(envelope(dsn, 'fixture-upstream-failure'))).status, 503);
  check('upstream connection failure returns 502', (await post(envelope(dsn, 'fixture-upstream-network-error'))).status, 502);
  check('an unending provider body keeps its response status', (await post(envelope(dsn, 'fixture-upstream-stream'))).status, 200);
  for (let i = 0; i < 20 && !streamingResponseClosed; i++) await new Promise(resolve => setTimeout(resolve, 50));
  check('an unending provider body is canceled within one second', streamingResponseClosed, true);
  process.env.NEXT_PUBLIC_SENTRY_DSN = '';
  check('disabled reporting returns 404', (await post(envelope(dsn, 'fixture-disabled'))).status, 404);
  process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
  check('refused envelopes never reach ingest', received.filter(item => /fixture-(foreign|cross|disabled)/.test(item.body)).length, 0);
  for (const [kind, status, header, value, forwarded] of [
    ['category', 200, 'x-sentry-rate-limits', '60:error:organization', 2],
    ['all', 429, 'retry-after', '60', 1],
  ]) {
    const marker = `fixture-quota-${kind}`;
    const direct = await post(envelope(dsn, `${marker}-direct`));
    check(`${kind} quota status and header are preserved without provider cookies`, [direct.status, direct.headers.get(header), direct.headers.get('set-cookie')], [status, value, null]);
    const dropped = [];
    const transport = makeFetchTransport({ url: `${origin}/api/client-report`, headers: { Origin: origin }, recordDroppedEvent: (...args) => dropped.push(args) }, fetch);
    const sdkEnvelope = type => [{ dsn }, [[{ type }, type === 'event' ? { message: `${marker}-sdk` } : {
      type: 'transaction', transaction: `${marker}-sdk`, start_timestamp: Date.now() / 1000, timestamp: Date.now() / 1000,
      contexts: { trace: { trace_id: 'abcdef0123456789abcdef0123456789', span_id: 'abcdef0123456789', op: 'fixture' } },
    }]]];
    await transport.send(sdkEnvelope('event'));
    await transport.send(sdkEnvelope('event'));
    await transport.send(sdkEnvelope('transaction'));
    await transport.flush(5000);
    check(`${kind} quota makes the real browser SDK stop the correct categories`, [received.filter(item => item.body.includes(`${marker}-sdk`)).length, dropped.some(([reason]) => reason === 'ratelimit_backoff')], [forwarded, true]);
  }
  const caughtResponse = await fetch(`${origin}/caught`);
  check('caught application failure keeps its status', caughtResponse.status, 500);
  check('caught application failure keeps its generic response', await caughtResponse.text(), 'Unexpected server error.');
  for (const fixture of caughtCases) {
    const response = await fetch(`${origin}/caught?case=${fixture.name}`);
    check(`${fixture.name} keeps the generic caught response`, [response.status, await response.text()], [500, 'Unexpected server error.']);
    await sdk.flush(5000);
    const item = events().find(item => item.event.exception?.values?.[0]?.value === (fixture.prefix || fixture.label));
    check(`${fixture.name} has the expected safe report`, Boolean(item), true);
    if (item) {
      const frames = item.event.exception?.values?.[0]?.stacktrace?.frames ?? [];
      check(`${fixture.name} retains only unambiguous genuine frames`, fixture.emptyFrames ? frames.length : frames.some(frame => frame.filename?.includes('monitoring-e2e.mjs')), fixture.emptyFrames ? 0 : true);
      check(`${fixture.name} has no private message or payment identifier in the envelope`, /fixture-private-|FIXTUREORDER123|FIXTUREPAY123/.test(item.raw), false);
    }
  }
  const cpuBefore = process.cpuUsage();
  await fetch(`${origin}/sdk`);
  sdk.captureEvent({ message: 'Fixture private release', release: 'buyer@example.com' });
  sdk.captureEvent({ message: 'Fixture card release', release: 'rooindustries@4242.4242.4242-4242' });
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
  check('whole payment records and identifiers are filtered', [reported?.event.extra?.payment_details, reported?.event.extra?.payment_id], ['[Filtered]', '[Filtered]']);
  check('dynamic email keys are scrubbed without losing diagnostics', reported?.event.extra?.['[email]'], 'useful diagnostic');
  check('absolute and scheme-relative diagnostic URLs lose userinfo', reported?.event.extra?.diagnostic_urls, ['http://localhost/path?[query]', '//localhost/path?[query]', 'http://localhost/path']);
  check('stack frame URLs lose userinfo and query', reported?.event.exception?.values?.[0]?.stacktrace?.frames?.find(frame => frame.function === 'fixtureCredentials')?.filename, 'http://localhost/script.js');
  check('all email prefixes and formatted card values are scrubbed', reported?.event.extra?.text_examples, [...Array(4).fill('[email]'), ...Array(4).fill('[card]')]);
  check('scoped and Vite paths survive including a long multi-at path', reported?.event.extra?.path_examples, ['file:///app/node_modules/@sentry/core/build/esm/index.js', '/@fs/source/app.js', '/@vite/client.js', `file:///app/${'@scope/'.repeat(1800)}index.js`]);
  const scoped = reported?.event.exception?.values?.[0]?.stacktrace?.frames?.find(frame => frame.function === 'fixtureScoped');
  const vite = reported?.event.exception?.values?.[0]?.stacktrace?.frames?.find(frame => frame.function === 'fixtureVite');
  check('actual scoped and Vite frame locations survive', [scoped?.filename, scoped?.module, vite?.filename, vite?.abs_path], ['file:///app/node_modules/@sentry/core/build/esm/index.js', '@sentry/core', '/@fs/source/app.js', '/@vite/client.js']);
  check('SDK request has no headers even when explicitly attached', reported?.event.request?.headers ?? null, null);
  check('invalid card-shaped values are scrubbed', reported?.event.extra?.reference, '[card]');
  check('card-shaped keys are scrubbed', reported?.event.extra?.['[card]'], 'card-shaped key');
  check('valid numeric trace identifiers retain their links', reported?.event.contexts?.trace, { trace_id: '0123456789abcdef0123456789abcdef', span_id: '1234567890123456', parent_span_id: '2345678901234567' });
  check('customer data named span_id still scrubs cards', reported?.event.extra?.span_id, '[card]');
  check('16KiB tokens remain usable diagnostic data', reported?.event.extra?.diagnostic_values?.map?.(value => value.length), Array(8).fill(16000));
  check('16KiB tokens stay below 250ms of SDK CPU', sdkCpuMs < 250, true);
  check('stack frames remain available', Boolean(reported?.event.exception?.values?.[0]?.stacktrace?.frames?.length), true);
  check('SDK release identity survives without exempting customer metadata', [reported?.event.release, reported?.event.extra?.release], ['rooindustries@0.2.0', '[email]']);
  check('semantic release handling still scrubs private and card-shaped root values', events().filter(item => item.event.message === 'Fixture private release' || item.event.message === 'Fixture card release').map(item => item.event.release), ['[email]', '[email]']);
  check('nested headers are excluded without losing adjacent diagnostics', [reported?.event.extra?.headers ?? null, reported?.event.contexts?.fixture, reported?.event.breadcrumbs?.find(crumb => crumb.category === 'fixture')?.data], [null, { diagnostic: 'keep' }, { diagnostic: 'keep' }]);
  check('metadata and nested header sentinels appear nowhere in captured SDK envelopes', received.filter(item => /fixture-env|carol@example.invalid|fixture-extra-header|fixture-context-header|fixture-breadcrumb-header/.test(item.body)).length, 0);
  check('errors and traces do not send automatic session aggregates', received.flatMap(item => item.body.split('\n').filter(Boolean).filter((line, index) => index % 2 === 1).map(line => JSON.parse(line).type)).filter(type => type === 'session' || type === 'sessions').length, 0);
  check('private values appear nowhere in SDK envelope', ['buyer@example.com', '4242424242424242', '4242 4242 4242 4243', '4242-4242-4242-4243', 'fixture-private-cvv', 'fixture-private-payment-id', 'fixture-private-query', 'fixture-query-only', 'fixture-user', 'fixture-secret', 'fixture-url', 'fixture-agent', 'fixture-authorization', 'carol@example.com', 'john@example.com', 'δοκιμή@παράδειγμα.δοκιμή'].filter(value => reported?.raw.includes(value)), []);
  await sdk.close(5000);
  const { register } = await import('../instrumentation.js');
  for (const invalid of ['', 'false', 'off', `"${dsn}"`, dsn.replace('http:', 'ftp:'), dsn.replace('fixturekey', 'invalid-key'), dsn.replace('/42', '/no-project'), `${dsn}?token=fixture-config`, `${dsn}#fixture-config`]) {
    process.env.NEXT_PUBLIC_SENTRY_DSN = invalid;
    check(`optional monitoring startup resolves for ${invalid ? 'malformed' : 'missing'} config`, await register().then(() => true, () => false), true);
    check('unavailable monitoring relay is off', (await post(envelope(invalid, 'fixture-disabled-config'))).status, 404);
    const normal = await fetch(`${origin}/caught`);
    check('normal caught response is unchanged with unavailable monitoring', [normal.status, await normal.text()], [500, 'Unexpected server error.']);
  }
  process.env.NEXT_PUBLIC_SENTRY_DSN = `  http://fixturekey:legacy-password@127.0.0.1:${ingest.address().port}/42 \n`;
  check('canonical legacy DSN config starts safely', await register().then(() => true, () => false), true);
  check('canonical public DSN matches the relay config', (await post(envelope(dsn, 'fixture-canonical'))).status, 200);
  check('no legacy DSN password is forwarded', received.some(item => item.body.includes('legacy-password')), false);
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

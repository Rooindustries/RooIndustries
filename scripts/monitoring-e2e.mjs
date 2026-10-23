import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';
import { checkBrowserBootstrap } from './monitoring-bootstrap-e2e.mjs';
import { normalizedCards, normalizedEmails, separatorRuns, releaseSha, samplingId, surfaceCases, plusRun, diagnosticControls, querySegments } from './monitoring-recognizer-cases.mjs';

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
const providerCalls = [];
let outgoingSpansObserved = 0;
let sdk;
let reportError;
let relay;
let onRequestError;
let uncaughtUnchanged = false;
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
const events = (type = 'event') => received.flatMap(({ body }) => {
  const lines = body.split('\n').filter(Boolean);
  const result = [];
  for (let index = 1; index + 1 < lines.length; index += 2) {
    if (JSON.parse(lines[index]).type === type) result.push({ raw: body, event: JSON.parse(lines[index + 1]) });
  }
  return result;
});

let streamingResponseClosed = false;
const redirected = [];
const redirectTarget = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    redirected.push({ method: request.method, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'Retry-After': '7' });
    response.end('{}');
  });
});
const ingest = http.createServer((request, response) => {
  if (request.url.startsWith('/v1/payments/')) {
    providerCalls.push(request.url);
    response.end('invalid-provider-json');
    return;
  }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const bytes = Buffer.concat(chunks);
    const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString();
    received.push({ body, headers: request.headers, path: request.url });
    const redirect = body.match(/fixture-redirect-(301|302|303|307|308)/);
    if (redirect) {
      response.writeHead(Number(redirect[1]), { Location: `http://127.0.0.1:${redirectTarget.address().port}/elsewhere` });
      response.end();
      return;
    }
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
    if (request.url === '/uncaught') {
      const error = new TypeError('Fixture uncaught buyer@example.com 4242-4242-4242-4242 /play?token=fixture-uncaught-query card_4111111111111111 buyer%40example.com');
      const message = error.message;
      await onRequestError(error, { path: '/api/fixture', method: 'GET', headers: { authorization: 'fixture-uncaught-authorization', cookie: 'fixture-uncaught-cookie' } }, { routerKind: 'App Router', routePath: '/api/fixture', routeType: 'route' });
      uncaughtUnchanged = error.message === message && error.name === 'TypeError';
      response.writeHead(500);
      response.end('Unexpected server error.');
      return;
    }
    if (request.url === '/network') {
      const random = Math.random;
      Math.random = () => 0;
      try {
        await sdk.startSpan({ name: 'Fixture network root', op: 'fixture', forceTransaction: true }, async () => {
          try { await (await fetch(`${ingestOrigin}/v1/payments/pay_PROBEPAYMENTID42/refunds?count=100&skip=0`)).json(); }
          catch (error) { reportError('Razorpay payment verification failed', error); }
          await new Promise((resolve, reject) => http.get(`${ingestOrigin}/v1/payments/pay_HTTPPAYMENTID42`, result => { result.resume(); result.on('end', resolve); }).on('error', reject));
          sdk.withScope(scope => {
            for (const category of ['fetch', 'xhr']) scope.addBreadcrumb({ category, message: 'pay_BROWSERPAYMENTID42', data: { url: `${ingestOrigin}/v1/payments/pay_BROWSERPAYMENTID42`, method: 'GET', status_code: 200 } });
            scope.addBreadcrumb({ category: 'fetch', message: 'pay_RELATIVEPAYMENTID42', data: { url: '/v1/payments/pay_RELATIVEPAYMENTID42', method: 'POST', status_code: 201 } });
            scope.addBreadcrumb({ category: 'xhr', message: 'pay_FTPPAYMENTID42', data: { url: 'ftp://files.invalid/pay_FTPPAYMENTID42', method: 'POST', status_code: 202 } });
            sdk.captureException(new Error('Fixture network categories'));
          });
        });
      } finally { Math.random = random; }
      response.writeHead(500);
      response.end('Unexpected server error.');
      return;
    }
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
        scope.setContext('fixture', { Headers: { 'X-Fixture': 'fixture-context-header' }, 'user_agent.original': 'fixture-span-agent', diagnostic: 'keep' });
        scope.addBreadcrumb({ category: 'fixture', data: { HEADERS: { 'X-Fixture': 'fixture-breadcrumb-header' }, diagnostic: 'keep' } });
        scope.setExtra('diagnostic_values', Array(8).fill('a'.repeat(16000)));
        scope.setExtra('diagnostic_urls', ['http://fixture-user:fixture-secret@localhost/path?token=fixture-url', '//fixture-user:fixture-secret@localhost/path?token=fixture-url', 'http://localhost/path']);
        scope.setExtra('text_examples', ['@carol@example.com', '@team,john@example.com', 'δοκιμή@παράδειγμα.δοκιμή', 'foo/@bar.com', 'jane.doe//@example.com', 'jane//x@example.com', 'john@gmail?.com', 'jane.doe?@example.com', '4242\u00a04242\u00a04242\u00a04242', '4242\t4242\t4242\t4242', '4242.4242.4242.4242', '4242_4242_4242_4242']);
        scope.setExtra('path_examples', ['file:///app/node_modules/@sentry/core/build/esm/index.js', '/@fs/source/app.js', '/@vite/client.js', `file:///app/${'@scope/'.repeat(1800)}index.js`]);
        scope.setExtra('ordering_examples', ['what?4111 1111 1111 1111', 'lookup?n=4242 4242 4242 4242', 'a@b.4111 1111 1111 1111']);
        scope.setExtra('identifier_examples', ['card_4111111111111111', 'x4111111111111111y', '4111111111111111_suffix', 'card_4111-1111-1111-1111', 'pan4111 1111 1111 1111end', '🔒x4111 1111 1111 1111y', '41111111111111111225', '４１１１１１１１１１１１１１１１', '٤١١١١١١١١١١١١١١١']);
        scope.setExtra('encoded_examples', ['buyer%40example.com', '/api/x/buyer%40example.com', 'buyer%40example%2Ecom']);
        scope.setExtra('normalized_values', { forms: normalizedCards, texts: normalizedEmails, urls: ["http://u:it's@localhost/x", encodeURIComponent("http://u:it's@localhost/x")] });
        scope.setExtra('normalized_keys', { [normalizedCards[0]]: 'digits', ['a@b%2F.c']: 'contact' });
        scope.setExtra('probe_x4111111111111111y', 'keep');
        scope.setExtra('event_id', 'a1234567890123' + 'b'.repeat(18));
        scope.addBreadcrumb({ category: 'navigation', data: { from: '/api/x/buyer%40example.com', to: '/api/x/buyer%40example%2Ecom' } });
        scope.addBreadcrumb({ category: 'navigation', data: { label: 'normalized', from: '/api/x/a%40b%2F.c', to: `/api/x/${normalizedCards[1]}` } });
        scope.addEventProcessor(event => ({
          ...event,
          event_id: 'a1234567890123' + 'b'.repeat(18),
          request: { ...event.request, headers: { 'User-Agent': 'fixture-agent', 'user-agent': 'fixture-agent-lower', Authorization: 'fixture-authorization' } },
          contexts: { ...event.contexts, trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '1234567890123456', parent_span_id: '2345678901234567' } },
          exception: { ...event.exception, values: event.exception?.values?.map(value => ({ ...value, stacktrace: { ...value.stacktrace, frames: [...value.stacktrace?.frames ?? [], { function: 'fixtureCredentials', filename: 'http://fixture-user:fixture-secret@localhost/script.js?token=fixture-url' }, { function: 'fixtureScoped', filename: 'file:///app/node_modules/@sentry/core/build/esm/index.js', module: '@sentry/core' }, { function: 'fixtureVite', filename: '/@fs/source/app.js', abs_path: '/@vite/client.js' }, { function: 'fixtureNormalizedContact', filename: 'http://localhost/api/x/a%40b%2F.c' }, { function: 'fixtureNormalizedCard', filename: `http://localhost/api/x/${normalizedCards[1]}.js` }, { function: 'fixtureQuotedCredentials', filename: "http://u:it's@localhost/script.js" }] } })) },
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
await new Promise(resolve => redirectTarget.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => api.listen(0, process.env.ROO_TEST_HOST || '127.0.0.1', resolve));
const ingestOrigin = `http://127.0.0.1:${ingest.address().port}`;
origin = `http://${process.env.ROO_TEST_HOST || '127.0.0.1'}:${api.address().port}`;
const dsn = `http://fixturekey@127.0.0.1:${ingest.address().port}/42`;
const unmodifiedFetch = globalThis.fetch;
const restoreGuard = installNetworkGuard([origin, ingestOrigin, `http://127.0.0.1:${redirectTarget.address().port}`]);
process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.NEXT_PUBLIC_ROO_SENTRY_ENABLED = '1';
process.env.NEXT_RUNTIME = 'nodejs';
process.env.SENTRY_RELEASE = 'rooindustries@0.2.0';
process.env.NEXT_PUBLIC_VERCEL_ENV = 'carol@example.invalid 4242-4242-4242-4242 ?token=fixture-env';

try {
  await checkBrowserBootstrap(check);
  sdk = await import('@sentry/nextjs');
  const browser = await import(pathToFileURL(browserEntry).href);
  const { makeFetchTransport } = browser.default ?? browser;
  ({ POST: relay } = await import('../app/api/client-report/route.js'));
  ({ onRequestError } = await import('../instrumentation.js'));
  const { startServerMonitoring } = await import('../src/lib/monitoring/server.js');
  ({ logSafeError: reportError } = await import('../src/server/safeErrorLog.js'));
  startServerMonitoring(dsn);
  sdk.addEventProcessor(event => {
    if (event.type === 'transaction' && event.transaction === 'Fixture network root') outgoingSpansObserved += (event.spans ?? []).filter(span => span.op === 'http.client').length;
    return event;
  });
  check('adverse environment is replaced before SDK initialization', sdk.getClient().getOptions().environment, 'unknown');
  const { monitoringDsn } = await import('../src/lib/monitoring/scrub.js');
  check('local monitoring refuses external DSNs while loopback remains valid', [monitoringDsn('http://fixturekey@public.invalid/42') ?? null, monitoringDsn('https://fixturekey@public.invalid/42') ?? null, monitoringDsn(dsn)], [null, null, dsn]);
  const previousEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV;
  process.env.NEXT_PUBLIC_VERCEL_ENV = 'production';
  check('production still accepts the configured HTTPS DSN', monitoringDsn('https://fixturekey@public.invalid/42'), 'https://fixturekey@public.invalid/42');
  process.env.NEXT_PUBLIC_VERCEL_ENV = previousEnvironment;
  const envelope = (target, message) => `${JSON.stringify({ dsn: target })}\n{"type":"event"}\n${JSON.stringify({ message })}\n`;
  const post = (body, headers = {}) => fetch(`${origin}/api/client-report`, {
    method: 'POST',
    body,
    headers: { origin, 'content-type': 'text/plain', ...headers },
  });
  const previousHosted = process.env.NEXT_PUBLIC_SENTRY_HOSTED;
  process.env.NEXT_PUBLIC_VERCEL_ENV = 'preview';
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://fixturekey@public.invalid/42';
  delete process.env.NEXT_PUBLIC_SENTRY_HOSTED;
  check('local preview refuses an inherited external DSN at the HTTP relay', (await post(envelope(dsn, 'fixture-local-external'))).status, 404);
  process.env.NEXT_PUBLIC_SENTRY_HOSTED = '1';
  check('hosted preview refuses external reporting configuration', monitoringDsn(process.env.NEXT_PUBLIC_SENTRY_DSN) ?? null, null);
  check('hosted preview relay stays disabled for external reporting', (await post(envelope(dsn, 'fixture-hosted-wrong-project'))).status, 404);
  process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
  process.env.NEXT_PUBLIC_VERCEL_ENV = previousEnvironment;
  if (previousHosted === undefined) delete process.env.NEXT_PUBLIC_SENTRY_HOSTED;
  else process.env.NEXT_PUBLIC_SENTRY_HOSTED = previousHosted;
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
  const guardedFetch = globalThis.fetch;
  let relayRawFetchCalls = 0;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin === ingestOrigin && url.pathname === '/api/42/envelope/' && options?.body instanceof Uint8Array && /fixture-redirect-(301|302|303|307|308)/.test(new TextDecoder().decode(options.body))) {
      relayRawFetchCalls++;
      return unmodifiedFetch(input, options);
    }
    return guardedFetch(input, options);
  };
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const reply = await post(envelope(dsn, `fixture-redirect-${status}`));
      check(`${status} redirects cannot send an envelope to another origin`, [reply.status, redirected.length, reply.headers.get('retry-after')], [502, 0, null]);
    }
    check('every redirect case exercises the route fetch without guard rewriting', relayRawFetchCalls, 5);
  } finally {
    globalThis.fetch = guardedFetch;
  }
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
  const networkResponse = await fetch(`${origin}/network`);
  sdk.captureEvent({ type: 'transaction', transaction: `GET ${ingestOrigin}/v1/payments/pay_ROOTPAYMENTID42`, start_timestamp: Date.now() / 1000, timestamp: Date.now() / 1000, contexts: { trace: { trace_id: '34567890123456789012345678901234', span_id: '3456789012345678', op: 'http.client', data: { 'http.request.method': 'GET', 'http.url': `${ingestOrigin}/v1/payments/pay_ROOTPAYMENTID42`, 'http.target': '/v1/payments/pay_METAPAYMENTID42', private_network_detail: 'pay_METAPAYMENTID42' } } }, spans: [] });
  await sdk.flush(5000);
  check('provider-path failures keep the generic application response', [networkResponse.status, await networkResponse.text()], [500, 'Unexpected server error.']);
  check('the real SDK observes both fetch and native HTTP child spans', [providerCalls.length, outgoingSpansObserved >= 2], [2, true]);
  const networkError = events().find(item => item.event.exception?.values?.[0]?.value === 'Razorpay payment verification failed');
  check('payment lookup errors retain their safe label and real stack', Boolean(networkError?.event.exception?.values?.[0]?.stacktrace?.frames?.length), true);
  const networkItems = received.filter(item => item.body.includes('Fixture network root') || item.body.includes('Fixture network categories') || item.body.includes('Razorpay payment verification failed') || item.body.includes('34567890123456789012345678901234'));
  check('payment path identifiers appear nowhere in error or transaction envelopes', networkItems.some(item => /pay_(?:PROBE|HTTP|BROWSER|RELATIVE|FTP|ROOT|META)PAYMENTID42/.test(item.body)), false);
  const networkCrumbs = events().find(item => item.event.exception?.values?.[0]?.value === 'Fixture network categories')?.event.breadcrumbs?.filter(crumb => ['fetch', 'xhr'].includes(crumb.category) || crumb.data?.url?.startsWith(ingestOrigin)) ?? [];
  check('network breadcrumb diagnostics retain only the provider origin', [networkCrumbs.length >= 3, networkCrumbs.filter(crumb => crumb.data?.status_code === 200).every(crumb => crumb.data?.url === ingestOrigin && !crumb.message)], [true, true]);
  check('relative and non-HTTP network targets are omitted without losing status', networkCrumbs.filter(crumb => [201, 202].includes(crumb.data?.status_code)).map(crumb => crumb.data), [{ method: 'POST', status_code: 201 }, { method: 'POST', status_code: 202 }]);
  check('root HTTP transaction metadata keeps only safe network fields', events('transaction').find(item => item.event.contexts?.trace?.trace_id === '34567890123456789012345678901234')?.event.transaction, `GET ${ingestOrigin}`);
  const cpuBefore = process.cpuUsage();
  await fetch(`${origin}/sdk`);
  for (const [index, [value]] of surfaceCases.entries()) sdk.captureEvent({
    message: `Fixture surface ${index}: ${value}`, tags: { fixture_case: `surface-${index}` },
    exception: { values: [{ type: 'Error', value: `Fixture surface ${index}: ${value}`, stacktrace: { frames: [{ filename: `http://localhost/api/x/${value}`, function: 'fixtureSurface' }] } }] },
    extra: { reference: value, keys: { [value]: 'keep' } },
    request: { method: 'GET', url: `http://localhost/api/x/${value}` },
    breadcrumbs: [{ category: 'navigation', data: { label: `surface-${index}`, from: value, to: `http://localhost/api/x/${value}` } }],
  });
  sdk.captureEvent({ message: 'Fixture recognizer controls', release: 'rooindustries@0.2.0', extra: { diagnostic_values: diagnosticControls, separator_run: plusRun, query_examples: querySegments } });
  sdk.captureEvent({ message: 'Fixture private release', release: 'buyer@example.com' });
  sdk.captureEvent({ message: 'Fixture card release', release: 'rooindustries@4242.4242.4242-4242' });
  for (const [name, value] of [['contact', 'a%40b%2F.c'], ['PAN', normalizedCards[1]]]) sdk.captureEvent({ message: `Fixture normalized request ${name}`, request: { method: 'GET', url: `http://localhost/api/x/${value}` } });
  sdk.captureEvent({ message: `Fixture normalized text ${normalizedCards[0]} a@b%2F.c` });
  sdk.captureEvent({ message: 'Fixture SHA release', release: releaseSha, sdkProcessingMetadata: { dynamicSamplingContext: { trace_id: samplingId, public_key: sdk.getClient().getDsn().publicKey } }, extra: { separator_runs: separatorRuns, generic_reference: releaseSha } });
  await sdk.flush(5000);
  const sdkCpu = process.cpuUsage(cpuBefore);
  const sdkCpuMs = (sdkCpu.user + sdkCpu.system) / 1000;
  timing.push({ name: 'SDK event with eight 16KiB tokens', length: 16000, count: 8, cpuMs: sdkCpuMs });
  const caught = events().find(item => item.event.exception?.values?.[0]?.value === 'Fixture caught failure');
  check('caught errors reach the real Next SDK', Boolean(caught), true);
  for (const [index, [, text, path, keyValue]] of surfaceCases.entries()) {
    const item = events().find(item => item.event.tags?.fixture_case === `surface-${index}`)?.event;
    check(`encoded query and plus-card surface ${index}`, [
      item?.message, item?.exception?.values?.[0]?.value, item?.extra?.reference, item?.extra?.keys,
      item?.request?.url, item?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename,
      item?.breadcrumbs?.find(crumb => crumb.data?.label === `surface-${index}`)?.data,
    ], [`Fixture surface ${index}: ${text}`, `Fixture surface ${index}: ${text}`, text, { [text]: keyValue }, path, path, { label: `surface-${index}`, from: text, to: path }]);
  }
  const controls = events().find(item => item.event.message === 'Fixture recognizer controls')?.event;
  check('raw queries stay precise while semver, offsets and ordinary plus signs survive', [controls?.release, controls?.extra?.diagnostic_values], ['rooindustries@0.2.0', ['https://example.test/cb?[query]', ...diagnosticControls.slice(1)]]);
  check('16KiB plus-separated digits are scrubbed', controls?.extra?.separator_run, '[card]');
  check('encoded queries outside the first raw query are scrubbed', controls?.extra?.query_examples, ['[query]', '[query]']);
  check('caught reports contain no original error message', /hidden|buyer@example.com|4242424242424242/.test(caught?.raw || ''), false);
  const reported = events().find(item => item.event.exception?.values?.[0]?.value?.startsWith('Fixture SDK'));
  check('SDK error text and relative queries are scrubbed', reported?.event.exception?.values?.[0]?.value, 'Fixture SDK [email] [card] play?[query] ?[query]');
  check('SDK transaction text is scrubbed', reported?.event.transaction, 'GET /payment/[card]');
  check('payment fields are filtered', reported?.event.extra?.billing, '[Filtered]');
  check('whole payment records and identifiers are filtered', [reported?.event.extra?.payment_details, reported?.event.extra?.payment_id], ['[Filtered]', '[Filtered]']);
  check('dynamic email keys are scrubbed without losing diagnostics', reported?.event.extra?.['[email]'], 'useful diagnostic');
  check('absolute and scheme-relative diagnostic URLs lose userinfo', reported?.event.extra?.diagnostic_urls, ['http://localhost/path?[query]', '//localhost/path?[query]', 'http://localhost/path']);
  check('stack frame URLs lose userinfo and query', reported?.event.exception?.values?.[0]?.stacktrace?.frames?.find(frame => frame.function === 'fixtureCredentials')?.filename, 'http://localhost/script.js');
  check('all email prefixes and formatted card values are scrubbed', reported?.event.extra?.text_examples, [...Array(8).fill('[email]'), ...Array(4).fill('[card]')]);
  check('overlapping email, card and query ranges leave no fragments', reported?.event.extra?.ordering_examples, ['what?[query]', 'lookup?[query]', '[email]']);
  check('identifier-adjacent card values and decimal variants are scrubbed', reported?.event.extra?.identifier_examples, ['card_[card]', 'x[card]y', '[card]_suffix', 'card_[card]', 'pan[card]end', '🔒x[card]y', '[card]', '[card]', '[card]']);
  check('percent-encoded email tokens are scrubbed', reported?.event.extra?.encoded_examples, Array(3).fill('[email]'));
  check('encoded, Unicode and multiple-separator cards are scrubbed', reported?.event.extra?.normalized_values?.forms, Array(normalizedCards.length).fill('[card]'));
  check('accepted raw and encoded contact forms remain private', reported?.event.extra?.normalized_values?.texts, Array(normalizedEmails.length).fill('[email]'));
  check('raw and encoded apostrophe credentials are scrubbed', reported?.event.extra?.normalized_values?.urls, ['http://localhost/x', '[Filtered]']);
  check('normalized metadata keys retain only safe labels', reported?.event.extra?.normalized_keys, { '[card]': 'digits', '[email]': 'contact' });
  check('normalized navigation values are scrubbed', reported?.event.breadcrumbs?.find(item => item.data?.label === 'normalized')?.data, { label: 'normalized', from: '[email]', to: '[card]' });
  check('normalized contacts and cards leave no raw SDK envelope fragments', [...normalizedCards, ...normalizedEmails].some(value => reported.raw.includes(value)), false);
  const normalizedFrames = reported?.event.exception?.values?.[0]?.stacktrace?.frames ?? [];
  check('normalized frame paths are scrubbed without dropping credential-free callsites', ['fixtureNormalizedContact', 'fixtureNormalizedCard', 'fixtureQuotedCredentials'].map(name => normalizedFrames.find(frame => frame.function === name)?.filename), ['[email]', '[card]', 'http://localhost/script.js']);
  check('actual SDK request paths scrub separator contacts and encoded cards', ['contact', 'PAN'].map(name => events().find(item => item.event.message === `Fixture normalized request ${name}`)?.event.request?.url), ['[email]', '[card]']);
  check('actual SDK messages scrub normalized sensitive values', events().some(item => item.event.message === 'Fixture normalized text [card] [email]'), true);
  const shaItem = events().find(item => item.event.message === 'Fixture SHA release');
  check('root SHA release and semantic DSC identity survive', [shaItem?.event.release, JSON.parse(shaItem?.raw.split('\n')[0] ?? '{}').trace?.trace_id], [releaseSha, samplingId]);
  check('generic SHA-looking customer metadata is not exempt', shaItem?.event.extra?.generic_reference, 'a[card]' + 'b'.repeat(26));
  check('16KiB separator runs retain diagnostics', shaItem?.event.extra?.separator_runs, separatorRuns);
  check('encoded navigation paths lose contact data', reported?.event.breadcrumbs?.find(item => item.category === 'navigation')?.data, { from: '[email]', to: '[email]' });
  check('identifier-adjacent metadata keys are scrubbed', [reported?.event.extra?.['probe_x[card]y'], 'probe_x4111111111111111y' in (reported?.event.extra ?? {})], ['keep', false]);
  check('root event identifiers and envelope headers keep the same valid identity', [reported?.event.event_id, JSON.parse(reported.raw.split('\n')[0]).event_id], Array(2).fill('a1234567890123' + 'b'.repeat(18)));
  check('generic metadata named event_id is not exempt', reported?.event.extra?.event_id, 'a[card]' + 'b'.repeat(18));
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
  check('metadata and nested header sentinels appear nowhere in captured SDK envelopes', received.filter(item => /fixture-env|carol@example.invalid|fixture-extra-header|fixture-context-header|fixture-breadcrumb-header|fixture-span-agent/.test(item.body)).length, 0);
  check('errors and traces do not send automatic session aggregates', received.flatMap(item => item.body.split('\n').filter(Boolean).filter((line, index) => index % 2 === 1).map(line => JSON.parse(line).type)).filter(type => type === 'session' || type === 'sessions').length, 0);
  check('private values appear nowhere in SDK envelope', ['buyer@example.com', '4242424242424242', '4242 4242 4242 4243', '4242-4242-4242-4243', 'fixture-private-cvv', 'fixture-private-payment-id', 'fixture-private-query', 'fixture-query-only', 'fixture-user', 'fixture-secret', 'fixture-url', 'fixture-agent', 'fixture-authorization', 'carol@example.com', 'john@example.com', 'δοκιμή@παράδειγμα.δοκιμή'].filter(value => reported?.raw.includes(value)), []);
  const uncaughtResponse = await fetch(`${origin}/uncaught`);
  await sdk.flush(5000);
  const uncaught = events().find(item => item.event.exception?.values?.[0]?.value?.startsWith('Fixture uncaught'));
  const uncaughtValue = uncaught?.event.exception?.values?.[0];
  check('actual onRequestError preserves response, error type and frames', [uncaughtResponse.status, await uncaughtResponse.text(), uncaughtUnchanged, uncaughtValue?.type, (uncaughtValue?.stacktrace?.frames?.length ?? 0) > 0, uncaughtValue?.mechanism?.handled], [500, 'Unexpected server error.', true, 'TypeError', true, false]);
  check('actual onRequestError scrubs the requested sensitive message fields', uncaughtValue?.value, 'Fixture uncaught [email] [card] /play?[query] card_[card] [email]');
  check('uncaught request headers and PII reach no SDK envelope field', ['buyer@example.com', '4242-4242-4242-4242', 'fixture-uncaught-query', 'fixture-uncaught-authorization', 'fixture-uncaught-cookie', '4111111111111111', 'buyer%40example.com'].some(value => uncaught?.raw.includes(value)), false);
  sdk.captureEvent({ message: 'Fixture encoded request', request: { method: 'GET', url: 'http://localhost/api/x/buyer%40example.com' } });
  await sdk.flush(5000);
  check('actual SDK request paths scrub encoded contacts', events().find(item => item.event.message === 'Fixture encoded request')?.event.request?.url, '[email]');
  for (const breadcrumb of [{ category: 'fetch', data: null }, { category: 'fixture-malformed', message: 17, data: { diagnostic: 'keep-invalid-message' } }]) {
    let threw = false;
    try { sdk.addBreadcrumb(breadcrumb); } catch { threw = true; }
    check('malformed ' + breadcrumb.category + ' breadcrumb cannot break reporting', threw, false);
  }
  sdk.captureEvent({ message: 'Fixture malformed breadcrumbs' });
  await sdk.flush(5000);
  const malformed = events().find(item => item.event.message === 'Fixture malformed breadcrumbs')?.event.breadcrumbs?.find(item => item.category === 'fixture-malformed');
  check('invalid breadcrumb messages are removed without dropping diagnostic data', [malformed?.message ?? null, malformed?.data], [null, { diagnostic: 'keep-invalid-message' }]);
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
  redirectTarget.closeAllConnections();
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => ingest.close(resolve)), new Promise(resolve => redirectTarget.close(resolve))]);
  restoreGuard();
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, JSON.stringify({ ok: checks.length > 0 && checks.every(item => item.ok), checks, events: events().map(item => item.event), transactions: events('transaction').map(item => item.event), timing, sdkEntry }, null, 2));
  console.log(`report: ${artifact}`);
  process.exitCode = checks.length > 0 && checks.every(item => item.ok) ? 0 : 1;
}

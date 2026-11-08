import fs from 'node:fs';
import {registerHooks} from 'node:module';
import {runLegacyApiHandler} from '../../src/lib/nextApiAdapter.js';

const sources = new Map(['updatePayments.js', 'payoutUtils.js'].map(file => [
  new URL(`../../src/server/api/ref/${file}`, import.meta.url).href,
  fs.readFileSync(new URL(`../../tests/fixtures/creator-payout-before-verification/${file}`, import.meta.url), 'utf8'),
]));
const marker = '?before-creator-verification';

registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    return context.parentURL?.endsWith(marker) && sources.has(result.url)
      ? {...result, url: result.url + marker}
      : result;
  },
  load(url, context, next) {
    const source = url.endsWith(marker) && sources.get(url.slice(0, -marker.length));
    return source ? {format: 'module', source, shortCircuit: true} : next(url, context);
  },
});

export async function oldPayoutUtils() {
  return import(new URL('../../src/server/api/ref/payoutUtils.js' + marker, import.meta.url).href);
}

export async function rollbackPayout(request) {
  const {default: handler} = await import(
    new URL('../../src/server/api/ref/updatePayments.js' + marker, import.meta.url).href
  );
  return runLegacyApiHandler({request, handler, methodOverride: 'POST'});
}

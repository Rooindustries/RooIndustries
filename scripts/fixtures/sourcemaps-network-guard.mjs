import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { inheritTestProcessGuard } from '../lib/test-target-safety.mjs';

if (!process.env.ROO_TEST_NETWORK_ORIGINS || !process.env.ROO_SOURCEMAPS_NETWORK_LOG) {
  throw new Error('Source-map checks require the local network guard and audit.');
}
inheritTestProcessGuard(import.meta.url);
const record = error => {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (cause.message?.startsWith('[test-target]')) {
      appendFileSync(process.env.ROO_SOURCEMAPS_NETWORK_LOG, 'BLOCK-node-transport\n');
      break;
    }
  }
  throw error;
};
const fetch = globalThis.fetch;
globalThis.fetch = (...args) => fetch(...args).catch(record);
const dispatcher = getGlobalDispatcher();
setGlobalDispatcher({ dispatch(...args) {
  try { return dispatcher.dispatch(...args); } catch (error) { return record(error); }
} });
for (const module of [http, https]) {
  const request = module.request;
  module.request = function (...args) {
    try { return request.apply(this, args); } catch (error) { return record(error); }
  };
}
syncBuiltinESMExports();

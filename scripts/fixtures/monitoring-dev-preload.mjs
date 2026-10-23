import { inheritTestProcessGuard } from '../lib/test-target-safety.mjs';

inheritTestProcessGuard(import.meta.url);
const wrap = fetch => (input, ...args) => String(input) === 'https://registry.npmjs.org/-/package/next/dist-tags'
  ? Promise.resolve(Response.json({ latest: '15.5.28', canary: '15.5.28' }))
  : fetch(input, ...args);
let fetch = wrap(globalThis.fetch);
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  get: () => fetch,
  set: replacement => { fetch = wrap(replacement); },
});

import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inheritTestProcessGuard } from '../lib/test-target-safety.mjs';

if (!process.env.ROO_NEXT_VERSION_FIXTURE_LOG) throw new Error('Next version fixture requires its audit log.');
inheritTestProcessGuard(import.meta.url);
const { version } = createRequire(import.meta.url)('next/package.json');
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (input === 'https://registry.npmjs.org/-/package/next/dist-tags' && init === undefined) {
    appendFileSync(process.env.ROO_NEXT_VERSION_FIXTURE_LOG, 'next-version\n');
    return Promise.resolve(new Response(JSON.stringify({ latest: version, canary: version }), {
      headers: { 'content-type': 'application/json' },
    }));
  }
  return fetch(input, init);
};

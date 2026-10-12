import { registerHooks } from 'node:module';

const fixtureURL = new URL('./creator-portal.mjs', import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/tests/fixtures/tooling-content.mjs')) return result;
    const anchor = '      evidence.requests.push(call);';
    const source = String(result.source);
    if (!source.includes(anchor)) throw new Error('Missing content fixture insertion point.');
    return {
      ...result,
      source: `import { portalHandle } from ${JSON.stringify(fixtureURL)};\n` + source.replace(anchor,
        anchor + '\n      if (await portalHandle({ req, res, url, body, documents, call, json, mutate, evidence })) { persist(); return; }'),
    };
  },
});

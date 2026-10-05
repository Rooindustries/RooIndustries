const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { inheritTestProcessGuard } from './lib/test-target-safety.mjs';

inheritTestProcessGuard(import.meta.url);

const allowed = value => {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && url.hostname === testHost && url.port && !url.username && !url.password, '[test-target] Request destination is outside the local fixture.');
};
const dispatcher = getGlobalDispatcher();
setGlobalDispatcher({ dispatch(options, handler) { allowed(options.origin); return dispatcher.dispatch(options, handler); } });
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  allowed(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const redirect = init?.redirect ?? (typeof input === 'object' ? input.redirect : undefined);
  return fetch(input, { ...init, redirect: redirect === 'manual' ? 'manual' : 'error', signal: init?.signal || AbortSignal.timeout(30000) });
};
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  const request = module.request;
  module.request = function (input, options, callback) {
    const settings = typeof input === 'object' && !(input instanceof URL) ? input : typeof options === 'object' ? options : {};
    assert.ok(!settings.socketPath && !settings.createConnection && (!settings.agent || settings.agent === module.globalAgent || settings.agent.constructor === module.Agent), '[test-target] Custom network transports are refused.');
    const destination = typeof input === 'string' || input instanceof URL ? new URL(input)
      : new URL(`${settings.protocol || protocol}//${settings.hostname || settings.host || 'localhost'}:${settings.port || 80}${settings.path || '/'}`);
    if (typeof input === 'string' || input instanceof URL) {
      if (settings.hostname || settings.host) destination.hostname = settings.hostname || settings.host;
      if (settings.port) destination.port = settings.port;
      if (settings.protocol) destination.protocol = settings.protocol;
    }
    allowed(destination);
    if (settings.agent && settings.agent !== module.globalAgent) {
      if (typeof input === 'object' && !(input instanceof URL)) input = { ...input, agent: module.globalAgent };
      else options = { ...settings, agent: module.globalAgent };
    }
    return request.call(this, input, options, callback);
  };
  module.get = function (...args) {
    const request = module.request(...args);
    request.end();
    return request;
  };
}
syncBuiltinESMExports();

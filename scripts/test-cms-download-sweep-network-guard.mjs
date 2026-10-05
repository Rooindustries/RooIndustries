import http from 'node:http';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { setGlobalDispatcher } from 'undici';

const refuse = () => { throw new Error('Network requests are forbidden during CMS/download compatibility checks'); };
setGlobalDispatcher({ dispatch: refuse });

const require = createRequire(import.meta.url);
const env = require('@next/env');
require.cache[require.resolve('@next/env')].exports = {
  ...env,
  loadEnvConfig: () => ({ combinedEnv: process.env, parsedEnv: {}, loadedEnvFiles: [] }),
};
globalThis.fetch = refuse;
http.request = refuse;
http.get = refuse;
https.request = refuse;
https.get = refuse;
syncBuiltinESMExports();

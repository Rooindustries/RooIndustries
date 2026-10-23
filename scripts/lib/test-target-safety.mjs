import net, { isIP } from "node:net";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

const connect = net.createConnection;
const isPrivateTestHost = value => {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (value === "::1") return true;
  if (isIP(value) !== 4) return false;
  const [a,b] = value.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
const isLocalHost = value => value === "localhost" || value === "[::1]" || isPrivateTestHost(value);
const fail = (message) => { throw new Error(`[test-target] ${message}`); };
const refuseSanityHost = hostname => {
  if (/(^|\.)(sanity\.io|apicdn\.sanity\.io|sanity\.studio)$/i.test(hostname.replace(/\.$/, ''))) fail("Sanity hosts are refused.");
};
const remoteBrowserEndpoint = () => {
  const value = process.env.PW_TEST_CONNECT_WS_ENDPOINT;
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { fail("Remote browser endpoint must be a local tunnel."); }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) {
    fail("Remote browser endpoint must be a local tunnel.");
  }
  return url;
};
const upgradeHeaders = (upgrade, connection) => upgrade.length === 1 && connection.length === 1 &&
  typeof upgrade[0] === "string" && upgrade[0].trim().toLowerCase() === "websocket" &&
  typeof connection[0] === "string" && connection[0].split(",").some(token => token.trim().toLowerCase() === "upgrade");
const framingHeaders = ["content-length", "transfer-encoding", "expect", "trailer"];
const tunnelRefusal = "[test-target] Remote browser requests must stay a websocket upgrade.";
const tunnelHeader = (header, pathname) => {
  if (typeof header !== "string" || !header.endsWith("\r\n\r\n")) return false;
  const [first, ...lines] = header.slice(0, -4).split("\r\n");
  const names = lines.map(line => /[\r\n]/.test(line) ? null : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?=:)/.exec(line)?.[0].toLowerCase() ?? null);
  const values = name => lines.filter((_, index) => names[index] === name).map(line => line.slice(line.indexOf(":") + 1));
  return first === `GET ${pathname} HTTP/1.1` && !names.includes(null) && !names.some(name => framingHeaders.includes(name)) &&
    upgradeHeaders(values("upgrade"), values("connection"));
};
const guardTunnelSocket = (socket, pathname) => {
  let phase = "handshake";
  const { _write: write, _writev: writev, _destroy: destroy } = socket;
  const send = (self, chunks, callback) => {
    const data = Buffer.concat(chunks.map(({ chunk, encoding }) => typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk));
    if (data.length !== 0) {
      if (phase !== "handshake" || !tunnelHeader(data.toString("latin1"), pathname)) {
        const error = new Error(tunnelRefusal);
        self.destroy(error);
        return callback(error);
      }
      phase = "sent";
    }
    return write.call(self, data, "buffer", callback);
  };
  Object.defineProperties(socket, {
    connect: { value() { throw new Error(tunnelRefusal); } },
    _destroy: { value(error, callback) { phase = "closed"; return destroy.call(this, error, callback); } },
    _write: { value(chunk, encoding, callback) { return phase === "open" ? write.call(this, chunk, encoding, callback) : send(this, [{ chunk, encoding }], callback); } },
    _writev: { value(chunks, callback) { return phase === "open" ? writev.call(this, chunks, callback) : send(this, chunks, callback); } },
  });
  return { socket, open: () => { if (phase === "sent") phase = "open"; } };
};
if (process.env.ROO_TEST_HOST && !isPrivateTestHost(process.env.ROO_TEST_HOST)) fail("ROO_TEST_HOST must be a private IP literal.");
const childGuardImports = new Set([import.meta.url]);
const childGuardOrigins = [];
const networkGuards = [];
const nonNodeBinaries = new Set(["postgres", "postgrest", "pg_ctl", "initdb", "psql", "pg_config", "git", "mkfifo", "tar", "gzip", "unzip", "python3", "chrome", "chromium", "google-chrome", "google-chrome-stable"]);

const originalInheritedOrigins = process.env.ROO_TEST_NETWORK_ORIGINS;
const serializeChildOrigins = () => JSON.stringify(childGuardOrigins.reduce((origins, allowed) => origins.filter(origin => allowed.includes(origin))));
const appendChildGuardOptions = value => {
  let nodeOptions = String(value ?? "");
  const tokens = [];
  let token = "", quoted = false;
  for (let index = 0; index < nodeOptions.length; index++) {
    const character = nodeOptions[index];
    if (character === "\\" && quoted && index + 1 < nodeOptions.length) token += nodeOptions[++index];
    else if (character === '"') quoted = !quoted;
    else if (!quoted && /\s/.test(character)) { if (token) tokens.push(token); token = ""; }
    else token += character;
  }
  if (token) tokens.push(token);
  for (const preload of childGuardImports) {
    const option = `--import=${JSON.stringify(preload)}`;
    if (!tokens.some((token, index) => token === `--import=${preload}` || token === "--import" && tokens[index + 1] === preload)) nodeOptions += `${nodeOptions ? " " : ""}${option}`;
  }
  return nodeOptions;
};
const refreshInheritedGuardEnvironment = () => {
  process.env.NODE_OPTIONS = appendChildGuardOptions(process.env.NODE_OPTIONS);
  if (childGuardOrigins.length) process.env.ROO_TEST_NETWORK_ORIGINS = serializeChildOrigins();
  else if (originalInheritedOrigins !== undefined) process.env.ROO_TEST_NETWORK_ORIGINS = originalInheritedOrigins;
  else delete process.env.ROO_TEST_NETWORK_ORIGINS;
};

export function inheritTestProcessGuard(preload) {
  childGuardImports.add(new URL(preload, import.meta.url).href);
  refreshInheritedGuardEnvironment();
}

const childOptions = (file, options, method) => {
  if (options != null && (typeof options !== "object" || Array.isArray(options))) return options;
  if (options?.rooTestNonNodeBinary === true) {
    if (method === "fork" || method === "exec" || method === "execSync" || options.shell || !nonNodeBinaries.has(path.basename(String(file)))) fail("Non-Node opt-out requires a direct known native binary.");
    const candidates = String(file).includes(path.sep) ? [path.resolve(options.cwd?.toString() || process.cwd(), String(file))]
      : String(options.env?.PATH ?? process.env.PATH ?? "").split(path.delimiter).map(directory => path.resolve(directory, String(file)));
    const selected = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
    if (!selected) fail("Non-Node opt-out binary is unavailable.");
    const binary = fs.realpathSync(selected);
    const stat = fs.statSync(binary), nodeStat = fs.statSync(process.execPath);
    if (!(nonNodeBinaries.has(path.basename(binary)) || /^python3\.\d+$/.test(path.basename(binary))) || stat.dev === nodeStat.dev && stat.ino === nodeStat.ino) fail("Node binaries cannot opt out of the guard.");
    const descriptor = fs.openSync(binary, "r");
    const magic = Buffer.alloc(4);
    try { fs.readSync(descriptor, magic, 0, magic.length, 0); } finally { fs.closeSync(descriptor); }
    if (!magic.equals(Buffer.from([127, 69, 76, 70]))) fail("Non-Node opt-out requires a native executable.");
    if (fs.readFileSync(binary).includes(Buffer.from("_ZN4node"))) fail("Node binaries cannot opt out of the guard.");
    return options;
  }
  const env = { ...(options?.env ?? process.env) };
  env.NODE_OPTIONS = appendChildGuardOptions(env.NODE_OPTIONS ?? process.env.NODE_OPTIONS);
  for (const name of ["ROO_TEST_HOST", "TOOLING_NETWORK_GUARD", "BASE_URL"]) {
    if (process.env[name] !== undefined && env[name] === undefined) env[name] = process.env[name];
  }
  if (env.ROO_TEST_HOST && !isPrivateTestHost(env.ROO_TEST_HOST)) fail("Child host must remain local to the fixture.");
  if (process.env.TOOLING_NETWORK_GUARD === "1") env.TOOLING_NETWORK_GUARD = "1";
  if (childGuardOrigins.length) env.ROO_TEST_NETWORK_ORIGINS = serializeChildOrigins();
  else if (process.env.ROO_TEST_NETWORK_ORIGINS !== undefined) env.ROO_TEST_NETWORK_ORIGINS = process.env.ROO_TEST_NETWORK_ORIGINS;
  return { ...options, env };
};

for (const method of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"]) {
  const original = childProcess[method];
  const guarded = function (...args) {
    let index;
    if (method === "exec" || method === "execSync") index = 1;
    else if (method === "fork") index = args[1] != null && typeof args[1] === "object" && !Array.isArray(args[1]) ? 1 : 2;
    else if (method === "spawn" || method === "spawnSync") index = Array.isArray(args[1]) ? 2 : 1;
    else index = args[1] != null && typeof args[1] === "object" && !Array.isArray(args[1]) || typeof args[1] === "function" ? 1 : 2;
    const options = childOptions(args[0], typeof args[index] === "function" ? undefined : args[index], method);
    if (typeof args[index] === "function") args.splice(index, 0, options);
    else args[index] = options;
    return Reflect.apply(original, this, args);
  };
  if (original[promisify.custom]) {
    Object.defineProperty(guarded, promisify.custom, { value: (...args) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = guarded(...args, (error, stdout, stderr) => {
          if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
          else resolve({ stdout, stderr });
        });
      });
      promise.child = child;
      return promise;
    } });
  }
  childProcess[method] = guarded;
}
syncBuiltinESMExports();
refreshInheritedGuardEnvironment();

export function localOrigin(value) {
  if (typeof value !== "string" || value !== value.trim()) fail("Explicit canonical local URL required.");
  let url;
  try { url = new URL(value); } catch { fail("Invalid local URL."); }
  refuseSanityHost(url.hostname);
  const authority = value.match(/^http:\/\/([^/]+)\/?$/)?.[1];
  if (url.protocol !== "http:" || !isLocalHost(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" || authority !== url.host) {
    fail("Only canonical literal local HTTP origins with an explicit port are allowed.");
  }
  return url.origin;
}

export function refuseEnvFiles(directory = process.cwd()) {
  if (fs.readdirSync(directory).some(name => name === ".env" || name.startsWith(".env."))) {
    fail("Remove local env files from the isolated test checkout before checking.");
  }
}

export { validateDistDir } from "../../next.config.mjs";

export function installNetworkGuard(origins) {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
    if (process.env[name] && process.env[name] !== "0") fail("Proxy transports are refused for local checks.");
  }
  const remoteBrowser = remoteBrowserEndpoint();
  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
  const loopbackAliases = origin => {
    const url = new URL(origin);
    return loopbackHosts.includes(url.hostname) ? loopbackHosts.map(host => `http://${host}:${url.port}`) : [origin];
  };
  const allowed = new Set(origins.map(localOrigin).flatMap(loopbackAliases));
  const inheritedOrigins = [...allowed];
  const guard = { active: true, restore: null };
  childGuardOrigins.push(inheritedOrigins);
  refreshInheritedGuardEnvironment();
  const check = value => {
    let url;
    try { url = new URL(value); } catch { fail("Invalid request URL."); }
    refuseSanityHost(url.hostname);
    if (!allowed.has(url.origin) || url.username || url.password) fail("Request destination is outside the local fixture.");
  };
  const originalFetch = globalThis.fetch;
  const originalDispatcher = getGlobalDispatcher();
  setGlobalDispatcher({ dispatch(options, handler) {
    if (guard.active) check(options.origin);
    return originalDispatcher.dispatch(options, handler);
  } });
  globalThis.fetch = async (input, init) => {
    if (!guard.active) return originalFetch(input, init);
    check(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const signals = [AbortSignal.timeout(30000), init?.signal || (typeof input === "object" ? input.signal : null)].filter(Boolean);
    const redirect = init?.redirect ?? (typeof input === "object" ? input.redirect : undefined);
    return originalFetch(input, { ...init, redirect: redirect === "manual" ? "manual" : "error", signal: AbortSignal.any(signals) });
  };
  const originals = [];
  for (const [module, protocol] of [[http, "http:"], [https, "https:"]]) {
    const request = module.request, get = module.get;
    originals.push(() => { module.request = request; module.get = get; });
    module.request = function(input, options, callback) {
      if (!guard.active) return request.call(this, input, options, callback);
      let tunnelSocket = null;
      const createConnection = ({ timeout } = {}) => {
        if (tunnelSocket) throw new Error(tunnelRefusal);
        tunnelSocket = guardTunnelSocket(connect({ host: "127.0.0.1", port: Number(remoteBrowser.port), timeout }), remoteBrowser.pathname);
        return tunnelSocket.socket;
      };
      const settings = typeof input === "object" && !(input instanceof URL) ? input : (typeof options === "object" ? options : {});
      const headers = settings.headers && typeof settings.headers === "object" && !Array.isArray(settings.headers) ? Object.entries(settings.headers) : null;
      const headerValues = name => headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
      const tunnel = module === http && remoteBrowser && settings === input && headers && !settings.socketPath && !settings.auth &&
        (settings.protocol || "http:") === "http:" && (settings.hostname || settings.host) === "127.0.0.1" &&
        String(settings.port) === remoteBrowser.port && settings.path === remoteBrowser.pathname &&
        String(settings.method || "GET").toUpperCase() === "GET" &&
        framingHeaders.every(name => headerValues(name).length === 0) && upgradeHeaders(headerValues("upgrade"), headerValues("connection"));
      if (tunnel) input = { ...input, agent: undefined, createConnection };
      else {
        if (settings.socketPath || settings.createConnection ||
            (settings.agent && settings.agent !== module.globalAgent && settings.agent.constructor !== module.Agent)) fail("Custom network transports are refused.");
        const destination = typeof input === "string" || input instanceof URL
          ? new URL(input) : new URL(`${settings.protocol || protocol}//${settings.hostname || settings.host || "localhost"}:${settings.port || (protocol === "http:" ? 80 : 443)}${settings.path || "/"}`);
        if (typeof input === "string" || input instanceof URL) {
          if (settings.hostname || settings.host) destination.hostname = settings.hostname || settings.host;
          if (settings.port) destination.port = settings.port;
          if (settings.protocol) destination.protocol = settings.protocol;
        }
        check(destination);
        if (settings.agent && settings.agent !== module.globalAgent) {
          if (typeof input === "object" && !(input instanceof URL)) input = { ...input, agent: module.globalAgent };
          else options = { ...settings, agent: module.globalAgent };
        }
      }
      const req = request.call(this, input, options, callback);
      if (tunnel && Object.getOwnPropertyDescriptor(req, "_send")?.configurable !== false) {
        Object.defineProperty(req, "shouldKeepAlive", { configurable: false, get: () => false, set() {} });
        const send = req._send;
        const refuse = () => {
          req.destroy(new Error(tunnelRefusal));
          return false;
        };
        Object.defineProperty(req, "_send", { configurable: false, writable: false, value(data, ...rest) {
          if (this.destroyed || (data != null && data.length !== 0) || !tunnelHeader(this._header, remoteBrowser.pathname)) return refuse();
          return send.call(this, data, ...rest);
        } });
        if (req._header !== null) refuse();
      }
      const emit = req.emit;
      req.emit = function(event, ...values) {
        if (tunnel && event === "upgrade" && values[0]?.statusCode === 101 && values[1] === tunnelSocket?.socket) tunnelSocket.open();
        if (event === "response" && values[0].statusCode >= 300 && values[0].statusCode < 400) {
          this.destroy(new Error("[test-target] HTTP redirects are refused."));
          values[0].destroy();
          return false;
        }
        return emit.call(this, event, ...values);
      };
      return req;
    };
    module.get = function(...args) { const req = module.request(...args); req.end(); return req; };
  }
  syncBuiltinESMExports();
  guard.restore = () => {
    globalThis.fetch = originalFetch;
    setGlobalDispatcher(originalDispatcher);
    originals.forEach(restore => restore());
  };
  networkGuards.push(guard);
  return () => {
    if (!guard.active) return;
    guard.active = false;
    childGuardOrigins.splice(childGuardOrigins.indexOf(inheritedOrigins), 1);
    refreshInheritedGuardEnvironment();
    while (networkGuards.length && !networkGuards.at(-1).active) networkGuards.pop().restore();
    syncBuiltinESMExports();
  };
}

export function prepareTestTarget({ browser = false } = {}) {
  refuseEnvFiles();
  if (!process.env.TEST_TARGET_FIXTURE) fail("TEST_TARGET_FIXTURE is required before any test I/O.");
  const fixture = JSON.parse(fs.readFileSync(process.env.TEST_TARGET_FIXTURE, "utf8"));
  const keys = new Set(["version", "runId", "baseUrl", "sanityApiUrl", "paypalApiUrl", "razorpayApiUrl"]);
  if (!fixture || fixture.version !== 1 || typeof fixture.runId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.runId) || fixture.runId.length > 48 ||
      Object.keys(fixture).some(key => !keys.has(key))) fail("Invalid fixture schema or run ownership.");
  const origins = [fixture.baseUrl, fixture.sanityApiUrl, fixture.paypalApiUrl, fixture.razorpayApiUrl].map(localOrigin);
  const token = `fixture-${fixture.runId}`;
  const dataset = `test-${fixture.runId}`;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/(?:TOKEN|SECRET|API_KEY|WRITE_KEY|DATABASE_URL)$/.test(name) && value !== token) fail(`Non-fixture credentials in ${name}.`);
    if (/(?:KEY_ID|CLIENT_ID|SERVICE_ROLE_KEY|SECRET_KEY|PUBLISHABLE_KEY|ANON_KEY)$/.test(name) && value !== token) fail(`Non-fixture credentials in ${name}.`);
    if (/^(?:NODE_ENV|VERCEL_ENV|NEXT_PUBLIC_VERCEL_ENV|REACT_APP_VERCEL_ENV)$/.test(name) && !["test", "development"].includes(value)) fail("Live runtime refused.");
    if (/ALLOW_LIVE|ENABLE_LIVE|LIVE_PAYMENTS/.test(name) && !["0", "false"].includes(value)) fail("Live payment overrides refused.");
    if (/^(?:NEXT_PUBLIC_)?PAYPAL_ENV$/.test(name) && value !== "sandbox") fail("Live PayPal mode refused.");
    if (name === "DODO_PAYMENTS_ENVIRONMENT" && value !== "test_mode") fail("Live Dodo mode refused.");
    if (/^(?:NEXT_PUBLIC_|REACT_APP_)?SANITY_DATASET$/.test(name) && value !== dataset) fail("Sanity dataset is not owned by this fixture.");
    if (/^(?:NEXT_PUBLIC_|REACT_APP_)?SANITY_PROJECT_ID$/.test(name) && value !== "toolingfixture") fail("Sanity project is not a fixture.");
    if (/(?:_URL|_API_BASE|_API_HOST)$/.test(name) && name !== "TEST_TARGET_FIXTURE") {
      if (!origins.includes(localOrigin(value))) fail(`Target mismatch in ${name}.`);
    }
  }
  if (process.env.IMPORT_CDP_COOKIES && process.env.IMPORT_CDP_COOKIES !== "0") fail("Shared browser cookie import is refused.");
  if (process.env.CDP_ENDPOINT || (process.env.PLAYWRIGHT_BROWSER_MODE && process.env.PLAYWRIGHT_BROWSER_MODE !== "launch")) fail("Shared CDP browser access is refused.");
  for (const name of ["FREE_BOOKING_RUN_ID", "PAID_BOOKING_RUN_ID"]) {
    if (process.env[name] && process.env[name] !== fixture.runId) fail("Browser run ownership mismatch.");
    process.env[name] = fixture.runId;
  }
  process.env.SANITY_PROJECT_ID = "toolingfixture";
  process.env.SANITY_DATASET = dataset;
  process.env.SANITY_WRITE_TOKEN = token;
  process.env.BASE_URL = fixture.baseUrl;
  process.env.PAYPAL_ENV = "sandbox";
  process.env.PAYPAL_API_BASE = fixture.paypalApiUrl;
  process.env.IMPORT_CDP_COOKIES = "0";
  process.env.PLAYWRIGHT_BROWSER_MODE = "launch";
  for (const name of ["TEST_USER_EMAIL", "FREE_BOOKING_EMAIL", "PAID_BOOKING_EMAIL"]) {
    if (process.env[name] && !/^[a-z0-9._+-]+@fixture\.invalid$/i.test(process.env[name])) fail("Only fixture email recipients are allowed.");
  }
  installNetworkGuard(origins);
  if (process.env.TEST_TARGET_VALIDATE_ONLY === "1") {
    console.log(JSON.stringify({ runId: fixture.runId, origins, browser: browser ? "fresh-context" : null }));
    process.exit(0);
  }
  return { ...fixture, dataset, token };
}

export async function guardBrowserContext(context, origins) {
  const allowed = new Set(origins.map(localOrigin));
  const api = context.request;
  const fetch = api.fetch;
  api.fetch = async function(input, options = {}) {
    if (options.url !== undefined || options.request !== undefined) fail("Custom request targets are refused.");
    const url = new URL(typeof input === "string" ? input : input.url(), origins[0]);
    if (!allowed.has(url.origin) || url.username || url.password) fail("Request destination is outside the local fixture.");
    const response = await fetch.call(this, typeof input === "string" ? url.href : input, { ...options, maxRedirects: 0 });
    if (response.status() >= 300 && response.status() < 400 && options.maxRedirects !== 0) {
      await response.dispose();
      fail("HTTP redirects are refused.");
    }
    return response;
  };
  const contentAssetOrigins = new Set([...allowed].map(origin => {
    const url = new URL(origin);
    url.port = process.env.TOOLING_CONTENT_PORT || String(Number(url.port) + 1);
    return url.origin;
  }));
  const evidence = { staticAssets: [], unexpectedRequests: [] };
  let closing = false;
  const close = context.close;
  context.close = function(...args) { closing = true; return close.apply(this, args); };
  context.once("close", () => { closing = true; });
  const navigationRedirects = new WeakMap();
  const navigationOperations = new WeakMap();
  const protectedFrames = new WeakSet();
  const wrapNavigation = (owner, method, frame) => {
    const original = owner[method];
    owner[method] = async function(...args) {
      const options = (method === "goto" ? args[1] : args[0]) || {};
      const operation = { options, redirect: null, started: Date.now() };
      if (!navigationOperations.has(frame)) navigationOperations.set(frame, new Set());
      const operations = navigationOperations.get(frame);
      operations.add(operation);
      try { return await original.apply(this, args); }
      catch (error) {
        if (!operation.redirect) throw error;
        const result = await operation.redirect;
        if (result.error) throw result.error;
        const timeout = options.timeout > 0 ? Math.max(1, options.timeout - (Date.now() - operation.started)) : options.timeout;
        if (options.url) await frame.waitForURL(options.url, { ...options, timeout });
        if (options.waitUntil !== "commit") await frame.waitForLoadState(options.waitUntil || "load", { timeout });
        return result.response;
      } finally { operations.delete(operation); }
    };
  };
  const protectFrame = frame => {
    if (protectedFrames.has(frame)) return;
    protectedFrames.add(frame);
    wrapNavigation(frame, "goto", frame);
    wrapNavigation(frame, "waitForNavigation", frame);
  };
  const protectPage = page => {
    for (const frame of page.frames()) protectFrame(frame);
    page.on("frameattached", protectFrame);
    for (const method of ["goBack", "goForward", "reload"]) wrapNavigation(page, method, page.mainFrame());
  };
  context.on("page", protectPage);
  for (const page of context.pages()) protectPage(page);
  const record = (kind, request, details = {}) => {
    const entry = { url: request.url(), method: request.method(), resourceType: request.resourceType(), action: kind, time: new Date().toISOString(), ...details };
    evidence[kind === "fulfilled-static-asset" ? "staticAssets" : "unexpectedRequests"].push(entry);
    if (process.env.ROO_BROWSER_GUARD_ARTIFACT) fs.appendFileSync(process.env.ROO_BROWSER_GUARD_ARTIFACT, JSON.stringify(entry) + "\n");
  };
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const permits = target => !target.username && !target.password && (allowed.has(target.origin) ||
      contentAssetOrigins.has(target.origin) && request.method() === "GET" && request.resourceType() === "image" && target.pathname.startsWith("/storage/v1/"));
    if (permits(url)) {
      let frame;
      if (request.isNavigationRequest()) {
        try { frame = request.frame(); }
        catch (error) {
          if (!String(error).includes("Frame for this navigation request is not available")) throw error;
        }
      }
      let response;
      try { response = await route.fetch({ maxRedirects: 0 }); }
      catch { if (frame) navigationRedirects.delete(frame); return route.abort("failed"); }
      try {
        const location = response.headers().location;
        if (response.status() < 300 || response.status() >= 400 || location === undefined) {
          if (frame) navigationRedirects.delete(frame);
          return await route.fulfill({ status: response.status(), body: await response.body(), headers: { "access-control-allow-origin": "", ...response.headers() } });
        }
        let target;
        try { target = new URL(location, url); } catch {}
        const previous = frame ? navigationRedirects.get(frame) : null;
        const count = previous?.url === url.href ? previous.count : 0;
        if (!target || !permits(target) || !frame || request.method() !== "GET" || count >= 20) {
          const action = !target ? "invalid-browser-redirect" : !permits(target) ? "unexpected-nonlocal-redirect" : "unexpected-browser-redirect";
          record(action, request, { url: target?.href || url.href, redirectedFrom: url.href, status: response.status() });
          if (frame) navigationRedirects.delete(frame);
          await route.abort("blockedbyclient");
          fail(`Browser redirect refused: ${request.method()} ${url.href}`);
        }
        navigationRedirects.set(frame, { url: target.href.split("#")[0], count: count + 1 });
        protectFrame(frame);
        let resolve;
        const redirect = new Promise(done => { resolve = done; });
        const operations = navigationOperations.get(frame);
        for (const operation of operations || []) if (!operation.redirect) operation.redirect = redirect;
        const operation = operations?.values().next().value;
        const options = operation?.options || {};
        const timeout = options.timeout > 0 ? Math.max(1, options.timeout - (Date.now() - operation.started)) : options.timeout;
        try {
          await route.abort("aborted");
          resolve({ response: await frame.goto(target.href, { waitUntil: "commit", timeout, referer: options.referer }) });
        }
        catch (error) { resolve({ error }); }
        return;
      } catch (error) {
        if (!closing || !String(error).includes("Response has been disposed")) throw error;
        return;
      } finally {
        try { await response.dispose(); }
        catch (error) {
          if (!closing || !String(error).includes("apiResponse.dispose: Target page, context or browser has been closed")) throw error;
        }
      }
    }
    if (request.url() === "https://razorpay.com/assets/razorpay-logo.svg" && request.method() === "GET" && request.resourceType() === "image") {
      record("fulfilled-static-asset", request);
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><rect width="1" height="1" fill="none"/></svg>' });
    }
    if (request.url() === "https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png" && request.method() === "GET" && request.resourceType() === "image") {
      record("fulfilled-static-asset", request);
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
    }
    record("unexpected-nonlocal-request", request);
    await route.abort("blockedbyclient");
    fail(`Unexpected nonlocal browser request: ${request.method()} ${request.url()}`);
  });
  await context.routeWebSocket(/.*/, socket => socket.close());
  return evidence;
}

export async function verifyFixtureOwnership(fixture) {
  const origins = [...new Set([fixture.baseUrl, fixture.sanityApiUrl, fixture.paypalApiUrl, fixture.razorpayApiUrl].map(localOrigin))];
  for (const origin of origins) {
    const response = await fetch(`${origin}/.well-known/roo-test-fixture`);
    const marker = await response.json().catch(() => null);
    if (response.status !== 200 || marker?.version !== 1 || marker.runId !== fixture.runId || marker.isolated !== true ||
        Object.keys(marker).some(key => !["version", "runId", "isolated", "origins"].includes(key)) ||
        !Array.isArray(marker.origins) || marker.origins.length !== origins.length ||
        marker.origins.some(value => !origins.includes(value)) || new Set(marker.origins).size !== origins.length) {
      fail("Local service does not attest ownership of this isolated fixture run.");
    }
  }
}

if (process.env.TOOLING_NETWORK_GUARD === "1" || process.env.ROO_TEST_NETWORK_ORIGINS) {
  refuseEnvFiles();
  installNetworkGuard(process.env.ROO_TEST_NETWORK_ORIGINS ? JSON.parse(process.env.ROO_TEST_NETWORK_ORIGINS) : [process.env.BASE_URL]);
}

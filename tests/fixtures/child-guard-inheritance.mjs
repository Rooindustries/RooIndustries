#!/usr/bin/env node
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const file = fileURLToPath(import.meta.url);
const targets = ['https://outside.fixture.invalid', 'http://192.0.2.1:45991'];
if (!process.argv.includes('--parent')) {
  const local = await fetch(process.env.BASE_URL || process.env.CHILD_FIXTURE_URL);
  assert.equal(local.status, 200);
  await local.body.cancel();
  let socketCalls = 0, dnsCalls = 0;
  net.Socket.prototype.connect = function () { socketCalls++; throw new Error('SOCKET_SENTINEL'); };
  dns.lookup = function () { dnsCalls++; throw new Error('DNS_SENTINEL'); };
  syncBuiltinESMExports();
  const { request } = await import('undici');
  const attempts = [];
  for (const target of targets) for (const transport of ['fetch', 'http', 'undici', 'http-options']) {
    try {
      if (transport === 'fetch') await fetch(target, { signal: AbortSignal.timeout(1000) });
      else if (transport === 'undici') await request(target, { headersTimeout: 1000 });
      else await new Promise((resolve, reject) => {
        const req = transport === 'http-options'
          ? http.get(process.env.BASE_URL || process.env.CHILD_FIXTURE_URL, { hostname: new URL(target).hostname, port: new URL(target).port || 443 }, resolve)
          : (target.startsWith('https:') ? https : http).get(target, resolve);
        req.once('error', reject);
      });
      attempts.push({ target, transport, refused: false });
    } catch (error) {
      attempts.push({ target, transport, refused: true, message: error.message, cause: error.cause?.message });
    }
  }
  const proof = {
    node: process.version, env: Object.fromEntries(['NODE_OPTIONS', 'ROO_TEST_HOST', 'TOOLING_NETWORK_GUARD', 'BASE_URL'].map(key => [key, process.env[key] ?? null])),
    socketCalls, dnsCalls, attempts, localStatus: local.status,
  };
  if (process.argv.includes('--grandchild')) {
    const child = childProcess.spawnSync(process.execPath, [file], { env: { PATH: process.env.PATH, CHILD_FIXTURE_URL: process.env.CHILD_FIXTURE_URL }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    proof.grandchild = JSON.parse(child.stdout);
  }
  process.stdout.write(JSON.stringify(proof) + '\n');
  if (process.send) process.send(proof);
} else {
  const env = { PATH: process.env.PATH, CHILD_FIXTURE_URL: process.env.BASE_URL, NODE_OPTIONS: '--no-warnings', FIXTURE_UNRELATED: 'preserved' };
  const options = { env, encoding: 'utf8', timeout: 10000 };
  const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `${quoted(process.execPath)} ${quoted(file)}`;
  const wait = child => new Promise((resolve, reject) => {
    let stdout = '', stderr = ''; const messages = [];
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('message', message => { messages.push(message); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ stdout, stderr, messages }) : reject(new Error(`Child exit ${code}: ${stderr}`)));
  });
  const callback = fn => new Promise((resolve, reject) => fn((error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  const cases = [
    ['spawn-explicit-minimal-env', () => wait(childProcess.spawn(process.execPath, [file, '--grandchild'], { env: { PATH: process.env.PATH, CHILD_FIXTURE_URL: process.env.BASE_URL }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }))],
    ['spawnSync', () => childProcess.spawnSync(process.execPath, [file], options)],
    ['fork-explicit-minimal-env', () => wait(childProcess.fork(file, [], { env: { PATH: process.env.PATH, CHILD_FIXTURE_URL: process.env.BASE_URL }, execArgv: [], silent: true, timeout: 10000 }))],
    ['fork-options-overload', () => wait(childProcess.fork(file, { ...options, execArgv: [], silent: true }))],
    ['exec', () => callback(cb => childProcess.exec(command, options, cb))],
    ['execSync', () => ({ stdout: childProcess.execSync(command, options) })],
    ['execFile', () => callback(cb => childProcess.execFile(process.execPath, [file], options, cb))],
    ['execFileSync', () => ({ stdout: childProcess.execFileSync(process.execPath, [file], options) })],
    ['execFile-options-overload', () => callback(cb => childProcess.execFile(file, options, cb))],
    ['execFileSync-options-overload', () => ({ stdout: childProcess.execFileSync(file, options) })],
    ['spawn-options-overload', () => wait(childProcess.spawn(file, options))],
    ['spawnSync-options-overload', () => childProcess.spawnSync(file, options)],
    ['fork-null-args', () => wait(childProcess.fork(file, null, { ...options, execArgv: [], silent: true }))],
    ['exec-callback-default-env', () => callback(cb => childProcess.exec(command, cb))],
    ['execFile-callback-default-env', () => callback(cb => childProcess.execFile(file, cb))],
    ['execFile-args-callback-default-env', () => callback(cb => childProcess.execFile(process.execPath, [file], cb))],
    ['execFileSync-null-args', () => ({ stdout: childProcess.execFileSync(file, null, options) })],
    ['spawnSync-null-env-default-env', () => childProcess.spawnSync(process.execPath, [file], { env: null, encoding: 'utf8', timeout: 10000 })],
    ['captured-cjs-execSync-default-env', () => ({ stdout: globalThis.rooEarlyChildMethods.execSync(command, { encoding: 'utf8', timeout: 10000 }) })],
    ['captured-cjs-execFileSync-default-env', () => ({ stdout: globalThis.rooEarlyChildMethods.execFileSync(process.execPath, [file], { env: { ...process.env }, encoding: 'utf8', timeout: 10000 }) })],
    ['promisified-exec', () => { const promise = promisify(childProcess.exec)(command, options); assert.ok(promise.child?.pid); return promise; }],
    ['promisified-execFile', () => { const promise = promisify(childProcess.execFile)(process.execPath, [file], options); assert.ok(promise.child?.pid); return promise; }],
    ['import-text-in-title', () => childProcess.spawnSync(process.execPath, [file], { ...options, env: { ...env, NODE_OPTIONS: '--no-warnings ' + ['../../scripts/lib/test-target-safety.mjs', '../../scripts/test-payment-persistence-sweep-network-guard.mjs'].map(relative => `--title=--import=${JSON.stringify(new URL(relative, import.meta.url).href)}`).join(' ') } })],
  ];
  const rows = [];
  for (const [name, execute] of cases) {
    let proof;
    try {
      const result = await execute();
      assert.equal(result.status ?? 0, 0, result.stderr);
      proof = JSON.parse(result.stdout);
      for (const child of [proof, proof.grandchild].filter(Boolean)) {
        assert.equal(child.socketCalls, 0, JSON.stringify(child));
        assert.equal(child.dnsCalls, 0, JSON.stringify(child));
        assert.equal(child.env.ROO_TEST_HOST, process.env.ROO_TEST_HOST);
        assert.equal(child.env.BASE_URL, process.env.BASE_URL);
        assert.equal(child.env.TOOLING_NETWORK_GUARD, process.env.TOOLING_NETWORK_GUARD ?? null);
        assert.ok(child.env.NODE_OPTIONS?.includes('--import'), JSON.stringify(child));
        assert.equal(child.localStatus, 200);
        assert.equal(child.attempts.length, 8);
        assert.ok(child.attempts.every(attempt => attempt.refused && ![attempt.message, attempt.cause].some(text => /SENTINEL/.test(text || ''))), JSON.stringify(child));
      }
      if (!name.includes('minimal-env') && !name.includes('default-env')) assert.ok(proof.env.NODE_OPTIONS.includes('--no-warnings'));
      if (name.startsWith('fork')) { assert.equal(result.messages?.length, 1); assert.deepEqual(result.messages[0], proof); }
      rows.push({ name, passed: true, proof });
    } catch (error) { rows.push({ name, passed: false, error: error.message, proof }); }
  }
  for (const [name, args] of [['next', ['node_modules/next/dist/bin/next', '--version']], ['playwright', ['node_modules/@playwright/test/cli.js', '--version']]]) {
    const result = childProcess.spawnSync(process.execPath, args, options);
    rows.push({ name: `${name}-node-child`, passed: result.status === 0, stdout: result.stdout, stderr: result.stderr, status: result.status });
  }
  const safety = await import('../../scripts/lib/test-target-safety.mjs');
  const other = new URL(process.env.BASE_URL); other.port = String(Number(other.port) === 65535 ? 65534 : Number(other.port) + 1);
  const restoreFirst = safety.installNetworkGuard([process.env.BASE_URL]);
  const restoreSecond = safety.installNetworkGuard([other.origin]);
  try {
    await assert.rejects(fetch(other.origin), /test-target/);
    const program = `let socketCalls=0;require('node:net').Socket.prototype.connect=function(){socketCalls++;throw Error('SOCKET_SENTINEL')};fetch(process.env.CHILD_TARGET_URL).then(()=>console.log(JSON.stringify({refused:false,socketCalls}))).catch(error=>console.log(JSON.stringify({refused:true,socketCalls,error:error.message,cause:error.cause?.message})));`;
    const result = childProcess.spawnSync(process.execPath, ['-e', program], { env: { PATH: process.env.PATH, CHILD_TARGET_URL: other.origin }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); const proof = JSON.parse(result.stdout);
    assert.equal(proof.socketCalls, 0, JSON.stringify(proof)); assert.equal(proof.refused, true); assert.match(proof.error, /test-target/);
    rows.push({ name: 'nested-origin-guards-remain-intersected', passed: true, proof });
  } catch (error) { rows.push({ name: 'nested-origin-guards-remain-intersected', passed: false, error: error.message }); }
  finally { restoreSecond(); restoreFirst(); }
  const require = createRequire(import.meta.url);
  const { Worker } = require('next/dist/compiled/jest-worker');
  const workerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roo-child-next-worker-')), 'worker.cjs');
  fs.writeFileSync(workerFile, `exports.probe=async()=>{let socketCalls=0;require('node:net').Socket.prototype.connect=function(){socketCalls++;throw Error('SOCKET_SENTINEL')};let error;try{await fetch('https://outside.fixture.invalid')}catch(failure){error=failure.message}return{env:Object.fromEntries(['NODE_OPTIONS','BASE_URL','ROO_TEST_HOST'].map(key=>[key,process.env[key]])),socketCalls,error}};`);
  const worker = new Worker(workerFile, { numWorkers: 1, maxRetries: 0, forkOptions: { env: { PATH: process.env.PATH, NODE_OPTIONS: '--no-warnings' } } });
  try {
    const proof = await worker.probe(); assert.equal(proof.socketCalls, 0); assert.match(proof.error, /test-target/); assert.ok(proof.env.NODE_OPTIONS.includes('--import')); assert.equal(proof.env.BASE_URL, process.env.BASE_URL);
    rows.push({ name: 'actual-next-worker-child', passed: true, proof });
  } catch (error) { rows.push({ name: 'actual-next-worker-child', passed: false, error: error.message }); }
  finally { await worker.end(); }
  let driver;
  try {
    const { start } = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/outofprocess.js'));
    driver = await start({ NODE_OPTIONS: '--no-warnings' });
    const driverProcess = driver.playwright.driverProcess;
    const entries = fs.readFileSync(`/proc/${driverProcess.pid}/environ`, 'utf8').split('\0').map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]);
    const proof = { pid: driverProcess.pid, env: Object.fromEntries(entries.filter(([key]) => ['NODE_OPTIONS', 'ROO_TEST_HOST', 'BASE_URL'].includes(key))), browserTypes: ['chromium', 'firefox', 'webkit'].map(type => driver.playwright[type].name()) };
    assert.ok(proof.env.NODE_OPTIONS.includes('--import')); assert.equal(proof.env.BASE_URL, process.env.BASE_URL); assert.equal(proof.env.ROO_TEST_HOST, process.env.ROO_TEST_HOST);
    rows.push({ name: 'actual-playwright-driver-child', passed: true, proof });
  } catch (error) { rows.push({ name: 'actual-playwright-driver-child', passed: false, error: error.message }); }
  finally { if (driver) await driver.stop(); }
  const explicit = { PATH: process.env.PATH, FIXTURE_UNRELATED: 'native' };
  const native = childProcess.spawnSync('/usr/bin/python3', ['-c', "import os,json;print(json.dumps(dict(os.environ)))"], { env: explicit, rooTestNonNodeBinary: true, encoding: 'utf8' });
  try { assert.equal(native.status, 0, native.stderr); const proof = JSON.parse(native.stdout); assert.equal(proof.NODE_OPTIONS, undefined); assert.equal(proof.ROO_TEST_HOST, undefined); assert.equal(proof.FIXTURE_UNRELATED, 'native'); rows.push({ name: 'native-opt-out', passed: true, proof }); }
  catch (error) { rows.push({ name: 'native-opt-out', passed: false, error: error.message }); }
  for (const [name, execute] of [
    ['node-opt-out-refused', () => childProcess.spawnSync(process.execPath, ['--version'], { env: explicit, rooTestNonNodeBinary: true })],
    ['shell-opt-out-refused', () => childProcess.execSync(command, { env: explicit, rooTestNonNodeBinary: true })],
  ]) {
    try { assert.throws(execute, /test-target/); rows.push({ name, passed: true }); }
    catch (error) { rows.push({ name, passed: false, error: error.message }); }
  }
  try { assert.throws(() => childProcess.spawnSync(process.execPath, ['--version'], []), { code: 'ERR_INVALID_ARG_TYPE' }); rows.push({ name: 'invalid-options-array-refused', passed: true }); }
  catch (error) { rows.push({ name: 'invalid-options-array-refused', passed: false, error: error.message }); }
  try {
    const controller = new AbortController(); const failures = [];
    const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, signal: controller.signal, stdio: 'ignore' });
    child.on('error', error => failures.push(error.code));
    const closed = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    controller.abort(); const proof = { ...await closed, failures, pid: child.pid };
    assert.equal(proof.signal, 'SIGTERM'); assert.deepEqual(failures, ['ABORT_ERR']); rows.push({ name: 'abort-signal-preserved', passed: true, proof });
  } catch (error) { rows.push({ name: 'abort-signal-preserved', passed: false, error: error.message }); }
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roo-child-opt-out-')), 'python3');
  fs.symlinkSync(process.execPath, alias);
  for (const [name, execute] of [
    ['node-symlink-opt-out-refused', () => childProcess.spawnSync(alias, ['--version'], { env: explicit, rooTestNonNodeBinary: true })],
    ['nonlocal-host-override-refused', () => childProcess.spawnSync(process.execPath, ['--version'], { env: { ...explicit, ROO_TEST_HOST: '192.0.2.1' } })],
  ]) {
    try { assert.throws(execute, /test-target/); rows.push({ name, passed: true }); }
    catch (error) { rows.push({ name, passed: false, error: error.message }); }
  }
  const alternateNode = ['/home/serviroo/.hermes/node/bin/node', '/home/serviroo/.nvm/versions/node/v22.22.0/bin/node'].find(binary => fs.existsSync(binary) && fs.realpathSync(binary) !== fs.realpathSync(process.execPath));
  if (alternateNode) {
    const alternateAlias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roo-child-alternate-node-')), 'python3');
    try { fs.linkSync(alternateNode, alternateAlias); } catch (error) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(alternateNode, alternateAlias); }
    try { assert.throws(() => childProcess.spawnSync(alternateAlias, ['--version'], { env: explicit, rooTestNonNodeBinary: true }), /test-target/); rows.push({ name: 'alternate-node-alias-opt-out-refused', passed: true, binary: alternateNode }); }
    catch (error) { rows.push({ name: 'alternate-node-alias-opt-out-refused', passed: false, error: error.message, binary: alternateNode }); }
  }
  process.stdout.write(JSON.stringify({ passed: rows.every(row => row.passed), rows }) + '\n');
  if (rows.some(row => !row.passed)) process.exitCode = 1;
}

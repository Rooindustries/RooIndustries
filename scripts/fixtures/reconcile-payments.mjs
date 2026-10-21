import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = process.env.ROO_TEST_HOST || '127.0.0.1';
assert.match(host, /^(127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/);
const artifactDir = path.resolve(process.env.ROO_RECONCILE_TEST_ARTIFACT || 'test-results/roo-498/daily-bridge');
fs.mkdirSync(artifactDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'roo-reconcile-e2e-'));
fs.chmodSync(scratch, 0o700);
const actualCurl = execFileSync('which', ['curl'], { encoding: 'utf8' }).trim();
const baseline = process.env.ROO_RECONCILE_BASELINE_SCRIPT;
const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7).split(',');
const scope = {
  parentId: 'd5c5564e-7966-4c7a-b360-d193ee81296c',
  projectId: 'edd95e95-8bc5-473c-a116-dc5646d79a87',
  teamId: '9c69fa12-a33b-4072-99e8-a53f6f378104',
};
const issueFields = ['id', 'uuid', 'description', 'projectId', 'teamId', 'parentId', 'status', 'statusType', 'archivedAt', 'createdAt', 'updatedAt', 'url'];
const truncationMarker = '… (truncated, use `get_issue` for full description)';
const responseDescription = (description) => typeof description === 'string'
  ? description.replace(/(^|\s)(https?:\/\/\S+)/g, (_, prefix, url) => prefix + '[' + url + '](<' + url + '>)')
  : description;
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
const token = crypto.randomBytes(24).toString('hex');
const sourceHashes = Object.fromEntries([
  'scripts/reconcile-payments.sh', 'scripts/lib/reconcile-linear.jq',
  'scripts/test-reconcile-payments.sh', 'scripts/fixtures/reconcile-payments.mjs',
  'docs/payment-reconciliation.md', 'package.json', '.github/workflows/tests.yml',
].filter((name) => fs.existsSync(path.join(root, name))).map((name) => [
  name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
]));
const results = [];
const children = new Set();
let origin, current;
const iso = () => new Date().toISOString();
const envelope = (body) => ({ ok: true, data: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
const item = (key, reason = 'payment_without_booking', ref = 'record.fixture') => ({
  key, id: key.slice(key.indexOf(':') + 1), ref, amount: '9.99', currency: 'USD', reason,
});
const windowReport = (items = [], complete = {}) => {
  const at = Date.now();
  return {
    ok: true, at: new Date(at).toISOString(),
    from: new Date(at - 72 * 3600000).toISOString(), to: new Date(at - 1800000).toISOString(),
    mode: 'window', checks: [],
    complete: { payments: true, bookings: true, records: true, items: items.length <= 50, ...complete },
    count: items.length, items: items.slice(0, 50),
  };
};
const check = (key, state = 'unknown', observations = [], aliases = [key]) => ({
  key, state, keys: [...new Set([key, ...aliases])], items: observations,
});
const recovered = (key, id = 'fixture') => check(key, 'recovered', [], [
  'payment:' + id, 'record:record.' + id, 'booking:booking.' + id,
]);
const freshState = () => ({
  issues: [], comments: [], updates: [], calls: [], requests: [], runs: [], checks: {},
  window: windowReport(), pageSize: 100, failures: [], date: today,
  reportedCount: null, scopeFault: null, duplicateCursor: false, gate: null,
  issueResponses: [], updateResponses: [], identityBefore: null,
  minimalCreateResponse: false, omitDefaultChildParent: false, canonicalChildFault: null, workflowRaces: [],
  captureIdentity: false, registryFault: null, listPages: [],
});
const managedDescription = (key) =>
  '**Goal**: Resolve this payment, booking or referral-credit mismatch.\n\n' +
  '**Done when**: The read-only payment audit confirms this entity is consistent.\n\n' +
  '**Evidence**: Current evidence lives in the reconciliation status comment.\n\n' +
  'Reconciliation key: ' + key + '\n\n' +
  '**Constraints**: Keep payment and booking data unchanged.\n\nSession: RooIndustries payment reconciliation';
const seedIssue = (key, extra = {}, metaExtra = {}) => {
  const uuid = crypto.randomUUID();
  const number = current.issues.length + 9001;
  const createdAt = '2026-01-01T00:00:00.000Z';
  const issue = {
    id: 'ROO-' + number, uuid, ...scope, description: managedDescription(key),
    status: 'Backlog', statusType: 'backlog', archivedAt: null, createdAt, updatedAt: createdAt,
    url: 'https://linear.app/rooindustries/issue/ROO-' + number, ...extra,
  };
  current.issues.push(issue);
  const metadata = {
    version: 1, issueId: uuid, primary: key, keys: [key], firstSeen: createdAt, lastSeen: createdAt,
    lastCheckedAt: createdAt, state: 'unresolved', run: today, observations: [], ...metaExtra,
  };
  current.comments.push({
    id: crypto.randomUUID(), issueId: uuid,
    body: 'Payment reconciliation status\nReconciliation: ' + JSON.stringify(metadata),
    createdAt, updatedAt: createdAt, author: { name: 'Fixture operator' }, attachments: [],
    onBehalfOf: null, parentId: null, quotedText: null, resolvedAt: null,
  });
  return issue;
};
const page = (rows, args, field) => {
  const start = args.cursor ? rows.findIndex((row) => (row.uuid || row.id) === args.cursor) + 1 : 0;
  const entries = rows.slice(start, start + Math.min(args.limit, current.pageSize));
  const hasNextPage = start + entries.length < rows.length;
  return {
    [field]: entries, hasNextPage,
    ...(hasNextPage ? { cursor: current.duplicateCursor && args.cursor ? args.cursor : entries.at(-1).uuid || entries.at(-1).id } : {}),
  };
};
const failureFor = (method, args) => current.failures.find((failure) =>
  !failure.used && failure.method === method && (!failure.when || failure.when(args)));
const issueResponse = (issue, method, args) => {
  let dto = { ...structuredClone(issue), description: responseDescription(issue.description) };
  if (method === 'list_issues') {
    if (typeof dto.description === 'string' && dto.description.length > 500) dto.description = dto.description.slice(0, 449) + truncationMarker;
    const field = { project: 'projectId', team: 'teamId', child: 'parentId' }[current.scopeFault];
    if (field) dto[field] = '00000000-0000-4000-8000-000000000000';
  } else if (method === 'get_issue') {
    if (current.canonicalChildFault?.id === issue.uuid && current.canonicalChildFault.kind === 'scope') {
      dto.parentId = '00000000-0000-4000-8000-000000000000';
    }
    if (Object.hasOwn(args, 'fields')) {
      assert.deepEqual(Object.keys(args).sort(), ['fields', 'id']);
      assert.deepEqual(args.fields, issueFields);
      dto = Object.fromEntries(args.fields.map((field) => [field, dto[field] ?? null]));
    } else if (current.omitDefaultChildParent) delete dto.parentId;
  } else if (!args.id && current.minimalCreateResponse) dto = { uuid: issue.uuid };
  current.issueResponses.push({
    method, args: structuredClone(args), uuid: issue.uuid, authoredDescription: issue.description,
    dto: structuredClone(dto), callIndex: current.calls.length - 1, reportRequests: current.requests.length,
  });
  return dto;
};
const updateResponse = (update, method, args) => {
  const dto = { ...structuredClone(update), body: responseDescription(update.body) };
  current.updateResponses.push({
    method, args: structuredClone(args), id: update.id, authoredBody: update.body,
    dto: structuredClone(dto), callIndex: current.calls.length - 1, reportRequests: current.requests.length,
  });
  return dto;
};
const linear = async (method, args) => {
  current.calls.push({ method, args: structuredClone(args) });
  if (method === 'get_issue' && current.beforeIssueRead) current.beforeIssueRead(args);
  if (method === 'list_issues' && current.beforeIssueList) current.beforeIssueList(args);
  if (method === 'get_issue' && args.id === 'ROO-498' && current.gate) {
    const gate = current.gate;
    current.gate = null;
    gate.enter();
    await gate.release;
  }
  const failure = failureFor(method, args);
  if (failure && !failure.commit) {
    failure.used = true;
    return { status: failure.status || 503, body: failure.body || { ok: false } };
  }
  let result;
  if (method === 'get_issue') {
    result = args.id === 'ROO-498'
      ? { id: 'ROO-498', uuid: scope.parentId, projectId: scope.projectId, teamId: scope.teamId }
      : current.issues.find((issue) => issue.uuid === args.id || issue.id === args.id);
    if (args.id !== 'ROO-498' && result) {
      if (current.canonicalChildFault?.id === result.uuid && current.canonicalChildFault.kind === 'missing') {
        current.issueResponses.push({ method, args: structuredClone(args), uuid: result.uuid,
          status: 404, callIndex: current.calls.length - 1, reportRequests: current.requests.length });
        return { status: 404, body: { ok: false } };
      }
      result = issueResponse(result, method, args);
    }
    if (current.scopeFault === 'parent' && args.id === 'ROO-498') result = { ...result, uuid: crypto.randomUUID() };
    if (current.scopeFault === 'root-team' && args.id === 'ROO-498') result = { ...result, teamId: crypto.randomUUID() };
  } else if (method === 'list_issues') {
    assert.equal(args.parentId, scope.parentId);
    assert.equal(args.project, scope.projectId);
    assert.equal(args.team, scope.teamId);
    assert.equal(args.includeArchived, true);
    assert.equal(args.limit, 100);
    assert.deepEqual(args.fields, issueFields);
    result = page(current.issues.filter((issue) =>
      issue.parentId === args.parentId && issue.projectId === args.project && issue.teamId === args.team), args, 'issues');
    result.issues = result.issues.map((issue) => issueResponse(issue, method, args));
  } else if (method === 'list_comments') {
    assert.ok(current.issues.some((issue) => issue.uuid === args.issueId));
    assert.equal(args.limit, 100);
    assert.equal(args.orderBy, 'updatedAt');
    result = page(current.comments.filter((comment) => comment.issueId === args.issueId), args, 'comments');
  } else if (method === 'get_status_updates') {
    assert.equal(args.type, 'project');
    assert.equal(args.project, scope.projectId);
    assert.equal(args.orderBy, 'createdAt');
    assert.equal(args.createdAt, current.date + 'T00:00:00Z');
    result = page(current.updates.filter((update) => update.createdAt.slice(0, 10) >= current.date), args, 'statusUpdates');
    result.statusUpdates = result.statusUpdates.map((update) => updateResponse(update, method, args));
  } else if (method === 'save_issue') {
    assert.equal(Object.hasOwn(args, 'labels'), false);
    if (args.id) {
      assert.deepEqual(Object.keys(args).sort(), ['id', 'state']);
      result = current.issues.find((issue) => issue.uuid === args.id);
      assert.ok(result);
      result.status = args.state;
      result.statusType = args.state === 'Done' ? 'completed' : 'backlog';
      result.updatedAt = iso();
    } else {
      assert.equal(args.project, scope.projectId);
      assert.equal(args.team, scope.teamId);
      assert.equal(args.parentId, scope.parentId);
      assert.equal(args.state, 'Backlog');
      assert.equal(args.assignee, 'me');
      assert.equal(args.priority, 1);
      assert.ok(args.description.includes('Reconciliation key: '));
      result = {
        id: 'ROO-' + (9001 + current.issues.length), uuid: crypto.randomUUID(), ...scope,
        description: args.description, status: 'Backlog', statusType: 'backlog',
        archivedAt: null, createdAt: iso(), updatedAt: iso(),
      };
      result.url = 'https://linear.app/rooindustries/issue/' + result.id;
      current.issues.push(result);
    }
    result = issueResponse(result, method, args);
  } else if (method === 'save_comment') {
    if (args.id) {
      assert.deepEqual(Object.keys(args).sort(), ['body', 'id']);
      result = current.comments.find((comment) => comment.id === args.id);
      assert.ok(result);
      assert.ok(result.body.startsWith('Payment reconciliation status\n'));
      result.body = args.body;
      result.updatedAt = iso();
    } else {
      assert.deepEqual(Object.keys(args).sort(), ['body', 'issueId']);
      assert.ok(current.issues.some((issue) => issue.uuid === args.issueId));
      result = {
        id: crypto.randomUUID(), issueId: args.issueId, body: args.body,
        createdAt: iso(), updatedAt: iso(), author: { name: 'Fixture operator' },
        attachments: [], quotedText: null, parentId: null, onBehalfOf: null, resolvedAt: null,
      };
      current.comments.push(result);
    }
  } else if (method === 'save_status_update') {
    assert.equal(args.type, 'project');
    assert.ok(Object.keys(args).every((key) =>
      ['body', 'health', 'id', 'initiative', 'isDiffHidden', 'project', 'type'].includes(key)));
    assert.equal(Object.hasOwn(args, 'health'), false);
    if (args.id) {
      assert.deepEqual(Object.keys(args).sort(), ['body', 'id', 'type']);
      result = current.updates.find((update) => update.id === args.id);
      assert.ok(result);
      result.body = args.body;
      result.updatedAt = iso();
    } else {
      assert.deepEqual(Object.keys(args).sort(), ['body', 'project', 'type']);
      assert.equal(args.project, scope.projectId);
      result = {
        id: crypto.randomUUID(), type: 'project', project: { id: scope.projectId },
        body: args.body, createdAt: current.date + 'T12:00:00.000Z', updatedAt: iso(),
      };
      result.url = 'https://linear.app/rooindustries/project/roo-website/activity#project-update-' + result.id;
      current.updates.push(result);
    }
    result = updateResponse(result, method, args);
  } else throw new Error('Unsupported fixture method');
  if (failure) {
    failure.used = true;
    return { status: failure.status || 503, body: failure.body || { ok: false } };
  }
  return { status: 200, body: envelope(result || {}) };
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/payment/report') {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      const keys = url.searchParams.has('check') ? JSON.parse(url.searchParams.get('check')) : null;
      current.requests.push({ method: req.method, path: url.pathname, checks: keys });
      if (keys) {
        const outcomes = keys.map((key) => current.checks[key] || check(key));
        const items = [...new Map(outcomes.flatMap((outcome) => outcome.items).map((entry) => [JSON.stringify(entry), entry])).values()];
        const body = {
          ...windowReport(), mode: 'checks', checks: outcomes,
          complete: { payments: false, bookings: false, records: false, items: items.length <= 50 },
          count: items.length, items: items.slice(0, 50),
        };
        const failure = failureFor('checks', { keys });
        if (failure) {
          failure.used = true;
          res.writeHead(failure.status || 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify(failure.body || {}));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } else {
        const body = typeof current.window === 'function' ? current.window() : current.window;
        if (current.reportedCount !== null) body.count = current.reportedCount;
        res.writeHead(current.sourceStatus || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }
      return;
    }
    assert.ok(url.pathname.startsWith('/linear/'));
    assert.equal(req.method, 'POST');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const args = JSON.parse(Buffer.concat(chunks).toString());
    const response = await linear(url.pathname.slice(8), args);
    if (url.pathname === '/linear/list_issues') current.listPages.push({
      args: structuredClone(args), response: structuredClone(response), callIndex: current.calls.length - 1,
    });
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, fixtureError: 'fixture_contract_invalid' }));
  }
});
await new Promise((resolve) => server.listen(0, host, resolve));
origin = 'http://' + host + ':' + server.address().port;
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin, { mode: 0o700 });
fs.writeFileSync(path.join(bin, 'curl'), [
  '#!/usr/bin/env bash', 'set -euo pipefail', 'found=0', 'config_next=0', 'config_stdin=0',
  'for arg in "$@"; do',
  '  if [[ "$config_next" == 1 ]]; then [[ "$arg" == - ]] || exit 97; config_stdin=1; config_next=0; continue; fi',
  '  case "$arg" in',
  '    --config) config_next=1 ;;',
  '    -K*|--config=*) printf "%s\\n" blocked >> "$ROO_RECONCILE_GUARD_BLOCKED"; exit 97 ;;',
  '    --url=*) [[ "${arg#--url=}" == "$ROO_RECONCILE_FIXTURE_ORIGIN/"* ]] || { printf "%s\\n" blocked >> "$ROO_RECONCILE_GUARD_BLOCKED"; exit 97; }; found=1 ;;',
  '    -L|--location|--location-trusted) printf "%s\\n" blocked >> "$ROO_RECONCILE_GUARD_BLOCKED"; exit 97 ;;',
  '    http://*|https://*)',
  '      [[ "$arg" == "$ROO_RECONCILE_FIXTURE_ORIGIN/"* ]] || { printf "%s\\n" blocked >> "$ROO_RECONCILE_GUARD_BLOCKED"; exit 97; }',
  '      found=1 ;;',
  '  esac',
  'done',
  '[[ "$found" == 1 ]] || exit 97',
  'if [[ "$config_stdin" == 1 ]]; then',
  '  config=$(cat)',
  '  expected=$(printf \'header = "Authorization: Bearer %s"\' "$(cat "$HOME/.config/roo/reconcile-token")")',
  '  [[ "$config" == "$expected" ]] || { printf "%s\\n" blocked >> "$ROO_RECONCILE_GUARD_BLOCKED"; exit 97; }',
  '  printf "%s\\n" "$config" | "$ROO_RECONCILE_REAL_CURL" "$@"',
  '  exit "$?"',
  'fi',
  'exec "$ROO_RECONCILE_REAL_CURL" "$@"', '',
].join('\n'), { mode: 0o700 });
fs.writeFileSync(path.join(bin, 'executor'), [
  '#!/usr/bin/env bash', 'set -euo pipefail',
  'if [[ "${1:-}" == "--reconcile-test-handshake" ]]; then',
  '  [[ "${2:-}" == "$ROO_RECONCILE_FIXTURE_ORIGIN" ]] || exit 96',
  '  printf "%s\\n" "$ROO_RECONCILE_FIXTURE_ORIGIN" >> "$ROO_RECONCILE_HANDSHAKE_LOG"',
  '  jq -nc --arg origin "$ROO_RECONCILE_FIXTURE_ORIGIN" \'{rooReconcileFixture:1,origin:$origin}\'',
  '  exit 0', 'fi',
  '[[ "$#" == 7 && "$1" == call && "$2" == tools && "$3" == linear && "$4" == org && "$5" == linear ]] || exit 96',
  'case "$6" in get_issue|list_issues|list_comments|get_status_updates|save_issue|save_comment|save_status_update) ;; *) exit 96 ;; esac',
  'printf "%s" "$7" | curl --silent --show-error --fail-with-body --max-time 20 --header "Content-Type: application/json" --data-binary @- "$ROO_RECONCILE_FIXTURE_ORIGIN/linear/$6"', '',
].join('\n'), { mode: 0o700 });
const homeFor = (name) => {
  const home = path.join(scratch, name);
  fs.mkdirSync(path.join(home, '.config/roo'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.config/roo/reconcile-token'), token + '\n', { mode: 0o600 });
  return home;
};
const registryFile = (home) => path.join(home, '.local/state/roo-reconcile/identities.json');
const registrySnapshot = (home) => {
  const file = registryFile(home);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { kind: 'missing' }; throw error; }
  const details = { mode: stat.mode & 0o777, uid: stat.uid };
  if (stat.isSymbolicLink()) return { ...details, kind: 'symlink', target: fs.readlinkSync(file) };
  if (stat.isDirectory()) return { ...details, kind: 'directory', entries: fs.readdirSync(file) };
  if (stat.isFile()) return { ...details, kind: 'file', text: fs.readFileSync(file, 'utf8') };
  return { ...details, kind: 'other' };
};
const invoke = (home, options = {}) => {
  const boundary = {
    callStart: current.calls.length, sourceStart: current.requests.length, registryBefore: registrySnapshot(home),
    ...(current.captureIdentity ? { remoteBefore: structuredClone({ issues: current.issues, comments: current.comments }) } : {}),
  };
  const executable = baseline || path.join(root, 'scripts/reconcile-payments.sh');
  const env = {
    PATH: bin + ':/usr/bin:/bin', HOME: home, TMPDIR: scratch, LC_ALL: 'C',
    ROO_RECONCILE_TEST_MODE: '1', ROO_RECONCILE_DATE: current.date,
    ROO_RECONCILE_URL: origin + '/api/payment/report',
    ROO_RECONCILE_EXECUTOR_BIN: path.join(bin, 'executor'),
    ROO_RECONCILE_REAL_CURL: actualCurl, ROO_RECONCILE_FIXTURE_ORIGIN: origin,
    ROO_RECONCILE_GUARD_BLOCKED: path.join(home, 'blocked'),
    ROO_RECONCILE_HANDSHAKE_LOG: path.join(home, 'handshakes'),
    ...options.env,
  };
  if (options.defaultExecutor) delete env.ROO_RECONCILE_EXECUTOR_BIN;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [executable], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      assert.equal((stdout + stderr).includes(token), false, 'Fixture bearer leaked');
      const alertFile = path.join(home, '.local/share/mission-control/alerts/site-reconcile.json');
      const stateFile = path.join(home, '.local/state/roo-reconcile/run-' + current.date + '.json');
      const result = { code, signal, stdout, stderr,
        state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null,
        alert: fs.existsSync(alertFile) ? JSON.parse(fs.readFileSync(alertFile, 'utf8')) : null,
        boundary: { ...boundary, calls: structuredClone(current.calls.slice(boundary.callStart)),
          sourceRequests: structuredClone(current.requests.slice(boundary.sourceStart)), registryAfter: registrySnapshot(home),
          ...(current.captureIdentity ? { remoteAfter: structuredClone({ issues: current.issues, comments: current.comments }) } : {}) },
      };
      current.runs.push(result);
      resolve(result);
    });
  });
};
const metadata = (issue) => {
  const comments = current.comments.filter((comment) => comment.issueId === issue.uuid && comment.body.startsWith('Payment reconciliation status\n'));
  assert.equal(comments.length, 1);
  return JSON.parse(comments[0].body.split('\n')[1].slice('Reconciliation: '.length));
};
const writes = () => current.calls.filter((call) => call.method.startsWith('save_'));
const writesFor = (issue) => {
  const commentIds = current.comments.filter((comment) => comment.issueId === issue.uuid).map((comment) => comment.id);
  return writes().filter((call) =>
    (call.method === 'save_issue' && call.args.id === issue.uuid) ||
    (call.method === 'save_comment' && (call.args.issueId === issue.uuid || commentIds.includes(call.args.id))));
};
const targetedKeys = () => current.requests.flatMap((request) => request.checks || []);
const assertProjectedChildReads = () => {
  const calls = current.calls.filter((call) => call.method === 'get_issue' && call.args.id !== 'ROO-498');
  assert.ok(calls.length > 0);
  for (const call of calls) assert.deepEqual(call.args.fields, issueFields);
};
const heldKey = 'payment:payment-fixture';
const seedHeldIssue = (archived = false) => {
  const issue = seedIssue(heldKey, {
    status: archived ? 'Done' : 'Canceled', statusType: archived ? 'completed' : 'canceled',
    archivedAt: archived ? '2026-01-02T00:00:00.000Z' : null,
  }, { observations: [item(heldKey, 'amount_mismatch', 'booking.fixture')] });
  issue.description += '\nHuman investigation notes remain unchanged.';
  current.comments.push({
    id: crypto.randomUUID(), issueId: issue.uuid, body: 'Human follow-up remains unchanged.',
    createdAt: iso(), updatedAt: iso(), attachments: [],
  });
  return issue;
};
const seedHumanIssue = (description) => {
  const issue = seedIssue('payment:fixture', { title: 'Human investigation', description });
  current.comments = current.comments.filter((comment) => comment.issueId !== issue.uuid);
  current.comments.push({
    id: crypto.randomUUID(), issueId: issue.uuid, body: 'Human investigation notes remain unchanged.',
    createdAt: iso(), updatedAt: iso(), author: { name: 'Fixture operator' }, attachments: [],
    onBehalfOf: null, parentId: null, quotedText: null, resolvedAt: null,
  });
  return issue;
};
const fault = () => item('payment:fixture');
const assertRetainedIdentity = (result, issue, released, primary = 'payment:fixture') => {
  const snapshot = result.boundary.registryAfter;
  assert.equal(snapshot.kind, 'file');
  assert.equal(snapshot.uid, process.getuid());
  assert.equal(snapshot.mode & 0o077, 0);
  const registry = JSON.parse(snapshot.text);
  assert.deepEqual(Object.keys(registry).sort(), ['issues', 'scope', 'version']);
  assert.equal(registry.version, 1);
  assert.deepEqual(registry.scope, scope);
  assert.deepEqual(registry.issues.filter((entry) => entry.uuid === issue.uuid), [{ uuid: issue.uuid, primary, released }]);
};
const assertIdentityRefusal = (result) => {
  assert.notEqual(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.result, 'unavailable');
  assert.equal(output.complete, false);
  assert.equal(result.alert.severity, 'amber');
  assert.equal(result.boundary.calls.filter((call) => call.method.startsWith('save_')).length, 0);
  assert.deepEqual(result.boundary.sourceRequests, []);
  assert.deepEqual(result.boundary.remoteAfter, result.boundary.remoteBefore);
  const inScope = result.boundary.remoteBefore.issues.filter((issue) =>
    issue.parentId === scope.parentId && issue.projectId === scope.projectId && issue.teamId === scope.teamId);
  for (const call of result.boundary.calls.filter((entry) => entry.method === 'get_issue' && entry.args.id !== 'ROO-498')) {
    assert.ok(inScope.some((issue) => issue.uuid === call.args.id));
  }
};
const ageWindow = () => {
  current.window = windowReport();
  current.date = new Date(Date.parse(current.date) + 4 * 86400000).toISOString().slice(0, 10);
};
const loseIssue = (issue, kind) => {
  if (kind === 'project-move') issue.projectId = crypto.randomUUID();
  else if (kind === 'team-move') issue.teamId = crypto.randomUUID();
  else if (kind === 'parent-null') issue.parentId = null;
  else if (kind === 'parent-other') issue.parentId = crypto.randomUUID();
  else if (kind === 'nested-reparent') issue.parentId = seedHumanIssue(null).uuid;
  else if (kind === 'delete') current.issues = current.issues.filter((entry) => entry.uuid !== issue.uuid);
  else assert.fail('Unknown identity loss fixture');
};
const firstMismatch = async (home, extra = {}) => {
  const issue = seedIssue('payment:fixture', extra);
  issue.description += '\nHuman investigation remains unchanged.';
  current.comments.push({ id: crypto.randomUUID(), issueId: issue.uuid, body: 'Human follow-up remains unchanged.',
    createdAt: iso(), updatedAt: iso(), attachments: [] });
  current.window = windowReport([fault()]);
  current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
  const result = await invoke(home);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).result, 'mismatch');
  return issue;
};
const recoverIdentity = async (home, issue) => {
  current.window = windowReport();
  current.checks['payment:fixture'] = recovered('payment:fixture');
  const result = await invoke(home);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).result, 'clear');
  assert.equal(issue.status, 'Done');
  return result;
};
const run = async (name, fn) => {
  if (selected && !selected.includes(name)) return;
  current = freshState();
  current.captureIdentity = name.startsWith('retained-registry-');
  const home = homeFor(name);
  let passed = false, error;
  try { await fn(home); passed = true; }
  catch (cause) { error = cause.message; }
  const blocked = fs.existsSync(path.join(home, 'blocked')) ? fs.readFileSync(path.join(home, 'blocked'), 'utf8').trim().split('\n').length : 0;
  results.push({ name, passed, error, blockedRequests: blocked, expectedBlockedRequests: current.expectedBlocked || 0, calls: current.calls, sourceRequests: current.requests,
    handshakes: fs.existsSync(path.join(home, 'handshakes')) ? fs.readFileSync(path.join(home, 'handshakes'), 'utf8').trim().split('\n') : [],
    issueResponses: current.issueResponses, updateResponses: current.updateResponses,
    identityBefore: current.identityBefore, workflowRaces: current.workflowRaces, registryFault: current.registryFault, listPages: current.listPages,
    issues: current.issues, comments: current.comments, updates: current.updates, runs: current.runs });
};
try {
  if (baseline) {
    await run('legacy-daily-record', async (home) => {
      current.window = windowReport([fault()]);
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(fs.existsSync(path.join(home, '.local/share/mission-control/alerts/site-reconcile.json')), true);
      assert.equal(current.requests.length, 1);
      assert.equal(current.updates.length, 1, 'Daily project record missing despite successful local alert');
      assert.equal(current.issues.length, 1);
    });
  } else {
    for (const kind of ['project-move', 'team-move', 'parent-null', 'parent-other', 'nested-reparent', 'delete']) {
      await run('retained-registry-' + kind, async (home) => {
        const issue = await firstMismatch(home);
        ageWindow();
        loseIssue(issue, kind);
        const result = await invoke(home);
        assertIdentityRefusal(result);
        assert.equal(result.alert.items[0].reason, 'linear_identity_invalid');
        assertRetainedIdentity(result, issue, false);
        if (kind === 'project-move') {
          Object.assign(issue, scope);
          const recovery = await recoverIdentity(home, issue);
          assert.equal(current.issues.filter((entry) => entry.uuid === issue.uuid).length, 1);
          assert.ok(recovery.boundary.sourceRequests.some((request) => request.checks?.includes('payment:fixture')));
          assertRetainedIdentity(recovery, issue, true);
        }
      });
    }
    for (const kind of ['unknown', 'completed-unresolved', 'canceled-unresolved', 'archived-unresolved']) {
      await run('retained-registry-' + kind, async (home) => {
        const issue = seedIssue('payment:fixture', kind === 'canceled-unresolved'
          ? { status: 'Canceled', statusType: 'canceled' }
          : kind === 'archived-unresolved' ? { status: 'Done', statusType: 'completed', archivedAt: '2026-01-02T00:00:00.000Z' } : {});
        current.checks['payment:fixture'] = kind === 'unknown' ? check('payment:fixture')
          : check('payment:fixture', 'unresolved', [fault()]);
        assert.equal((await invoke(home)).code, 0);
        if (kind === 'completed-unresolved') Object.assign(issue, { status: 'Done', statusType: 'completed' });
        ageWindow();
        loseIssue(issue, 'parent-null');
        const result = await invoke(home);
        assertIdentityRefusal(result);
        assertRetainedIdentity(result, issue, false);
      });
    }
    for (const kind of ['project-move', 'parent-null', 'delete']) {
      await run('retained-registry-released-' + kind, async (home) => {
        const issue = await firstMismatch(home);
        const recovery = await recoverIdentity(home, issue);
        ageWindow();
        loseIssue(issue, kind);
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'clear');
        assert.equal(JSON.parse(result.stdout).complete, true);
        assert.equal(result.alert.severity, 'green');
        assert.equal(result.boundary.calls.filter((call) => call.method === 'save_issue' || call.method === 'save_comment').length, 0);
        assert.deepEqual(result.boundary.sourceRequests.map((request) => request.checks), [null]);
        assert.deepEqual(result.boundary.remoteAfter, result.boundary.remoteBefore);
        assert.equal(result.boundary.calls.some((call) => call.method === 'get_issue' && call.args.id === issue.uuid), false);
        assertRetainedIdentity(recovery, issue, true);
        assertRetainedIdentity(result, issue, true);
      });
    }
    await run('retained-registry-open-recovered-comment', async (home) => {
      const issue = await firstMismatch(home);
      current.window = windowReport();
      current.checks['payment:fixture'] = recovered('payment:fixture');
      current.failures.push({ method: 'save_issue', when: (args) => args.state === 'Done' });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Backlog');
      assert.equal(metadata(issue).state, 'recovered');
      ageWindow();
      loseIssue(issue, 'project-move');
      const result = await invoke(home);
      assertIdentityRefusal(result);
      assertRetainedIdentity(result, issue, false);
    });
    await run('retained-registry-replacement-uuid', async (home) => {
      const issue = await firstMismatch(home);
      ageWindow();
      loseIssue(issue, 'project-move');
      const replacement = seedIssue('payment:fixture');
      const result = await invoke(home);
      assertIdentityRefusal(result);
      assertRetainedIdentity(result, issue, false);
      assert.equal(JSON.parse(result.boundary.registryAfter.text).issues.some((entry) => entry.uuid === replacement.uuid), false);
    });
    await run('retained-registry-changed-primary', async (home) => {
      const issue = await firstMismatch(home);
      ageWindow();
      issue.description = managedDescription('record:record.fixture');
      const meta = metadata(issue);
      Object.assign(meta, { primary: 'record:record.fixture', keys: ['record:record.fixture'], observations: [] });
      current.comments.find((comment) => comment.issueId === issue.uuid && comment.body.startsWith('Payment reconciliation status\n')).body =
        'Payment reconciliation status\nReconciliation: ' + JSON.stringify(meta);
      const result = await invoke(home);
      assertIdentityRefusal(result);
      assertRetainedIdentity(result, issue, false);
    });
    await run('retained-registry-unrelated-children', async (home) => {
      seedHumanIssue(null);
      const unrelated = seedIssue('payment:elsewhere', { projectId: crypto.randomUUID() });
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'clear');
      assert.equal(result.alert.severity, 'green');
      assert.equal(result.boundary.calls.some((call) => call.method === 'get_issue' && call.args.id === unrelated.uuid), false);
      assert.equal(result.boundary.calls.filter((call) => call.method === 'save_issue' || call.method === 'save_comment').length, 0);
      assert.deepEqual(result.boundary.remoteAfter, result.boundary.remoteBefore);
      assert.equal(result.boundary.registryAfter.kind, 'file');
      assert.deepEqual(JSON.parse(result.boundary.registryAfter.text).issues, []);
    });
    await run('retained-registry-provisional-create', async (home) => {
      current.window = windowReport([fault()]);
      current.failures.push({ method: 'get_issue', when: (args) => args.id !== 'ROO-498' && current.calls.some((call) => call.method === 'save_issue' && !call.args.id) });
      const first = await invoke(home);
      assert.notEqual(first.code, 0);
      assert.equal(current.issues.length, 1);
      const issue = current.issues[0];
      assert.ok(current.issueResponses.some((response) => response.method === 'save_issue' && response.dto.uuid === issue.uuid));
      ageWindow();
      loseIssue(issue, 'project-move');
      const result = await invoke(home);
      assertIdentityRefusal(result);
      assertRetainedIdentity(first, issue, false);
      assertRetainedIdentity(result, issue, false);
    });
    for (const kind of ['missing', 'malformed-json', 'wrong-scope', 'invalid-boolean', 'invalid-entry', 'invalid-uuid', 'symlink', 'directory']) {
      await run('retained-registry-unsafe-' + kind, async (home) => {
        const issue = await firstMismatch(home);
        ageWindow();
        loseIssue(issue, 'parent-null');
        const file = registryFile(home);
        const valid = { version: 1, scope, issues: [{ uuid: issue.uuid, primary: 'payment:fixture', released: false }] };
        if (fs.existsSync(file)) fs.unlinkSync(file);
        let target;
        if (kind === 'missing') {}
        else if (kind === 'symlink') {
          target = path.join(home, 'retained-registry-target.json');
          fs.writeFileSync(target, JSON.stringify(valid), { mode: 0o600 });
          fs.symlinkSync(target, file);
        } else if (kind === 'directory') fs.mkdirSync(file, { mode: 0o700 });
        else {
          if (kind === 'wrong-scope') valid.scope = { ...scope, projectId: crypto.randomUUID() };
          if (kind === 'invalid-boolean') valid.issues[0].released = 'false';
          if (kind === 'invalid-entry') valid.issues[0].human = 'Unexpected field';
          if (kind === 'invalid-uuid') valid.issues[0].uuid = 'not-a-uuid';
          fs.writeFileSync(file, kind === 'malformed-json' ? '{invalid json' : JSON.stringify(valid), { mode: 0o600 });
        }
        const before = registrySnapshot(home);
        const targetBefore = target ? fs.readFileSync(target, 'utf8') : null;
        const result = await invoke(home);
        assertIdentityRefusal(result);
        assert.deepEqual(registrySnapshot(home), before);
        if (target) assert.equal(fs.readFileSync(target, 'utf8'), targetBefore);
      });
    }
    await run('retained-registry-write-failure', async (home) => {
      const issue = await firstMismatch(home);
      const file = registryFile(home);
      if (!fs.existsSync(file)) fs.writeFileSync(file,
        JSON.stringify({ version: 1, scope, issues: [{ uuid: issue.uuid, primary: 'payment:fixture', released: false }] }), { mode: 0o600 });
      const before = fs.readFileSync(file, 'utf8');
      const retained = path.join(home, 'retained-registry-last-good.json');
      let changed = false;
      current.beforeIssueRead = (args) => {
        if (args.id !== issue.uuid || changed) return;
        changed = true;
        fs.renameSync(file, retained);
        fs.mkdirSync(file, { mode: 0o700 });
      };
      const result = await invoke(home);
      assertIdentityRefusal(result);
      assert.equal(changed, true);
      assert.equal(result.alert.items[0].reason, 'linear_identity_unavailable');
      assert.equal(registrySnapshot(home).kind, 'directory');
      assert.deepEqual(fs.readdirSync(file), []);
      assert.equal(fs.readFileSync(retained, 'utf8'), before);
      current.registryFault = { kind: 'destination-directory', before, retained: fs.readFileSync(retained, 'utf8') };
    });
    await run('retained-registry-invalidate-before-comments', async (home) => {
      const issue = await firstMismatch(home);
      await recoverIdentity(home, issue);
      current.failures.push({ method: 'list_comments', when: (args) => args.issueId === issue.uuid });
      assert.notEqual((await invoke(home)).code, 0);
      ageWindow();
      loseIssue(issue, 'parent-null');
      const result = await invoke(home);
      assertIdentityRefusal(result);
      assertRetainedIdentity(result, issue, false);
    });
    for (const kind of ['marker-loss', 'invalid-marker', 'failed-canonical-read', 'partial-pagination']) {
      await run('retained-registry-observed-' + kind, async (home) => {
        const issue = await firstMismatch(home);
        const recovery = await recoverIdentity(home, issue);
        assertRetainedIdentity(recovery, issue, true);
        Object.assign(issue, { status: 'Backlog', statusType: 'backlog' });
        let failure, unrelated;
        if (kind === 'marker-loss') issue.description = 'Human investigation continues without a managed key.';
        if (kind === 'invalid-marker') issue.description += '\nReconciliation key: payment:fixture';
        if (kind === 'failed-canonical-read') {
          failure = { method: 'get_issue', when: (args) => args.id === issue.uuid, status: 503 };
        }
        if (kind === 'partial-pagination') {
          unrelated = seedHumanIssue(null);
          current.pageSize = 1;
          failure = { method: 'list_issues', when: (args) => Boolean(args.cursor), status: 503 };
        }
        if (failure) current.failures.push(failure);
        const pageStart = current.listPages.length;
        const intermediate = await invoke(home);
        assertIdentityRefusal(intermediate);
        if (failure) assert.equal(failure.used, true);
        if (kind === 'partial-pagination') {
          const pages = current.listPages.slice(pageStart);
          assert.equal(pages.length, 2);
          assert.equal(pages[0].response.status, 200);
          const firstPage = JSON.parse(pages[0].response.body.data.content[0].text);
          assert.deepEqual(firstPage.issues.map((entry) => entry.uuid), [issue.uuid]);
          assert.equal(firstPage.hasNextPage, true);
          assert.equal(firstPage.cursor, issue.uuid);
          assert.equal(pages[1].args.cursor, firstPage.cursor);
          assert.equal(pages[1].response.status, 503);
        }
        ageWindow();
        loseIssue(issue, 'parent-null');
        if (unrelated) loseIssue(unrelated, 'parent-null');
        current.failures = current.failures.filter((entry) => entry !== failure);
        const result = await invoke(home);
        assertIdentityRefusal(result);
        assert.equal(result.alert.items[0].reason, 'linear_identity_invalid');
        assertRetainedIdentity(intermediate, issue, false);
        assertRetainedIdentity(result, issue, false);
        assert.equal(current.issues.filter((entry) => entry.uuid === issue.uuid).length, 1);
      });
    }
    await run('status-update-normalized-bodies', async (home) => {
      current.window = windowReport([fault()]);
      const mismatch = await invoke(home);
      assert.equal(mismatch.code, 0);
      assert.equal(JSON.parse(mismatch.stdout).result, 'mismatch');
      assert.equal(mismatch.alert.severity, 'red');
      assert.equal(current.issues.length, 1);
      assert.equal(current.comments.length, 1);
      assert.equal(current.updates.length, 1);
      const issue = current.issues[0];
      const issueUUID = issue.uuid;
      const updateID = current.updates[0].id;
      const issueURL = 'https://linear.app/rooindustries/issue/' + issue.id;
      assert.deepEqual(JSON.parse(mismatch.stdout).ownedissueURLs, [issueURL]);
      assert.deepEqual(mismatch.state.ownedissueURLs, [issueURL]);
      current.window = windowReport();
      current.checks['payment:fixture'] = recovered('payment:fixture');
      const recovery = await invoke(home);
      assert.equal(recovery.code, 0);
      assert.equal(JSON.parse(recovery.stdout).result, 'clear');
      assert.equal(JSON.parse(recovery.stdout).complete, true);
      assert.equal(recovery.alert.severity, 'green');
      assert.equal(current.issues.length, 1);
      assert.equal(current.issues[0].uuid, issueUUID);
      assert.equal(issue.status, 'Done');
      assert.equal(current.comments.length, 1);
      assert.equal(current.updates.length, 1);
      assert.equal(current.updates[0].id, updateID);
      assert.deepEqual(JSON.parse(recovery.stdout).ownedissueURLs, [issueURL]);
      assert.deepEqual(recovery.state.ownedissueURLs, [issueURL]);
      const bodies = [
        'Reconciliation run: ' + today + '\nPayment audit: mismatch. Reported: 1; listed: 1; open: 1; unknown: 0; recovered: 0. Incomplete: false.\n' + issue.id,
        'Reconciliation run: ' + today + '\nPayment audit: clear. Reported: 0; listed: 0; open: 0; unknown: 0; recovered: 1. Incomplete: false.\n' + issue.id,
      ];
      const saved = current.updateResponses.filter((response) => response.method === 'save_status_update' && !response.authoredBody.endsWith('Payment audit: pending.'));
      assert.deepEqual(saved.map((response) => response.authoredBody), bodies);
      assert.deepEqual(saved.map((response) => response.dto.body), bodies);
      assert.equal(current.updates[0].body, bodies[1]);
      for (const body of bodies) assert.doesNotMatch(body, /https?:\/\//);
      for (const body of bodies) assert.ok(current.updateResponses.some((response) => response.method === 'get_status_updates' && response.dto.body === body));
      assert.equal(writes().some((call) => call.method === 'save_issue' && Object.hasOwn(call.args, 'description') && call.args.id), false);
      assertProjectedChildReads();
    });
    for (const [name, description] of [['nullable-unowned-child', null], ['empty-unowned-child', '']]) {
      await run(name, async (home) => {
        const issue = seedHumanIssue(description);
        current.identityBefore = structuredClone({ issues: current.issues, comments: current.comments });
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'clear');
        assert.equal(JSON.parse(result.stdout).complete, true);
        assert.deepEqual(JSON.parse(result.stdout).ownedissueURLs, []);
        assert.equal(result.alert.severity, 'green');
        assert.equal(current.updates.length, 1);
        assert.deepEqual({ issues: current.issues, comments: current.comments }, current.identityBefore);
        assert.equal(writes().filter((call) => call.method !== 'save_status_update').length, 0);
        assert.deepEqual(current.requests.map((request) => request.checks), [null]);
        assert.ok(current.calls.some((call) => call.method === 'list_comments' && call.args.issueId === issue.uuid && call.args.limit === 100 && call.args.orderBy === 'updatedAt'));
        assertProjectedChildReads();
        assert.ok(current.issueResponses.some((response) => response.method === 'get_issue' && response.dto.description === description));
      });
    }
    for (const [name, description] of [
      ['lost-owned-description-null', null], ['lost-owned-description-empty', ''],
      ['lost-owned-description-replaced', 'Human investigation is continuing.'],
    ]) {
      await run(name, async (home) => {
        const issue = seedIssue('payment:fixture', { description });
        current.identityBefore = structuredClone({ issues: current.issues, comments: current.comments });
        const result = await invoke(home);
        assert.notEqual(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'unavailable');
        assert.equal(JSON.parse(result.stdout).complete, false);
        assert.equal(result.alert.severity, 'amber');
        assert.equal(writes().length, 0);
        assert.equal(current.requests.length, 0);
        assert.deepEqual({ issues: current.issues, comments: current.comments }, current.identityBefore);
        assertProjectedChildReads();
        assert.ok(current.calls.some((call) => call.method === 'list_comments' && call.args.issueId === issue.uuid));
        assert.equal(result.alert.items[0].reason, 'linear_identity_invalid');
      });
    }
    for (const [name, description] of [
      ['malformed-description-false', false], ['malformed-description-object', { human: 'Malformed description' }],
    ]) {
      await run(name, async (home) => {
        seedHumanIssue(description);
        current.identityBefore = structuredClone({ issues: current.issues, comments: current.comments });
        const result = await invoke(home);
        assert.notEqual(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'unavailable');
        assert.equal(JSON.parse(result.stdout).complete, false);
        assert.equal(result.alert.severity, 'amber');
        assert.equal(result.alert.items[0].reason, 'linear_scope_invalid');
        assert.equal(writes().length, 0);
        assert.equal(current.requests.length, 0);
        assert.deepEqual({ issues: current.issues, comments: current.comments }, current.identityBefore);
        assert.deepEqual(current.issueResponses.find((response) => response.method === 'list_issues').dto.description, description);
      });
    }
    await run('unowned-comment-read-fails', async (home) => {
      const issue = seedHumanIssue('');
      current.identityBefore = structuredClone({ issues: current.issues, comments: current.comments });
      const failure = { method: 'list_comments', when: (args) => args.issueId === issue.uuid };
      current.failures.push(failure);
      const result = await invoke(home);
      assert.notEqual(result.code, 0);
      assert.equal(failure.used, true);
      assert.equal(JSON.parse(result.stdout).result, 'unavailable');
      assert.equal(JSON.parse(result.stdout).complete, false);
      assert.equal(result.alert.severity, 'amber');
      assert.equal(writes().length, 0);
      assert.equal(current.requests.length, 0);
      assert.deepEqual({ issues: current.issues, comments: current.comments }, current.identityBefore);
      assertProjectedChildReads();
    });
    await run('linear-description-roundtrip', async (home) => {
      current.window = windowReport([fault()]);
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'mismatch');
      assert.equal(result.alert.severity, 'red');
      assert.equal(current.issues.length, 1);
      assert.equal(current.comments.length, 1);
      assert.equal(current.updates.length, 1);
      assert.equal(metadata(current.issues[0]).primary, 'payment:fixture');
      const created = current.issueResponses.find((response) => response.method === 'save_issue');
      assert.equal(created.dto.description, responseDescription(created.authoredDescription));
      assert.equal(responseDescription(created.dto.description), created.dto.description);
      assert.ok(created.authoredDescription.includes('**Evidence**: Current evidence lives in the reconciliation status comment.\n\nReconciliation key: payment:fixture'));
      assert.equal(created.authoredDescription.includes('Daily report:'), false);
      assert.equal(writes().some((call) => call.method === 'save_issue' && call.args.id && Object.hasOwn(call.args, 'description')), false);
      assertProjectedChildReads();
    });
    await run('listed-description-truncated', async (home) => {
      const issue = seedIssue('payment:fixture');
      issue.description = 'Human investigation context remains intact. '.repeat(16) +
        '\nHuman reference https://fixture.invalid/reconciliation/context\n\n' + issue.description;
      const description = issue.description;
      const human = { id: crypto.randomUUID(), issueId: issue.uuid, body: 'Human comment remains intact.',
        createdAt: iso(), updatedAt: iso(), attachments: [] };
      current.comments.push(human);
      const humanCopy = structuredClone(human);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
      for (let index = 0; index < 2; index += 1) {
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.deepEqual(targetedKeys(), Array(index + 1).fill('payment:fixture'));
        assert.equal(JSON.parse(result.stdout).result, 'mismatch');
        assert.equal(result.alert.severity, 'red');
        assert.equal(current.issues.length, 1);
        assert.equal(current.issues[0].uuid, issue.uuid);
        assert.equal(issue.description, description);
        assert.deepEqual(human, humanCopy);
      }
      const preview = current.issueResponses.find((response) => response.method === 'list_issues' && response.uuid === issue.uuid);
      const full = current.issueResponses.find((response) => response.method === 'get_issue' && response.uuid === issue.uuid);
      assert.equal(preview.dto.description.length, 500);
      assert.ok(preview.dto.description.endsWith(truncationMarker));
      assert.equal(preview.dto.description.includes('Reconciliation key:'), false);
      assert.ok(full.dto.description.includes('Reconciliation key: payment:fixture'));
      assert.equal(full.dto.description, responseDescription(description));
      assert.equal(responseDescription(full.dto.description), full.dto.description);
      assert.equal(writesFor(issue).some((call) => call.method === 'save_issue'), false);
      assertProjectedChildReads();
    });
    await run('minimal-create-response', async (home) => {
      current.minimalCreateResponse = true;
      current.window = windowReport([fault()]);
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'mismatch');
      assert.equal(result.alert.severity, 'red');
      assert.equal(current.issues.length, 1);
      assert.equal(current.comments.length, 1);
      assert.equal(current.updates.length, 1);
      assert.equal(metadata(current.issues[0]).primary, 'payment:fixture');
      const created = current.issueResponses.find((response) => response.method === 'save_issue');
      assert.deepEqual(created.dto, { uuid: current.issues[0].uuid });
      assertProjectedChildReads();
    });
    await run('projected-child-response', async (home) => {
      current.omitDefaultChildParent = true;
      const issue = seedIssue('payment:fixture');
      issue.description += '\nHuman reference https://fixture.invalid/reconciliation/retained';
      const before = structuredClone(issue);
      const human = { id: crypto.randomUUID(), issueId: issue.uuid, body: 'Human retained note.',
        createdAt: iso(), updatedAt: iso(), attachments: [] };
      current.comments.push(human);
      const humanCopy = structuredClone(human);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'mismatch');
      assert.equal(result.alert.severity, 'red');
      assert.deepEqual(targetedKeys(), ['payment:fixture']);
      assert.equal(current.issues.length, 1);
      assert.deepEqual(issue, before);
      assert.deepEqual(human, humanCopy);
      assertProjectedChildReads();
      assert.ok(current.issueResponses.filter((response) => response.method === 'get_issue')
        .every((response) => response.dto.parentId === scope.parentId));
    });
    for (const kind of ['missing', 'scope-mismatch']) {
      await run('canonical-child-' + kind, async (home) => {
        const issue = seedIssue('payment:fixture');
        current.canonicalChildFault = { id: issue.uuid, kind: kind === 'missing' ? 'missing' : 'scope' };
        const before = structuredClone({ issue, comments: current.comments });
        current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
        const result = await invoke(home);
        assert.notEqual(result.code, 0);
        assert.equal(writes().length, 0);
        assert.equal(current.requests.length, 0);
        const output = JSON.parse(result.stdout);
        assert.equal(output.result, 'unavailable');
        assert.equal(output.complete, false);
        assert.equal(result.alert.severity, 'amber');
        assert.equal(result.alert.items[0].reason, 'linear_scope_invalid');
        assert.deepEqual({ issue, comments: current.comments }, before);
        assertProjectedChildReads();
      });
    }
    for (const selection of ['default', 'explicit']) {
      await run('executor-' + selection + '-symlink', async (home) => {
        const linkedBin = path.join(home, 'bin');
        fs.mkdirSync(linkedBin, { mode: 0o700 });
        const linked = path.join(linkedBin, 'executor');
        fs.symlinkSync(path.relative(linkedBin, path.join(bin, 'executor')), linked);
        const env = { PATH: linkedBin + ':' + bin + ':/usr/bin:/bin',
          ROO_RECONCILE_EXECUTOR_BIN: selection === 'default' ? '' : linked };
        assert.equal((await invoke(home, { env, defaultExecutor: selection === 'default' })).code, 0);
        if (selection === 'default') assert.equal((await invoke(home, { env })).code, 0);
        const expected = selection === 'default' ? 2 : 1;
        assert.equal(fs.readFileSync(path.join(home, 'handshakes'), 'utf8').trim().split('\n').length, expected);
        assert.equal(current.requests.length, expected);
        assert.ok(current.requests.every((request) => request.checks === null));
        assert.equal(current.updates.length, 1);
        assert.equal(current.calls[0].method, 'get_issue');
        assert.deepEqual(current.calls[0].args, { id: 'ROO-498' });
      });
    }
    for (const kind of ['broken', 'nonexecutable']) {
      await run('executor-' + kind + '-symlink-refused', async (home) => {
        const target = path.join(home, 'executor-target');
        if (kind === 'nonexecutable') fs.writeFileSync(target, '#!/bin/bash\nexit 0\n', { mode: 0o600 });
        const linked = path.join(home, 'executor');
        fs.symlinkSync('executor-target', linked);
        const result = await invoke(home, { env: { ROO_RECONCILE_EXECUTOR_BIN: linked } });
        assert.notEqual(result.code, 0);
        assert.equal(result.alert.items[0].reason, 'executor_unavailable');
        assert.equal(current.requests.length, 0);
        assert.equal(current.calls.length, 0);
        assert.equal(fs.existsSync(path.join(home, 'handshakes')), false);
      });
    }
    for (const archived of [false, true]) {
      for (const state of ['unresolved', 'unknown', 'recovered']) {
        await run((archived ? 'archived-closed' : 'canceled') + '-aged-out-' + state, async (home) => {
          const issue = seedHeldIssue(archived);
          const before = structuredClone(issue);
          const originalComments = structuredClone(current.comments);
          const observed = item(heldKey, 'amount_mismatch', 'booking.fixture');
          current.checks[heldKey] = state === 'recovered' ? recovered(heldKey, 'payment-fixture')
            : check(heldKey, state, state === 'unresolved' ? [observed] : []);
          const repetitions = archived && state === 'recovered' ? 2 : 1;
          for (let index = 0; index < repetitions; index += 1) {
            const result = await invoke(home);
            assert.equal(result.code, 0);
            assert.equal(targetedKeys().filter((key) => key === heldKey).length, index + 1);
            const output = JSON.parse(result.stdout);
            assert.equal(output.complete, state === 'recovered');
            assert.equal(output.result, state === 'recovered' ? 'clear' : 'incomplete');
            assert.equal(output.unknown, state === 'recovered' ? 0 : 1);
            assert.equal(result.alert.severity, state === 'recovered' ? 'green' : 'amber');
          }
          assert.deepEqual(issue, before);
          assert.equal(current.issues.filter((entry) => entry.description.includes('Reconciliation key: ' + heldKey)).length, 1);
          assert.equal(writesFor(issue).filter((call) => call.method === 'save_issue').length, 0);
          if (archived) {
            assert.deepEqual(current.comments.filter((comment) => comment.issueId === issue.uuid), originalComments);
            assert.equal(writesFor(issue).length, 0);
          } else {
            assert.equal(metadata(issue).state, state);
            const human = originalComments.find((comment) => !comment.body.startsWith('Payment reconciliation status\n'));
            assert.deepEqual(current.comments.find((comment) => comment.id === human.id), human);
          }
          if (state !== 'recovered') {
            const coverage = current.issues.find((entry) => entry.description.includes('Reconciliation key: scan:targets'));
            assert.ok(coverage);
            assert.equal(coverage.projectId, scope.projectId);
            assert.equal(coverage.teamId, scope.teamId);
            assert.equal(coverage.parentId, scope.parentId);
            assert.match(current.updates[0].body, /incomplete/);
          }
          if (state === 'unknown') assert.equal(current.issues.some((entry) => entry.description.includes('Reconciliation key: scan:linear-identity')), false);
        });
      }
    }
    await run('positively-recovered-done-control', async (home) => {
      const issue = seedIssue(heldKey, { status: 'Done', statusType: 'completed' },
        { state: 'recovered', keys: recovered(heldKey, 'payment-fixture').keys });
      current.checks[heldKey] = recovered(heldKey, 'payment-fixture');
      const original = structuredClone({ issue, comments: current.comments });
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'clear');
      assert.equal(JSON.parse(result.stdout).complete, true);
      assert.equal(result.alert.severity, 'green');
      assert.deepEqual(targetedKeys(), [heldKey]);
      assert.equal(issue.status, 'Done');
      assert.equal(issue.uuid, original.issue.uuid);
      assert.deepEqual({ issue, comments: current.comments }, original);
      assert.equal(writesFor(issue).length, 0);
    });
    await run('completed-unknown-audit-held', async (home) => {
      const issue = seedHeldIssue();
      issue.status = 'Done';
      issue.statusType = 'completed';
      const before = structuredClone(issue);
      const human = structuredClone(current.comments.find((comment) => !comment.body.startsWith('Payment reconciliation status\n')));
      current.checks[heldKey] = check(heldKey, 'unknown');
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.deepEqual(targetedKeys(), [heldKey]);
      const output = JSON.parse(result.stdout);
      assert.equal(output.result, 'incomplete');
      assert.equal(output.complete, false);
      assert.equal(output.unknown, 1);
      assert.equal(result.alert.severity, 'amber');
      assert.deepEqual(issue, before);
      assert.equal(metadata(issue).state, 'unknown');
      assert.equal(writesFor(issue).some((call) => call.method === 'save_issue'), false);
      assert.deepEqual(current.comments.find((comment) => comment.id === human.id), human);
      assert.equal(current.issues.filter((entry) => entry.description.split('\n').includes('Reconciliation key: ' + heldKey)).length, 1);
      assert.ok(current.issues.some((entry) => entry.description.split('\n').includes('Reconciliation key: scan:targets')));
      assert.equal(current.issues.some((entry) => entry.description.split('\n').includes('Reconciliation key: scan:linear-identity')), false);
    });
    await run('completed-identity-scan-held', async (home) => {
      const issue = seedIssue('scan:identity-invalid', { status: 'Done', statusType: 'completed' });
      const before = structuredClone({ issue, comments: current.comments });
      const result = await invoke(home);
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.result, 'incomplete');
      assert.equal(output.complete, false);
      assert.equal(output.unknown, 1);
      assert.equal(result.alert.severity, 'amber');
      assert.deepEqual(targetedKeys(), []);
      assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, before);
      assert.equal(writesFor(issue).length, 0);
      assert.ok(current.issues.some((entry) => entry.description.split('\n').includes('Reconciliation key: scan:targets')));
    });
    await run('canceled-unvisited-under-target-cap', async (home) => {
      for (let index = 0; index < 200; index += 1) {
        const key = 'payment:prior-' + index;
        seedIssue(key);
        current.checks[key] = recovered(key, 'prior-' + index);
      }
      const held = seedHeldIssue();
      const original = structuredClone({ issue: held, comments: current.comments.filter((comment) => comment.issueId === held.uuid) });
      const saved = current.comments.find((comment) => comment.issueId === held.uuid && comment.body.startsWith('Payment reconciliation status\n'));
      const meta = JSON.parse(saved.body.split('\n')[1].slice('Reconciliation: '.length));
      meta.lastCheckedAt = '2026-01-02T00:00:00.000Z';
      saved.body = 'Payment reconciliation status\nReconciliation: ' + JSON.stringify(meta);
      original.comments = structuredClone(current.comments.filter((comment) => comment.issueId === held.uuid));
      current.checks[heldKey] = recovered(heldKey, 'payment-fixture');
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(targetedKeys().length, 200);
      assert.equal(targetedKeys().includes(heldKey), false);
      assert.equal(JSON.parse(result.stdout).result, 'incomplete');
      assert.equal(JSON.parse(result.stdout).unknown, 1);
      assert.equal(result.alert.severity, 'amber');
      assert.ok(current.issues.some((issue) => issue.description.includes('Reconciliation key: scan:targets')));
      assert.deepEqual({ issue: held, comments: current.comments.filter((comment) => comment.issueId === held.uuid) }, original);
      assert.equal(writesFor(held).length, 0);
    });
    for (const archived of [false, true]) {
      await run((archived ? 'archived' : 'canceled') + '-identity-scan-held', async (home) => {
        const issue = seedIssue('scan:identity-invalid', {
          status: archived ? 'Done' : 'Canceled', statusType: archived ? 'completed' : 'canceled',
          archivedAt: archived ? '2026-01-02T00:00:00.000Z' : null,
        });
        const before = structuredClone({ issue, comments: current.comments });
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'incomplete');
        assert.equal(JSON.parse(result.stdout).unknown, 1);
        assert.equal(result.alert.severity, 'amber');
        assert.ok(current.issues.some((entry) => entry.description.includes('Reconciliation key: scan:targets')));
        assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, before);
      });
    }
    await run('closed-complete-scan-control', async (home) => {
      const issue = seedIssue('scan:dodo-payments', { status: 'Canceled', statusType: 'canceled' });
      const before = structuredClone({ issue, comments: current.comments });
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'clear');
      assert.equal(result.alert.severity, 'green');
      assert.deepEqual({ issue, comments: current.comments }, before);
    });
    for (const archived of [false, true]) {
      await run('fresh-' + (archived ? 'archived' : 'canceled') + '-workflow-preserved', async (home) => {
        const issue = seedIssue(heldKey);
        const originalComments = structuredClone(current.comments);
        current.checks[heldKey] = recovered(heldKey, 'payment-fixture');
        let changed = false;
        current.beforeIssueRead = (args) => {
          if (args.id !== issue.uuid || changed || current.requests.length === 0) return;
          assert.ok(current.requests.some((request) => request.checks?.includes(heldKey)));
          changed = true;
          current.workflowRaces.push({ uuid: issue.uuid, callIndex: current.calls.length - 1,
            reportRequests: current.requests.length, targetKeys: targetedKeys() });
          issue.status = archived ? 'Done' : 'Canceled';
          issue.statusType = archived ? 'completed' : 'canceled';
          issue.archivedAt = archived ? iso() : null;
        };
        const result = await invoke(home);
        assert.equal(changed, true);
        assert.equal(current.workflowRaces.length, 1);
        assert.ok(current.workflowRaces[0].reportRequests >= 2);
        assert.ok(current.workflowRaces[0].targetKeys.includes(heldKey));
        assert.equal(issue.status, archived ? 'Done' : 'Canceled');
        assert.equal(issue.statusType, archived ? 'completed' : 'canceled');
        assert.equal(writesFor(issue).some((call) => call.method === 'save_issue'), false);
        if (archived) {
          assert.notEqual(result.code, 0);
          assert.deepEqual(current.comments.filter((comment) => comment.issueId === issue.uuid), originalComments);
          assert.equal(writesFor(issue).length, 0);
        } else {
          assert.equal(result.code, 0);
          assert.equal(metadata(issue).state, 'recovered');
          assert.equal(JSON.parse(result.stdout).result, 'clear');
        }
      });
    }
    await run('clean-record', async (home) => {
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(current.updates.length, 1);
      assert.equal(current.issues.length, 0);
      assert.match(current.updates[0].body, /clear/);
      const output = JSON.parse(result.stdout);
      assert.equal(output.complete, true);
      assert.equal(output.result, 'clear');
      const update = current.updates[0];
      const saved = current.calls.filter((call) => call.method === 'save_status_update');
      assert.equal(saved.length, 2);
      assert.equal(saved[0].args.type, 'project');
      assert.equal(saved[0].args.project, scope.projectId);
      assert.deepEqual(saved[1].args, { type: 'project', id: update.id, body: update.body });
      assert.equal(update.project.id, scope.projectId);
      assert.equal(output.updateURL, update.url);
      assert.match(update.body, /Payment audit: clear[.] Reported: 0; listed: 0; open: 0; unknown: 0; recovered: 0[.] Incomplete: false[.]/);
    });
    await run('original-reasons-and-owner-review', async (home) => {
      const reasons = [
        'payment_without_booking', 'booking_without_payment', 'amount_mismatch', 'dodo_currency_mismatch',
        'refund_not_applied', 'commission_mismatch', 'payment_without_record', 'owner_review_dodo_currency_mismatch',
        'owner_review_provider_order_not_found_after_late_capture_wat',
        'owner_review_provider_partial_refund_details_missing_owner_r',
        'owner_review_unknown',
      ];
      current.window = windowReport(reasons.map((reason, index) => item('payment:case-' + index, reason)));
      assert.equal((await invoke(home)).code, 0);
      assert.equal(current.issues.length, reasons.length);
      for (const issue of current.issues) assert.equal(metadata(issue).state, 'unresolved');
    });
    await run('same-day-retry-and-next-day', async (home) => {
      current.window = windowReport([fault()]);
      const first = await invoke(home);
      assert.equal(first.code, 0);
      const firstId = current.updates[0].id;
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
      const retry = await invoke(home);
      assert.equal(retry.code, 0);
      assert.equal(current.updates.length, 1);
      assert.equal(current.updates[0].id, firstId);
      assert.equal(current.issues.length, 1);
      assert.equal(current.comments.length, 1);
      current.date = tomorrow;
      const next = await invoke(home);
      assert.equal(next.code, 0);
      assert.equal(current.updates.length, 2);
      assert.equal(current.issues.length, 1);
      const nextId = current.updates[1].id;
      assert.notEqual(nextId, firstId);
      const saved = current.calls.filter((call) => call.method === 'save_status_update');
      assert.equal(saved.length, 6);
      assert.ok(saved.every((call) => call.args.type === 'project'));
      assert.deepEqual(saved.filter((call) => call.args.id).map((call) => call.args.id),
        [firstId, firstId, firstId, nextId]);
      assert.equal(saved.filter((call) => !call.args.id).length, 2);
      assert.ok(saved.filter((call) => !call.args.id).every((call) => call.args.project === scope.projectId));
      for (const update of current.updates) {
        assert.equal(update.project.id, scope.projectId);
        assert.match(update.body, /Payment audit: mismatch[.] Reported: 1; listed: 1; open: 1; unknown: 0; recovered: 0[.] Incomplete: false[.]/);
        assert.equal(saved.filter((call) => call.args.id === update.id).at(-1).args.body, update.body);
      }
      const outputs = [first, retry, next].map((result) => JSON.parse(result.stdout));
      assert.ok(outputs.every((output) => output.result === 'mismatch' && output.complete === true));
      assert.equal(outputs[0].updateURL, outputs[1].updateURL);
      assert.equal(outputs[0].updateURL, current.updates[0].url);
      assert.equal(outputs[2].updateURL, current.updates[1].url);
    });
    await run('reason-ref-shift-and-manual-text', async (home) => {
      const issue = seedIssue('payment:fixture', { status: 'In Progress', statusType: 'started' });
      issue.description += '\nHuman investigation notes stay here.';
      const description = issue.description;
      const human = { id: crypto.randomUUID(), issueId: issue.uuid, body: 'Human note; do not edit.', createdAt: iso(), updatedAt: iso(), attachments: [] };
      current.comments.push(human);
      const humanCopy = structuredClone(human);
      current.window = windowReport([item('payment:fixture', 'refund_not_applied', 'booking.changed')]);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', current.window.items);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(current.issues.length, 1);
      assert.equal(issue.description, description);
      assert.deepEqual(human, humanCopy);
      assert.equal(issue.status, 'In Progress');
      assert.equal(metadata(issue).observations[0].reason, 'refund_not_applied');
    });
    await run('aged-out-unknown-and-exact-recovery', async (home) => {
      const first = seedIssue('payment:fixture');
      const second = seedIssue('booking:missing');
      const firstSeen = metadata(second).firstSeen;
      const lastSeen = metadata(second).lastSeen;
      current.checks['payment:fixture'] = recovered('payment:fixture');
      assert.equal((await invoke(home)).code, 0);
      assert.equal(first.status, 'Done');
      assert.equal(second.status, 'Backlog');
      assert.equal(metadata(second).state, 'unknown');
      assert.equal(metadata(second).firstSeen, firstSeen);
      assert.equal(metadata(second).lastSeen, lastSeen);
      assert.match(current.updates[0].body, /incomplete/);
    });
    await run('canonical-extra-deleted', async (home) => {
      const canonical = seedIssue('payment:fixture');
      const extra = seedIssue('booking:extra');
      current.checks['payment:fixture'] = recovered('payment:fixture');
      current.checks['booking:extra'] = check('booking:extra', 'unresolved', [item('booking:extra', 'payment_record_mismatch')]);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(canonical.status, 'Done');
      assert.equal(extra.status, 'Backlog');
      current.checks['booking:extra'] = check('booking:extra');
      assert.equal((await invoke(home)).code, 0);
      assert.equal(extra.status, 'Backlog');
      assert.equal(metadata(extra).state, 'unknown');
    });
    await run('closed-recurrence-reopen', async (home) => {
      const issue = seedIssue('payment:fixture', { status: 'Done', statusType: 'completed' });
      const originalUUID = issue.uuid;
      current.window = windowReport([fault()]);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
      for (let index = 0; index < 2; index += 1) {
        const auditStart = targetedKeys().length;
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(current.issues.length, 1);
        assert.equal(issue.status, 'Backlog');
        assert.equal(current.issues[0].uuid, originalUUID);
        assert.equal(current.issues.filter((entry) => entry.description.split('\n').includes('Reconciliation key: payment:fixture')).length, 1);
        assert.equal(current.issues.some((entry) => entry.description.split('\n').includes('Reconciliation key: scan:targets')), false);
        const output = JSON.parse(result.stdout);
        assert.equal(output.result, 'mismatch');
        assert.equal(output.complete, true);
        assert.equal(output.unknown, 0);
        assert.deepEqual(targetedKeys().slice(auditStart), ['payment:fixture']);
      }
      assert.equal(current.updates.length, 1);
      assert.deepEqual(writesFor(issue).filter((call) => call.method === 'save_issue').map((call) => call.args),
        [{ id: originalUUID, state: 'Backlog' }]);
    });
    await run('closed-alias-needs-fresh-proof', async (home) => {
      const issue = seedIssue('record:record.fixture', { status: 'Done', statusType: 'completed' }, { keys: ['record:record.fixture', 'payment:fixture'] });
      const originalUUID = issue.uuid;
      current.window = windowReport([fault()]);
      current.checks['record:record.fixture'] = check('record:record.fixture', 'unresolved', [fault()], ['record:record.fixture', 'payment:fixture']);
      for (let index = 0; index < 2; index += 1) {
        const auditStart = targetedKeys().length;
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(current.issues.length, 1);
        assert.equal(issue.status, 'Backlog');
        assert.equal(current.issues[0].uuid, originalUUID);
        assert.equal(current.issues.filter((entry) => entry.description.split('\n').includes('Reconciliation key: record:record.fixture')).length, 1);
        assert.equal(current.issues.some((entry) => entry.description.split('\n').includes('Reconciliation key: scan:targets')), false);
        const output = JSON.parse(result.stdout);
        assert.equal(output.result, 'mismatch');
        assert.equal(output.complete, true);
        assert.equal(output.unknown, 0);
        assert.deepEqual(targetedKeys().slice(auditStart), ['record:record.fixture']);
      }
      assert.equal(current.updates.length, 1);
      assert.deepEqual(writesFor(issue).filter((call) => call.method === 'save_issue').map((call) => call.args),
        [{ id: originalUUID, state: 'Backlog' }]);
    });
    await run('caps-scans-and-held-identity', async (home) => {
      const identity = seedIssue('scan:identity-invalid');
      const items = Array.from({ length: 51 }, (_, index) => item('payment:cap-' + index));
      current.window = windowReport(items, { payments: false, bookings: false, records: false });
      assert.equal((await invoke(home)).code, 0);
      for (const key of ['scan:items', 'scan:dodo-payments', 'scan:dodo-bookings', 'scan:dodo-records']) {
        assert.ok(current.issues.some((issue) => metadata(issue).primary === key));
      }
      assert.equal(JSON.parse(current.runs[0].stdout).reportedCount, 51);
      current.window = windowReport();
      for (let index = 0; index < 50; index += 1) current.checks['payment:cap-' + index] = recovered('payment:cap-' + index, 'cap-' + index);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(identity.status, 'Backlog');
      for (const issue of current.issues.filter((entry) => ['scan:items', 'scan:dodo-payments', 'scan:dodo-bookings', 'scan:dodo-records'].includes(metadata(entry).primary))) assert.equal(issue.status, 'Done');
    });
    await run('target-rotation', async (home) => {
      for (let index = 0; index < 201; index += 1) seedIssue('booking:rotation-' + String(index).padStart(3, '0'), {}, {
        lastCheckedAt: new Date(Date.parse('2026-01-01') + index * 1000).toISOString(),
      });
      assert.equal((await invoke(home)).code, 0);
      const first = current.requests.filter((request) => request.checks).flatMap((request) => request.checks);
      assert.equal(first.length, 200);
      assert.equal(first.includes('booking:rotation-200'), false);
      assert.ok(current.issues.some((issue) => metadata(issue).primary === 'scan:targets'));
      const count = current.requests.length;
      assert.equal((await invoke(home)).code, 0);
      const second = current.requests.slice(count).filter((request) => request.checks).flatMap((request) => request.checks);
      assert.equal(second[0], 'booking:rotation-200');
      assert.equal(second.length, 200);
      assert.ok(current.updates[0].body.endsWith('\nFull issue list: ROO-498'));
      assert.doesNotMatch(current.updates[0].body, /https?:\/\//);
    });
    await run('scan-flags-independent', async (home) => {
      const fields = ['payments', 'bookings', 'records'];
      const issues = fields.map((field) => seedIssue('scan:dodo-' + field));
      const complete = { payments: false, bookings: false, records: false };
      for (let index = 0; index < fields.length; index += 1) {
        complete[fields[index]] = true;
        current.window = windowReport([], complete);
        assert.equal((await invoke(home)).code, 0);
        for (let other = 0; other < issues.length; other += 1) assert.equal(issues[other].status, other <= index ? 'Done' : 'Backlog');
      }
    });
    await run('unverified-closed-alias-held', async (home) => {
      const issue = seedIssue('record:record.fixture', { status: 'Done', statusType: 'completed' }, { keys: ['record:record.fixture', 'payment:fixture'] });
      current.window = windowReport([fault()]);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Done');
      assert.equal(current.issues.filter((entry) => entry.description.includes('Reconciliation key: payment:fixture')).length, 0);
      assert.match(current.updates[0].body, /incomplete/);
    });
    for (const method of ['save_issue', 'save_status_update', 'save_comment']) {
      await run('committed-' + method + '-retry', async (home) => {
        current.window = windowReport([fault()]);
        current.failures.push({ method, commit: true, status: 504 });
        assert.notEqual((await invoke(home)).code, 0);
        current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
        assert.equal((await invoke(home)).code, 0);
        assert.equal(current.issues.length, 1);
        assert.equal(current.updates.length, 1);
        assert.equal(current.comments.length, 1);
      });
    }
    await run('comment-failure-before-close', async (home) => {
      const issue = seedIssue('payment:fixture');
      current.checks['payment:fixture'] = recovered('payment:fixture');
      current.failures.push({ method: 'save_comment' });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Backlog');
    });
    await run('state-failure-retains-retry', async (home) => {
      const issue = seedIssue('payment:fixture');
      current.checks['payment:fixture'] = recovered('payment:fixture');
      current.failures.push({ method: 'save_issue', when: (args) => args.state === 'Done' });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Backlog');
      assert.equal((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Done');
      assert.equal(current.updates.length, 1);
    });
    await run('readback-mismatch', async (home) => {
      const issue = seedIssue('payment:fixture');
      current.checks['payment:fixture'] = recovered('payment:fixture');
      current.failures.push({ method: 'list_comments', when: () => current.calls.some((call) => call.method === 'save_comment'), status: 200,
        body: envelope({ comments: [], hasNextPage: false }) });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Backlog');
    });
    await run('state-readback-mismatch', async (home) => {
      const issue = seedIssue('payment:fixture');
      current.checks['payment:fixture'] = recovered('payment:fixture');
      current.failures.push({ method: 'get_issue', when: () => current.calls.some((call) => call.method === 'save_issue' && call.args.state === 'Done'), status: 200,
        body: envelope({ ...issue, status: 'Backlog', statusType: 'backlog' }) });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(JSON.parse(current.runs[0].stdout).complete, false);
    });
    await run('update-readback-mismatch', async (home) => {
      current.failures.push({ method: 'get_status_updates', when: () => current.calls.some((call) => call.method === 'save_status_update'), status: 200,
        body: envelope({ statusUpdates: [], hasNextPage: false }) });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(current.updates.length, 1);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(current.updates.length, 1);
    });
    await run('partial-cli-payload', async (home) => {
      current.failures.push({ method: 'get_issue', status: 200,
        body: envelope({ id: 'ROO-498', uuid: scope.parentId, projectId: scope.projectId, teamId: scope.teamId, errors: [{ message: 'fixture_partial_failure' }] }) });
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(writes().length, 0);
    });
    await run('duplicate-owned-comment', async (home) => {
      const issue = seedIssue('payment:fixture');
      current.comments.push({ ...structuredClone(current.comments[0]), id: crypto.randomUUID() });
      const original = structuredClone(current.comments);
      current.checks['payment:fixture'] = recovered('payment:fixture');
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Backlog');
      assert.deepEqual(current.comments.filter((comment) => comment.issueId === issue.uuid), original);
    });
    for (const kind of ['project', 'team', 'child', 'parent', 'root-team']) {
      await run('scope-' + kind, async (home) => {
        seedIssue('payment:fixture');
        current.scopeFault = kind;
        assert.notEqual((await invoke(home)).code, 0);
        assert.equal(writes().length, 0);
      });
    }
    for (const kind of ['extra-field', 'pii', 'stale', 'reason', 'status', 'count']) {
      await run('invalid-source-' + kind, async (home) => {
        const issue = seedIssue('payment:fixture');
        current.checks['payment:fixture'] = recovered('payment:fixture');
        current.window = windowReport([fault()]);
        if (kind === 'extra-field') current.window.customer = 'unexpected';
        if (kind === 'pii') current.window.items[0].ref = 'customer@example.invalid';
        if (kind === 'reason') current.window.items[0].reason = 'untrusted_reason';
        if (kind === 'stale') current.window.at = '2020-01-01T00:00:00.000Z';
        if (kind === 'status') current.sourceStatus = 503;
        if (kind === 'count') current.reportedCount = 17;
        assert.notEqual((await invoke(home)).code, 0);
        assert.equal(issue.status, 'Backlog');
        assert.ok(!writes().some((call) => JSON.stringify(call.args).includes('customer@example.invalid')));
      });
    }
    await run('late-batch-failure-no-close', async (home) => {
      const issues = Array.from({ length: 21 }, (_, index) => seedIssue('payment:late-' + index));
      for (let index = 0; index < 21; index += 1) current.checks['payment:late-' + index] = recovered('payment:late-' + index, 'late-' + index);
      let batch = 0;
      current.failures.push({ method: 'checks', when: () => ++batch === 2 });
      assert.notEqual((await invoke(home)).code, 0);
      assert.ok(issues.every((issue) => issue.status === 'Backlog'));
    });
    await run('invalid-canonical-proof-no-close', async (home) => {
      const issue = seedIssue('payment:fixture');
      current.checks['payment:fixture'] = check('payment:fixture', 'recovered', [], ['payment:fixture']);
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Backlog');
    });
    await run('pagination', async (home) => {
      current.pageSize = 2;
      for (let index = 0; index < 5; index += 1) seedIssue('booking:page-' + index);
      assert.equal((await invoke(home)).code, 0);
      assert.ok(current.calls.filter((call) => call.method === 'list_issues').length >= 3);
    });
    await run('bad-pagination-cursor', async (home) => {
      current.pageSize = 1;
      current.duplicateCursor = true;
      for (let index = 0; index < 3; index += 1) seedIssue('booking:page-' + index);
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(writes().length, 0);
    });
    await run('ambiguous-aliases', async (home) => {
      const first = seedIssue('record:record.one', {}, { keys: ['record:record.one', 'payment:fixture'] });
      const second = seedIssue('record:record.two', {}, { keys: ['record:record.two', 'payment:fixture'] });
      current.window = windowReport([fault()]);
      current.checks['record:record.one'] = check('record:record.one', 'unresolved', [fault()], ['record:record.one', 'payment:fixture']);
      current.checks['record:record.two'] = check('record:record.two', 'unresolved', [fault()], ['record:record.two', 'payment:fixture']);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(first.status, 'Backlog');
      assert.equal(second.status, 'Backlog');
      assert.equal(current.issues.filter((issue) => metadata(issue).primary === 'payment:fixture').length, 0);
      assert.ok(current.issues.some((issue) => metadata(issue).primary === 'scan:linear-identity'));
    });
    await run('archived-recurrence', async (home) => {
      const issue = seedIssue('payment:fixture', { archivedAt: iso(), status: 'Done', statusType: 'completed' });
      current.window = windowReport([fault()]);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Done');
      assert.equal(current.issues.filter((entry) => entry.description.includes('Reconciliation key: payment:fixture')).length, 1);
      assert.match(current.updates[0].body, /incomplete/);
    });
    await run('canceled-recurrence-held', async (home) => {
      const issue = seedIssue('payment:fixture', { status: 'Canceled', statusType: 'canceled' });
      current.window = windowReport([fault()]);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [fault()]);
      assert.equal((await invoke(home)).code, 0);
      assert.equal(issue.status, 'Canceled');
      assert.equal(current.issues.filter((entry) => entry.description.includes('Reconciliation key: payment:fixture')).length, 1);
      assert.match(current.updates[0].body, /incomplete/);
    });
    await run('fake-connection-required', async (home) => {
      assert.notEqual((await invoke(home, { env: { ROO_RECONCILE_EXECUTOR_BIN: '/usr/bin/true' } })).code, 0);
      assert.equal(current.calls.length, 0);
      assert.equal(current.requests.length, 0);
    });
    await run('missing-token-records-failure', async (home) => {
      fs.unlinkSync(path.join(home, '.config/roo/reconcile-token'));
      assert.notEqual((await invoke(home)).code, 0);
      assert.equal(current.requests.length, 0);
      assert.equal(current.updates.length, 1);
      assert.match(current.updates[0].body, /unavailable/);
    });
    await run('test-mode-production-origin-refused', async (home) => {
      assert.notEqual((await invoke(home, { env: { ROO_RECONCILE_URL: 'https://www.rooindustries.com/api/payment/report' } })).code, 0);
      assert.equal(current.calls.length, 0);
      assert.equal(current.requests.length, 0);
    });
    await run('curl-origin-guard', async (home) => {
      current.expectedBlocked = 1;
      const result = spawnSync(path.join(bin, 'curl'), ['--url=https://www.rooindustries.com/api/payment/report'], {
        env: { PATH: '/usr/bin:/bin', HOME: home, ROO_RECONCILE_FIXTURE_ORIGIN: origin,
          ROO_RECONCILE_REAL_CURL: actualCurl, ROO_RECONCILE_GUARD_BLOCKED: path.join(home, 'blocked') },
      });
      assert.equal(result.status, 97);
      assert.equal(current.requests.length, 0);
      assert.equal(current.calls.length, 0);
    });
    await run('concurrent-job', async (home) => {
      let enter, release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      current.gate = { enter, release: released };
      const first = invoke(home);
      try {
        await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('First job never reached fixture')), 10000))]);
        assert.equal((await invoke(home)).code, 75);
      } finally { release(); }
      assert.equal((await first).code, 0);
      assert.equal(current.updates.length, 1);
    });
    await run('archived-recovered-record-recurrence', async (home) => {
      current.captureIdentity = true;
      const issue = await firstMismatch(home);
      const recovery = await recoverIdentity(home, issue);
      assertRetainedIdentity(recovery, issue, true);
      assert.equal(metadata(issue).state, 'recovered');
      assert.deepEqual(metadata(issue).keys, recovered('payment:fixture').keys);
      issue.archivedAt = iso();
      const original = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
      current.identityBefore = original;
      const previousWrites = writesFor(issue).length;
      const observation = { ...item('record:record.fixture', 'owner_review_dodo_dispute_lost_owner_review', 'record.fixture'), id: 'fixture' };
      current.window = windowReport([observation]);
      current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [observation], recovered('payment:fixture').keys);
      for (let index = 0; index < 2; index += 1) {
        if (index === 1) ageWindow();
        const result = await invoke(home);
        assert.equal(result.code, 0);
        const output = JSON.parse(result.stdout);
        assert.equal(output.result, 'incomplete', 'An archived recurrence must remain incomplete after its window item ages out');
        assert.equal(output.complete, false);
        assert.equal(result.alert.severity, 'amber');
        assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
        assert.equal(writesFor(issue).length, previousWrites);
        assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, original);
        assert.deepEqual(current.issues.filter((entry) => /^(payment|record|booking):/.test(metadata(entry).primary)).map((entry) => entry.uuid), [issue.uuid]);
      }
      current.checks['payment:fixture'] = recovered('payment:fixture');
      const result = await invoke(home);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).result, 'clear');
      assert.equal(JSON.parse(result.stdout).complete, true);
      assert.equal(result.alert.severity, 'green');
      assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
      assert.equal(writesFor(issue).length, previousWrites);
      assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, original);
      assert.deepEqual(current.issues.filter((entry) => /^(payment|record|booking):/.test(metadata(entry).primary)).map((entry) => entry.uuid), [issue.uuid]);
    });
    await run('archived-recovered-aged-out-unknown', async (home) => {
      current.captureIdentity = true;
      const issue = await firstMismatch(home);
      const recovery = await recoverIdentity(home, issue);
      assertRetainedIdentity(recovery, issue, true);
      issue.archivedAt = iso();
      const original = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
      current.identityBefore = original;
      const previousWrites = writesFor(issue).length;
      ageWindow();
      current.checks['payment:fixture'] = check('payment:fixture');
      const result = await invoke(home);
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.result, 'incomplete');
      assert.equal(output.complete, false);
      assert.ok(output.unknown >= 1);
      assert.equal(result.alert.severity, 'amber');
      assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
      assert.equal(writesFor(issue).length, previousWrites);
      assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, original);
    });
    await run('archived-recovered-positive-audit', async (home) => {
      current.captureIdentity = true;
      const issue = await firstMismatch(home);
      const recovery = await recoverIdentity(home, issue);
      assertRetainedIdentity(recovery, issue, true);
      issue.archivedAt = iso();
      const original = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
      current.identityBefore = original;
      const previousWrites = writesFor(issue).length;
      for (let index = 0; index < 2; index += 1) {
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'clear');
        assert.equal(JSON.parse(result.stdout).complete, true);
        assert.equal(result.alert.severity, 'green');
        assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
        assert.equal(writesFor(issue).length, previousWrites);
        assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, original);
      }
    });
    await run('archived-recovered-target-cap', async (home) => {
      current.captureIdentity = true;
      const archivedAt = iso();
      for (let index = 0; index < 201; index += 1) {
        const id = 'archived-' + String(index).padStart(3, '0');
        const primary = 'payment:' + id;
        const proof = recovered(primary, id);
        const issue = seedIssue(primary, { archivedAt, status: 'Done', statusType: 'completed' }, { state: 'recovered', keys: proof.keys });
        issue.description += '\nHuman investigation remains unchanged.';
        current.checks[primary] = proof;
      }
      const original = structuredClone({ issues: current.issues, comments: current.comments });
      current.identityBefore = original;
      const result = await invoke(home);
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.result, 'incomplete');
      assert.equal(output.complete, false);
      assert.ok(output.unknown >= 1);
      assert.equal(result.alert.severity, 'amber');
      const targets = result.boundary.sourceRequests.flatMap((request) => request.checks || []);
      assert.equal(targets.length, 200);
      assert.equal(new Set(targets).size, 200);
      assert.equal(original.issues.filter((issue) => !targets.includes(metadata(issue).primary)).length, 1);
      const archivedIds = new Set(original.issues.map((issue) => issue.uuid));
      assert.deepEqual({ issues: current.issues.filter((issue) => archivedIds.has(issue.uuid)), comments: current.comments.filter((comment) => archivedIds.has(comment.issueId)) }, original);
      for (const issue of original.issues) assert.equal(writesFor(issue).length, 0);
      const coverage = current.issues.find((issue) => metadata(issue).primary === 'scan:targets');
      assert.ok(coverage);
      assert.equal(coverage.parentId, scope.parentId);
      assert.equal(coverage.projectId, scope.projectId);
      assert.equal(coverage.teamId, scope.teamId);
    });
    for (const late of [false, true]) {
      await run(late ? 'retained-registry-late-list-write-failure' : 'retained-registry-list-write-failure', async (home) => {
        const issue = await firstMismatch(home);
        const file = registryFile(home);
        const snapshot = registrySnapshot(home);
        assert.equal(snapshot.kind, 'file');
        assert.equal(snapshot.uid, process.getuid());
        assert.equal(snapshot.mode & 0o077, 0);
        const before = fs.readFileSync(file, 'utf8');
        const retained = path.join(home, 'retained-registry-last-good.json');
        if (late) {
          seedHumanIssue(null);
          current.pageSize = 1;
        }
        const pageStart = current.listPages.length;
        let changed = false;
        current.beforeIssueList = (args) => {
          if (changed || (late && !args.cursor)) return;
          changed = true;
          fs.renameSync(file, retained);
          fs.mkdirSync(file, { mode: 0o700 });
          current.registryFault = { kind: 'destination-directory', phase: late ? 'list-cursor-page-persist' : 'list-first-page-persist',
            uid: process.getuid(), before, retained: fs.readFileSync(retained, 'utf8'), args: structuredClone(args) };
        };
        const result = await invoke(home);
        assert.equal(changed, true);
        const pages = current.listPages.slice(pageStart);
        assert.equal(pages.length, late ? 2 : 1);
        for (const page of pages) assert.equal(page.response.status, 200);
        assert.equal(Object.hasOwn(pages[0].args, 'cursor'), false);
        const firstPage = JSON.parse(pages[0].response.body.data.content[0].text);
        assert.deepEqual(firstPage.issues.map((entry) => entry.uuid), [issue.uuid]);
        if (late) {
          assert.equal(firstPage.hasNextPage, true);
          assert.equal(firstPage.cursor, issue.uuid);
          assert.equal(pages[1].args.cursor, issue.uuid);
          assert.equal(current.registryFault.args.cursor, issue.uuid);
        } else assert.equal(Object.hasOwn(current.registryFault.args, 'cursor'), false);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /cannot overwrite directory/);
        assert.ok(result.stdout.trim().length > 0, 'Registry list-page failure must emit one stdout JSON result');
        const lines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
        assert.equal(lines.length, 1);
        const output = JSON.parse(lines[0]);
        assertIdentityRefusal(result);
        assert.equal(output.result, 'unavailable');
        assert.equal(output.complete, false);
        assert.deepEqual(result.state, { ...output, version: 1 });
        assert.equal(result.alert.items[0].reason, 'linear_identity_unavailable');
        assert.equal(result.boundary.registryAfter.kind, 'directory');
        assert.equal(result.boundary.registryAfter.mode, 0o700);
        assert.deepEqual(fs.readdirSync(file), []);
        assert.equal(fs.readFileSync(retained, 'utf8'), before);
        assert.equal(current.registryFault.retained, before);
      });
    }
    for (const restoredState of ['unresolved', 'unknown']) {
      await run(restoredState === 'unresolved' ? 'restored-archived-negative-retained' : 'restored-archived-unknown-held', async (home) => {
        current.captureIdentity = true;
        const issue = await firstMismatch(home);
        const recovery = await recoverIdentity(home, issue);
        assertRetainedIdentity(recovery, issue, true);
        assert.equal(metadata(issue).state, 'recovered');
        const original = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
        issue.archivedAt = iso();
        const archived = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
        current.identityBefore = { recovered: original, archived };
        const previousWrites = writesFor(issue).length;
        const observation = { ...item('record:record.fixture', 'owner_review_dodo_dispute_lost_owner_review', 'record.fixture'), id: 'fixture' };
        current.window = windowReport([observation]);
        current.checks['payment:fixture'] = check('payment:fixture', 'unresolved', [observation], recovered('payment:fixture').keys);
        for (let index = 0; index < 2; index += 1) {
          if (index === 1) ageWindow();
          const result = await invoke(home);
          assert.equal(result.code, 0);
          assert.equal(JSON.parse(result.stdout).result, 'incomplete');
          assert.equal(JSON.parse(result.stdout).complete, false);
          assert.equal(result.alert.severity, 'amber');
          assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
          assert.equal(writesFor(issue).length, previousWrites);
          assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, archived);
        }
        issue.archivedAt = null;
        if (restoredState === 'unknown') current.checks['payment:fixture'] = check('payment:fixture');
        current.identityBefore.restored = structuredClone({ issue,
          comments: current.comments.filter((comment) => comment.issueId === issue.uuid), proof: current.checks['payment:fixture'] });
        const result = await invoke(home);
        assert.equal(result.code, 0);
        const output = JSON.parse(result.stdout);
        assert.equal(output.result, restoredState === 'unresolved' ? 'mismatch' : 'incomplete', 'A restored financial identity requires fresh own-primary proof');
        assert.equal(output.complete, restoredState === 'unresolved');
        assert.equal(output.unknown, restoredState === 'unresolved' ? 0 : 1);
        assert.equal(result.alert.severity, restoredState === 'unresolved' ? 'red' : 'amber');
        assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
        assert.equal(issue.status, restoredState === 'unresolved' ? 'Backlog' : 'Done');
        assert.equal(metadata(issue).state, restoredState);
        assert.equal(metadata(issue).primary, 'payment:fixture');
        assert.equal(issue.uuid, original.issue.uuid);
        assert.equal(issue.description, original.issue.description);
        assertRetainedIdentity(result, issue, false);
        if (restoredState === 'unknown') assert.equal(result.boundary.calls.some((call) => call.method === 'save_issue' && call.args.id === issue.uuid), false);
        for (const comment of original.comments.filter((entry) => !entry.body.startsWith('Payment reconciliation status\n'))) {
          assert.deepEqual(current.comments.find((entry) => entry.id === comment.id), comment);
        }
        const scans = current.issues.filter((entry) => ['scan:targets', 'scan:linear-identity'].includes(metadata(entry).primary));
        assert.equal(scans.length, 2);
        for (const scan of scans) {
          const unresolved = restoredState === 'unknown' && metadata(scan).primary === 'scan:targets';
          assert.equal(scan.status, unresolved ? 'Backlog' : 'Done');
          assert.equal(metadata(scan).state, unresolved ? 'unresolved' : 'recovered');
        }
        assert.deepEqual(current.issues.filter((entry) => /^(payment|record|booking):/.test(metadata(entry).primary)).map((entry) => entry.uuid), [issue.uuid]);
        current.checks['payment:fixture'] = recovered('payment:fixture');
        const positive = await invoke(home);
        assert.equal(positive.code, 0);
        assert.equal(JSON.parse(positive.stdout).result, 'clear');
        assert.equal(JSON.parse(positive.stdout).complete, true);
        assert.equal(positive.alert.severity, 'green');
        assert.deepEqual(positive.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
        assert.equal(issue.status, 'Done');
        assert.equal(metadata(issue).state, 'recovered');
        assert.equal(issue.uuid, original.issue.uuid);
        assert.equal(issue.description, original.issue.description);
        assertRetainedIdentity(positive, issue, true);
        for (const comment of original.comments.filter((entry) => !entry.body.startsWith('Payment reconciliation status\n'))) {
          assert.deepEqual(current.comments.find((entry) => entry.id === comment.id), comment);
        }
        for (const scan of scans) assert.equal(scan.status, 'Done');
        assert.deepEqual(current.issues.filter((entry) => /^(payment|record|booking):/.test(metadata(entry).primary)).map((entry) => entry.uuid), [issue.uuid]);
      });
    }
    await run('closed-recovered-positive-no-activity', async (home) => {
      current.captureIdentity = true;
      const issue = await firstMismatch(home);
      const recovery = await recoverIdentity(home, issue);
      assertRetainedIdentity(recovery, issue, true);
      assert.equal(metadata(issue).state, 'recovered');
      const original = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
      current.identityBefore = { closed: original, proof: structuredClone(current.checks['payment:fixture']) };
      const previousWrites = writesFor(issue).length;
      for (let index = 0; index < 2; index += 1) {
        const result = await invoke(home);
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).result, 'clear');
        assert.equal(JSON.parse(result.stdout).complete, true);
        assert.equal(result.alert.severity, 'green');
        assert.deepEqual(result.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture'], 'Closed recovered identities still require an actual fresh target audit');
        assert.equal(writesFor(issue).length, previousWrites);
        assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, original);
      }
      const nextProof = recovered('payment:fixture');
      nextProof.keys = nextProof.keys.map((key) => key === 'booking:booking.fixture' ? 'booking:booking.fixture-next' : key);
      current.checks['payment:fixture'] = nextProof;
      current.identityBefore.nextProof = structuredClone(nextProof);
      const changed = await invoke(home);
      assert.equal(changed.code, 0);
      assert.equal(JSON.parse(changed.stdout).result, 'clear');
      assert.equal(JSON.parse(changed.stdout).complete, true);
      assert.equal(changed.alert.severity, 'green');
      assert.deepEqual(changed.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
      assert.equal(writesFor(issue).length, previousWrites + 1);
      assert.equal(changed.boundary.calls.filter((call) => call.method === 'save_comment' && call.args.id === original.comments.find((entry) => entry.body.startsWith('Payment reconciliation status\n')).id).length, 1);
      assert.equal(changed.boundary.calls.some((call) => call.method === 'save_issue' && call.args.id === issue.uuid), false);
      assert.deepEqual(metadata(issue).keys.slice().sort(), ['payment:fixture', 'record:record.fixture', 'booking:booking.fixture', 'booking:booking.fixture-next'].sort());
      assert.equal(metadata(issue).state, 'recovered');
      assert.deepEqual(issue, original.issue);
      for (const comment of original.comments.filter((entry) => !entry.body.startsWith('Payment reconciliation status\n'))) {
        assert.deepEqual(current.comments.find((entry) => entry.id === comment.id), comment);
      }
      const afterAlias = structuredClone({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) });
      current.identityBefore.afterAlias = afterAlias;
      const unchanged = await invoke(home);
      assert.equal(unchanged.code, 0);
      assert.equal(JSON.parse(unchanged.stdout).result, 'clear');
      assert.equal(JSON.parse(unchanged.stdout).complete, true);
      assert.equal(unchanged.alert.severity, 'green');
      assert.deepEqual(unchanged.boundary.sourceRequests.flatMap((request) => request.checks || []), ['payment:fixture']);
      assert.equal(writesFor(issue).length, previousWrites + 1);
      assert.deepEqual({ issue, comments: current.comments.filter((comment) => comment.issueId === issue.uuid) }, afterAlias);
    });
    await run('closed-recovered-target-cap', async (home) => {
      current.captureIdentity = true;
      for (let index = 0; index < 201; index += 1) {
        const id = 'closed-' + String(index).padStart(3, '0');
        const primary = 'payment:' + id;
        const proof = recovered(primary, id);
        const issue = seedIssue(primary, { status: 'Done', statusType: 'completed' }, { state: 'recovered', keys: proof.keys });
        issue.description += '\nHuman investigation remains unchanged.';
        current.checks[primary] = proof;
      }
      const original = structuredClone({ issues: current.issues, comments: current.comments });
      current.identityBefore = { ...original, checks: structuredClone(current.checks) };
      const result = await invoke(home);
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.result, 'incomplete', 'A closed recovered identity outside the target cap is not freshly recovered');
      assert.equal(output.complete, false);
      assert.equal(output.unknown, 1);
      assert.equal(result.alert.severity, 'amber');
      const targets = result.boundary.sourceRequests.flatMap((request) => request.checks || []);
      assert.equal(targets.length, 200);
      assert.equal(new Set(targets).size, 200);
      assert.equal(original.issues.filter((issue) => !targets.includes(metadata(issue).primary)).length, 1);
      const closedIds = new Set(original.issues.map((issue) => issue.uuid));
      assert.deepEqual({ issues: current.issues.filter((issue) => closedIds.has(issue.uuid)), comments: current.comments.filter((comment) => closedIds.has(comment.issueId)) }, original);
      for (const issue of original.issues) assert.equal(writesFor(issue).length, 0);
      const coverage = current.issues.find((issue) => metadata(issue).primary === 'scan:targets');
      assert.ok(coverage);
      assert.equal(coverage.parentId, scope.parentId);
      assert.equal(coverage.projectId, scope.projectId);
      assert.equal(coverage.teamId, scope.teamId);
    });
  }
} finally {
  for (const child of children) child.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const unexecutedCases = (selected || []).filter((name) => !results.some((result) => result.name === name));
  const evidence = {
    ok: results.length > 0 && unexecutedCases.length === 0 && results.every((result) => result.passed && result.blockedRequests === result.expectedBlockedRequests), scope,
    selectedCases: selected || null, unexecutedCases,
    baselineSha256: baseline ? crypto.createHash('sha256').update(fs.readFileSync(baseline)).digest('hex') : null,
    externalRequests: 0, servicesStopped: true, sourceHashes, results,
  };
  fs.writeFileSync(path.join(artifactDir, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(scratch, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({
    ok: evidence.ok, cases: results.map(({ name, passed, error }) => ({ name, passed, error })),
    artifact: path.join(artifactDir, 'results.json'), servicesStopped: true,
  }) + '\n');
  if (!evidence.ok) process.exitCode = 1;
}

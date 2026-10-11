import { localOrigin } from '../../scripts/lib/test-target-safety.mjs';
import { createHmac } from 'node:crypto';

export const apiRouteSecrets = {
  REF_SESSION_SECRET: 'fixture-only-referral-session-secret',
  HOLD_TOKEN_SECRET: 'fixture-only-booking-hold-secret',
  RATE_LIMIT_HASH_SECRET: 'fixture-only-route-rate-limit-secret',
};

export const referralEmail = 'creator@fixture.invalid';

export function referralSessionCookie(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    rid: 'tooling-referral',
    code: 'fixture-creator',
    pid: 'fixture-principal',
    sv: 1,
    ab: 'supabase',
    iat: now,
    exp: now + 3600,
    ...overrides,
  })).toString('base64url');
  return `${payload}.${createHmac('sha256', apiRouteSecrets.REF_SESSION_SECRET).update(payload).digest('base64url')}`;
}

export function apiFixtureOrigin(baseURL) {
  const target = new URL(localOrigin(baseURL));
  const port = Number(process.env.TOOLING_CONTENT_PORT || Number(target.port) + 1);
  return localOrigin(`http://${target.hostname}:${port}`);
}

export function requestRoute(baseURL, pathname, { data, ...options } = {}) {
  const origin = localOrigin(baseURL);
  const url = new URL(pathname, origin);
  if (url.origin !== origin) throw new Error('Route request must stay on the local app origin.');
  return fetch(url, data === undefined ? options : {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify(data),
  });
}

export async function configureApiFixture(baseURL, values) {
  const response = await requestRoute(apiFixtureOrigin(baseURL), '/__fixture', { data: values });
  if (response.status !== 200) throw new Error(`API fixture configuration failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function readApiFixture(baseURL) {
  const response = await requestRoute(apiFixtureOrigin(baseURL), '/__fixture');
  if (response.status !== 200) throw new Error(`API fixture read failed (${response.status}).`);
  return response.json();
}

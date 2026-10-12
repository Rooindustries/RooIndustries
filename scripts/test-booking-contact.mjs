import { spawnSync } from 'node:child_process';

const env = { NODE_ENV: 'test' };
for (const key of [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PG_BIN', 'POSTGREST_BIN',
  'LD_LIBRARY_PATH', 'ROO_TEST_HOST', 'BOOKING_CONTACT_PORT', 'ROO_TEST_EXCLUDED_MIGRATIONS',
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

const result = spawnSync(process.execPath, ['--test', 'tests/booking-contact.mjs'], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

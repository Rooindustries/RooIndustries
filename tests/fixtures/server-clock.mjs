import fs from 'node:fs';
import { inheritTestProcessGuard } from '../../scripts/lib/test-target-safety.mjs';

if (process.env.TOOLING_NETWORK_GUARD !== '1' || !process.env.TOOLING_CLOCK_FILE) {
  throw new Error('Server clock requires the isolated test fixture.');
}
inheritTestProcessGuard(import.meta.url);

const now = Date.now;
Date.now = () => {
  const time = JSON.parse(fs.readFileSync(process.env.TOOLING_CLOCK_FILE, 'utf8'));
  if (time === null) return now();
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid fixture clock.');
  return time;
};

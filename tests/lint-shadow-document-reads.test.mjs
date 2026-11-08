import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ESLint} from 'eslint';

const eslint = new ESLint();
for (const source of [
  'import {fetchShadowDocuments} from "./supabase/shadowStore.js";',
  'import {fetchShadowDocuments as read} from "./supabase/shadowStore.js";',
  'import * as store from "./supabase/shadowStore.js";',
]) test(`rejects unbatched document access: ${source}`, async () => {
  const [result] = await eslint.lintText(source, {filePath: 'src/server/read.js'});
  assert.ok(result.messages.some(row => row.ruleId === 'no-restricted-imports'));
});
test('allows the shared document reader', async () => {
  const [result] = await eslint.lintText('import {fetchShadowDocuments} from "./shadowStore.js";',
    {filePath: 'src/server/supabase/documentClient.js'});
  assert.equal(result.errorCount, 0);
});

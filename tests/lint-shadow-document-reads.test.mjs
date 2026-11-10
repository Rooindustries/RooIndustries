import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ESLint} from 'eslint';

const eslint = new ESLint();
for (const source of [
  'import {fetchShadowDocuments} from "./supabase/readShadowDocuments.js";',
  'import {fetchShadowDocuments as read} from "./supabase/readShadowDocuments.js";',
  'import * as store from "./supabase/readShadowDocuments.js";',
  'import("./supabase/readShadowDocuments.js");',
  'require("./supabase/readShadowDocuments.js");',
  'client.rpc("roo_fetch_shadow_documents_targeted", {});',
]) test(`rejects unbatched document access: ${source}`, async () => {
  const [result] = await eslint.lintText(source, {filePath: 'src/server/read.js'});
  assert.ok(result.messages.some(row => ['no-restricted-imports', 'no-restricted-syntax'].includes(row.ruleId)));
});
test('allows the shared document reader', async () => {
  const [result] = await eslint.lintText('import {fetchShadowDocuments} from "./readShadowDocuments.js";',
    {filePath: 'src/server/supabase/documentClient.js'});
  assert.equal(result.errorCount, 0);
});

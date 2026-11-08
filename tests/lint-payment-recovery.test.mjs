import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
for (const path of ['flow.js', 'recoveryState.js']) {
  test(`${path} rejects a permanent recovery deadline`, async () => {
    const [result] = await eslint.lintText(
      'const stopped = failures >= 12; const nextRecoveryAt = stopped ? "9999-12-31T23:59:59.999Z" : getNextPaymentRecoveryAt(failures);',
      { filePath: `src/server/api/payment/${path}` },
    );
    assert.equal(result.errorCount, 1);
    assert.match(result.messages[0].message, /Keep payment recovery dates bounded/);
  });
}
test('the shared retry scheduler accepts capped retry dates', async () => {
  const [result] = await eslint.lintFiles('src/server/api/payment/recoveryState.js');
  assert.equal(result.errorCount, 0);
});

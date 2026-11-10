import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ESLint} from 'eslint';

test('the configured linter keeps self-referral decisions at the commission freeze', async () => {
  const eslint = new ESLint();
  const filePath = 'src/server/api/ref/createBooking.js';
  for (const code of [
    'const selfReferral = buyerEmail === creatorEmail;',
    'const pricing = {selfReferral: buyerEmail === creatorEmail};',
    'pricing.selfReferral = true;',
    'pricing["selfReferral"] = true;',
    'const {selfReferral: ownCode} = pricing;',
    'const key = "selfReferral"; pricing[key] = true;',
  ]) {
    const [result] = await eslint.lintText(code, {filePath});
    assert.ok(result.messages.some(message => message.ruleId === 'roo/no-scattered-self-referral'), code);
  }
  const code = 'const selfReferral = buyerEmail === creatorEmail;';
  const [allowed] = await eslint.lintText(code, {filePath: 'src/server/referrals/bookingCommission.js'});
  assert.equal(allowed.errorCount, 0);
  const [caller] = await eslint.lintText('const booking = {...frozen.bookingFields};', {filePath});
  assert.equal(caller.errorCount, 0);
});

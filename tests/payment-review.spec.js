const { test, expect } = require('./fixtures/booking-flow.cjs');

test.use({ javaScriptEnabled: true, timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce' });
const reviewMessage = 'This payment requires manual review. Please contact Roo Industries.';

for (const outcome of ['failed', 'abandoned', 'refunded']) {
  test(`payment review survives reload and retry before showing ${outcome}`, async ({ page, flow }) => {
    let result = { ok: true, provider: 'dodo', status: 'needs_recovery', manualReviewRequired: true,
      recoveryReason: reviewMessage };
    const requests = [];
    for (const endpoint of ['finalize', 'status']) {
      await page.route(`**/api/payment/${endpoint}`, route => {
        requests.push(route.request().headers().authorization);
        return route.fulfill({ status: result.manualReviewRequired ? 202 : 200, json: result });
      });
    }
    await flow.review();
    await flow.payment();
    await page.getByRole('button', { name: 'Pay your way', exact: true }).click();
    await expect(page).toHaveURL(/checkout-handoff$/);
    await page.goto('/payment?dodo_return=1');
    const banner = page.getByRole('status').filter({ hasText: reviewMessage });
    await expect(banner).toBeVisible();
    const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('payment_session_state')));
    const original = await stored();
    expect(original.paymentAccessToken).toBeTruthy();
    await page.reload();
    await expect(banner).toBeVisible();
    expect((await stored()).paymentAccessToken).toBe(original.paymentAccessToken);
    await page.getByRole('button', { name: 'Check payment status', exact: true }).click();
    await expect(banner).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check payment status', exact: true })).toBeEnabled();
    expect((await stored()).paymentAccessToken).toBe(original.paymentAccessToken);
    result = { ok: true, provider: 'dodo', status: outcome, manualReviewRequired: false };
    await page.reload();
    const message = outcome === 'refunded'
      ? 'This payment was refunded. Go back to booking to choose a time.'
      : 'Payment was not completed and the slot was released. Go back to booking to choose a time.';
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
    expect(await stored()).toBeNull();
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.every(token => token === `Bearer ${original.paymentAccessToken}`)).toBe(true);
  });
}

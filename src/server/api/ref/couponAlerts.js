import {Resend} from 'resend';
import {createHash} from 'node:crypto';
import {logSafeError} from '../../safeErrorLog.js';

export async function dispatchCouponAlerts({client, redemptionId = ''}) {
  const result = await client.fetch(
    `*[_type == "couponRedemption" && ownerAlertRequired == true
      && (!defined(ownerAlertSentAt) || ownerAlertSentAt == "")
      && ($id == "" || _id == $id)]${redemptionId ? '[0]' : ''}{...}`,
    {id: redemptionId}
  ).catch(error => {
    logSafeError('Coupon capacity alert lookup failed', error);
    return [];
  });
  const pending = redemptionId ? [result].filter(value => value?.ownerAlertRequired && !value.ownerAlertSentAt) : result;
  if (!Array.isArray(pending)) {
    logSafeError('Coupon capacity alert response invalid', new Error('Expected coupon alert records.'));
    return;
  }
  for (const redemption of pending) {
    try {
      const apiKey = String(process.env.RESEND_API_KEY || '').trim();
      const settings = await client.fetch('*[_type == "bookingSettings"][0]{ownerEmail}');
      const current = await client.fetch('*[_type == $type && _id == $id][0]{...}', {type: 'couponRedemption', id: redemption._id});
      if (current.ownerAlertSentAt) continue;
      const to = String(current.ownerAlertRecipient || settings?.ownerEmail || process.env.OWNER_EMAIL || '').trim();
      const from = String(current.ownerAlertFrom || process.env.FROM_EMAIL || '').trim();
      if (!apiKey || !to || !from) throw new Error('Coupon alert email is not configured.');
      await client.patch(current._id).ifRevisionId(current._rev).set({
        ownerAlertRecipient: to, ownerAlertFrom: from,
      }).commit();
      const result = await new Resend(apiKey).emails.send({
        from, to, subject: 'Paid checkout exceeded a coupon limit',
        text: `A paid checkout kept its coupon discount after the coupon reached its use limit.\nBooking: ${redemption.bookingId}\nCoupon record: ${redemption.coupon?._ref}\nThe buyer keeps the agreed discount.`,
      }, {idempotencyKey: `coupon-capacity/${createHash('sha256').update(redemption._id).digest('hex')}`});
      if (result.error || !result.data?.id) throw new Error('Coupon alert delivery did not return a receipt.');
      const fresh = await client.fetch('*[_type == $type && _id == $id][0]{...}', {type: 'couponRedemption', id: redemption._id});
      if (!fresh.ownerAlertSentAt) await client.patch(fresh._id).ifRevisionId(fresh._rev).set({
        ownerAlertRequired: false, ownerAlertSentAt: new Date().toISOString(), ownerAlertProviderId: result.data.id,
      }).commit();
    } catch (error) {
      logSafeError('Coupon capacity owner alert pending', error);
    }
  }
}

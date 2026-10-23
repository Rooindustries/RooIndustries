import {Resend} from 'resend';
import {createHash} from 'node:crypto';
import {logSafeError} from '../../safeErrorLog.js';

export async function dispatchCouponAlerts({client, redemptionId = ''}) {
  const signal = AbortSignal.timeout(10_000);
  let pending;
  try {
    if (redemptionId) {
      const row = await client.fetch('*[_type == $type && _id == $id][0]{...}', {type: 'couponRedemption', id: redemptionId});
      pending = row?.ownerAlertRequired && !row.ownerAlertSentAt ? [row] : [];
    } else {
      pending = await client.pendingCouponAlerts({limit: 25});
    }
    if (!Array.isArray(pending)) throw new Error('Expected coupon alert records.');
  } catch (error) {
    logSafeError('Coupon capacity alert lookup failed', error);
    return;
  }
  for (const redemption of pending) {
    if (signal.aborted) break;
    try {
      const apiKey = String(process.env.RESEND_API_KEY || '').trim();
      const settings = await client.fetch('*[_type == "bookingSettings"][0]{ownerEmail}');
      const current = await client.fetch('*[_type == $type && _id == $id][0]{...}', {type: 'couponRedemption', id: redemption._id});
      if (!current?.ownerAlertRequired || current.ownerAlertSentAt) continue;
      const to = String(current.ownerAlertRecipient || settings?.ownerEmail || process.env.OWNER_EMAIL || '').trim();
      const from = String(current.ownerAlertFrom || process.env.FROM_EMAIL || '').trim();
      const generation = Number(current.ownerAlertGeneration || 0);
      if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Coupon alert generation is invalid.');
      await client.patch(current._id).ifRevisionId(current._rev).set({
        ownerAlertRecipient: to, ownerAlertFrom: from, ownerAlertLastAttemptAt: new Date().toISOString(),
      }).commit();
      if (!apiKey || !to || !from) throw new Error('Coupon alert email is not configured.');
      const key = `coupon-capacity/${createHash('sha256').update(redemption._id).digest('hex')}`;
      const result = await new Resend(apiKey).emails.send({
        from, to, subject: 'Paid checkout exceeded a coupon limit',
        text: `A paid checkout kept its coupon discount after the coupon reached its use limit.\nBooking: ${redemption.bookingId}\nCoupon record: ${redemption.coupon?._ref}\nThe buyer keeps the agreed discount.`,
      }, {idempotencyKey: generation ? `${key}/${generation}` : key, signal});
      if (['validation_error', 'invalid_from_address'].includes(result.error?.name)) {
        const fresh = await client.fetch('*[_type == $type && _id == $id][0]{...}', {type: 'couponRedemption', id: redemption._id});
        if (!fresh.ownerAlertSentAt && Number(fresh.ownerAlertGeneration || 0) === generation) {
          await client.patch(fresh._id).ifRevisionId(fresh._rev)
            .unset(['ownerAlertFrom']).set({ownerAlertGeneration: generation + 1}).commit();
        }
      }
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

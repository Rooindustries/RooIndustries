import {calculateCreatorCommission} from './commissionMoney.js';
import { inspectDodoCheckout } from '../api/payment/dodoProvider.js';
import { inspectPayPalOrder, inspectRazorpayPayment } from '../api/payment/providerClients.js';

const normalizeEmail = value => {
  const email = String(value || '').trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  let [local, domain] = parts;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replaceAll('.', '');
  return local ? `${local}@${domain}` : '';
};

const resolvePayerIdentity = async (record, booking) => {
  const provider = record.provider || booking.paymentProvider;
  const orderId = record.providerOrderId || booking.paypalOrderId || booking.razorpayOrderId;
  const paymentId = record.providerPaymentId || booking.razorpayPaymentId;
  let email = '';
  if (provider === 'dodo') {
    const result = await inspectDodoCheckout({record});
    if (result.state === 'captured') email = result.payment.customer?.email;
  } else if (provider === 'paypal' && orderId) {
    const result = await inspectPayPalOrder({orderId});
    if (['captured', 'refunded'].includes(result.state) &&
        (!paymentId || result.providerPaymentId === paymentId)) email = result.payerEmail;
  } else if (provider === 'razorpay' && orderId && paymentId) {
    const result = await inspectRazorpayPayment({paymentId});
    if (result.state === 'found' && result.providerOrderId === orderId &&
        ['captured', 'refunded'].includes(result.status)) email = result.payerEmail;
  } else if (provider === 'free') {
    email = booking.email;
  }
  return normalizeEmail(email) ? String(email).trim() : '';
};

export async function freezeBookingCommission({client, pricing, booking, paymentRecord = {}}) {
  const payerEmail = await resolvePayerIdentity(paymentRecord, booking);
  const creatorId = String(pricing.effectiveReferralId || booking.referral?._ref || '').trim();
  const creator = creatorId ? await client.fetch(
    '*[_type == "referral" && _id == $id][0]{creatorEmail}',
    {id: creatorId}
  ) : null;
  const creators = [pricing.referralCreatorEmail, creator?.creatorEmail].map(normalizeEmail).filter(Boolean);
  const selfReferral = pricing.selfReferral === true ||
    [booking.email, payerEmail].map(normalizeEmail).some(email => email && creators.includes(email));
  const held = !!creatorId && !payerEmail;
  const blocked = selfReferral || held;
  const commission = blocked ? {commissionPercent: 0, commissionAmount: 0} : {};
  const snapshot = paymentRecord.pricingSnapshot || pricing;
  const heldCommission = held && !selfReferral ? snapshot.heldCommission || {
    commissionPercent: Number(snapshot.commissionPercent ?? snapshot.effectiveCommissionPercent ?? 0),
    commissionAmount: calculateCreatorCommission(snapshot).originalAmount,
    creatorEmails: creators,
  } : null;
  const heldFields = heldCommission ? {heldCommission} : {};
  const frozenPricing = {
    ...pricing, ...commission, selfReferral, ...heldFields,
    ...(blocked ? {effectiveCommissionPercent: 0} : {}),
  };
  return {
    pricing: frozenPricing,
    pricingSnapshot: {
      ...snapshot, ...commission, ...heldFields,
      ...(selfReferral ? {selfReferral: true} : {}),
      ...(blocked && Object.hasOwn(snapshot, 'effectiveCommissionPercent') ? {effectiveCommissionPercent: 0} : {}),
    },
    bookingFields: {
      payerEmail, selfReferral, ...commission, ...heldFields,
      ...(blocked ? {originalCommissionAmount: 0, dodoOriginalCommissionAmount: 0} : {}),
      ...(held ? {
        referralReviewRequired: true, referralReviewReason: 'payer_identity_unavailable', ownerAlertRequired: true,
      } : {}),
    },
  };
}

export async function reviewBookingCommission({client, booking, decision, payerEmail}) {
  const fail = message => { throw Object.assign(new Error(message), {status: 409}); };
  if (!['release', 'reject'].includes(decision)) fail('Invalid creator review decision.');
  if (booking.referralReviewDecision === decision) {
    if (decision === 'release' && normalizeEmail(payerEmail) !== normalizeEmail(booking.payerEmail)) {
      fail('The reviewed payer identity cannot be changed.');
    }
    return {};
  }
  if (booking.referralReviewRequired !== true || booking.referralReviewReason !== 'payer_identity_unavailable') {
    fail('This booking has no pending payer review.');
  }
  const fields = {
    referralReviewDecision: decision, referralReviewRequired: false,
    referralReviewedAt: new Date().toISOString(), ownerAlertRequired: false,
  };
  if (decision === 'reject') return fields;
  const creator = await client.fetch('*[_type == "referral" && _id == $id][0]{creatorEmail}', {
    id: booking.referral?._ref,
  });
  if (!normalizeEmail(payerEmail) || !normalizeEmail(creator?.creatorEmail)) {
    fail('Verified payer and creator emails are required.');
  }
  const creatorEmails = [creator.creatorEmail, ...(booking.heldCommission?.creatorEmails || [])].map(normalizeEmail);
  if (booking.selfReferral || [booking.email, payerEmail].some(email => creatorEmails.includes(normalizeEmail(email)))) {
    fail('Creator commission cannot be released for a self-referral.');
  }
  const terms = booking.heldCommission;
  if (!terms || !Number.isFinite(terms.commissionPercent) || !Number.isFinite(terms.commissionAmount)) {
    fail('Frozen creator commission is missing.');
  }
  const commission = calculateCreatorCommission({...booking, ...terms}, {
    refundedAmount: booking.refundedAmount || 0,
    paidAmount: booking.dodoTotalAmount ?? booking.netAmount,
    blocked: booking.dodoDisputeActive === true,
  });
  return {
    ...fields, commissionPercent: terms.commissionPercent,
    commissionAmount: commission.amount, originalCommissionAmount: commission.originalAmount,
    dodoOriginalCommissionAmount: commission.originalAmount,
  };
}

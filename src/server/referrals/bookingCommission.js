const normalizeEmail = value => {
  const email = String(value || '').trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  let [local, domain] = parts;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replaceAll('.', '');
  return local ? `${local}@${domain}` : '';
};

export async function freezeBookingCommission({client, pricing, buyerEmail, payerEmail}) {
  const creatorId = String(pricing.effectiveReferralId || '').trim();
  if (!creatorId) return pricing;
  const creator = await client.fetch(
    '*[_type == "referral" && _id == $id][0]{creatorEmail}',
    {id: creatorId}
  );
  const creators = [pricing.referralCreatorEmail, creator?.creatorEmail].map(normalizeEmail).filter(Boolean);
  const selfReferral = pricing.selfReferral === true ||
    [buyerEmail, payerEmail].map(normalizeEmail).some(email => email && creators.includes(email));
  return selfReferral ? {
    ...pricing, selfReferral: true, effectiveCommissionPercent: 0,
    commissionPercent: 0, commissionAmount: 0,
  } : pricing;
}

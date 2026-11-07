const normalizeEmail = value => {
  const email = String(value || '').trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  let [local, domain] = parts;
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return local ? `${local}@${domain}` : '';
};

export async function freezeBookingCommission({client, pricing, buyerEmail}) {
  const creatorId = String(pricing.effectiveReferralId || '').trim();
  if (!creatorId) return pricing;
  const creator = await client.fetch(
    '*[_type == "referral" && _id == $id][0]{creatorEmail}',
    {id: creatorId}
  );
  const buyer = normalizeEmail(buyerEmail);
  const selfReferral = pricing.selfReferral === true ||
    (buyer && buyer === normalizeEmail(pricing.referralCreatorEmail || creator?.creatorEmail));
  return selfReferral ? {
    ...pricing, selfReferral: true, effectiveCommissionPercent: 0,
    commissionPercent: 0, commissionAmount: 0,
  } : pricing;
}

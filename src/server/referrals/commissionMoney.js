const decimal = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!Number.isFinite(Number(value))) return null;
  const match = String(value).replace(/^ +| +$/g, '').match(typeof value === 'number' ? /^(-?)([0-9]+)(?:[.]([0-9]+))?(?:e([+-]?[0-9]+))?$/i : /^(-?)([0-9]+)(?:[.]([0-9]+))?$/);
  if (!match) return null;
  const scale = (match[3] || '').length - Number(match[4] || 0);
  if (Math.abs(scale) > 400) return null;
  return {
    n: BigInt(`${match[1]}${match[2]}${match[3] || ''}`) * 10n ** BigInt(Math.max(0, -scale)),
    d: 10n ** BigInt(Math.max(0, scale)),
  };
};

const rounded = (n, d) => {
  const magnitude = n < 0n ? -n : n;
  const result = (2n * magnitude + d) / (2n * d);
  return n < 0n ? -result : result;
};
const cents = value => {
  const parsed = decimal(value);
  return parsed ? rounded(parsed.n * 100n, parsed.d) : 0n;
};

export function calculateCreatorCommission(terms = {}, {
  originalAmount,
  paidAmount = terms.netAmount ?? terms.effectiveNetAmount,
  refundedAmount = 0,
  additionalRefundAmount = 0,
  currencyFactor = 100,
  blocked = false,
} = {}) {
  const gross = terms.grossAmount ?? terms.effectiveGrossAmount;
  const base = terms.commissionBaseAmount == null
    ? (decimal(gross) ? cents(gross) - cents(terms.couponDiscountAmount) : cents(paidAmount))
    : cents(terms.commissionBaseAmount);
  const percent = decimal(terms.commissionPercent ?? terms.effectiveCommissionPercent);
  const stored = decimal(originalAmount ?? terms.commissionAmount);
  const originalCents = stored ? cents(originalAmount ?? terms.commissionAmount)
    : percent ? rounded((base < 0n ? 0n : base) * percent.n, percent.d * 100n) : 0n;
  const units = value => {
    const parsed = decimal(value);
    return parsed ? rounded(parsed.n * BigInt(currencyFactor), parsed.d) : 0n;
  };
  const paid = units(paidAmount);
  const refund = units(refundedAmount) + units(additionalRefundAmount);
  let earnedCents = originalCents;
  if (blocked) earnedCents = 0n;
  else if (refund > 0n) {
    const retained = paid - refund;
    earnedCents = retained <= 0n ? 0n : rounded(originalCents * retained, paid);
  }
  return {
    baseAmount: Number(base < 0n ? 0n : base) / 100,
    originalAmount: Number(originalCents) / 100,
    amount: Number(earnedCents) / 100,
    refundedAmount: Number(refund) / currencyFactor,
  };
}

export function sumCreatorCommissions(bookings = []) {
  let total = { n: 0n, d: 1n };
  for (const booking of bookings) {
    let earned;
    if (String(booking.commissionCalculationVersion) === '2') {
      earned = decimal(calculateCreatorCommission(booking).amount);
    } else {
      const stored = decimal(booking.commissionAmount);
      if (stored && (stored.n !== 0n || (booking.legacyCommissionZeroIsFrozen ?? Object.hasOwn(booking, 'dodoOriginalCommissionAmount')))) earned = stored;
      else {
        const net = decimal(booking.netAmount);
        const base = net?.n ? net : decimal(booking.grossAmount);
        const percent = decimal(booking.commissionPercent);
        earned = base && percent ? { n: base.n * percent.n, d: base.d * percent.d * 100n } : null;
      }
    }
    if (!earned) continue;
    const denominator = total.d > earned.d ? total.d : earned.d;
    total = { n: total.n * (denominator / total.d) + earned.n * (denominator / earned.d), d: denominator };
  }
  return Number(rounded(total.n * 100n, total.d)) / 100;
}

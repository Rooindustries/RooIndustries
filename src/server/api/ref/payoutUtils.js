import { sumCreatorCommissions } from '../../referrals/commissionMoney.js';

export function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function normalizePackageTitle(title = '') {
  const raw = String(title || '').trim();
  if (!raw) return 'Unknown';
  return raw.replace(/\s*\(upgrade\)\s*$/i, '').trim();
}

export function classifyPackage(packageTitle = '') {
  const normalized = String(packageTitle || '').toLowerCase();

  if (
    normalized.includes('xoc') ||
    normalized.includes('extreme overclock') ||
    normalized.includes('performance vertex max')
  ) {
    return 'xoc';
  }

  if (
    normalized.includes('vertex') ||
    normalized.includes('performance vertex') ||
    normalized.includes('pvo')
  ) {
    return 'vertex';
  }

  return 'vertex';
}

export function computeEarningsFromBookings(bookings = []) {
  const byPackage = new Map();
  const groups = { xoc: [], vertex: [] };
  for (const booking of bookings) {
    const title = normalizePackageTitle(booking?.packageTitle);
    if (!byPackage.has(title)) byPackage.set(title, []);
    byPackage.get(title).push(booking);
    groups[classifyPackage(title)].push(booking);
  }
  return {
    xoc: sumCreatorCommissions(groups.xoc),
    vertex: sumCreatorCommissions(groups.vertex),
    total: sumCreatorCommissions(bookings),
    byPackage: Object.fromEntries([...byPackage].map(([title, rows]) => [title, sumCreatorCommissions(rows)])),
  };
}

export async function fetchReferralEarnings({ client, referralId, referralCode }) {
  const code = typeof referralCode === "string" ? referralCode.toLowerCase() : "";
  if (typeof client?.referralEarnings === "function") {
    const summary = await client.referralEarnings({ referralId, referralCode: code });
    if (summary !== null && summary !== undefined) {
      return {
        xoc: normalizeNumber(summary?.xoc),
        vertex: normalizeNumber(summary?.vertex),
        total: normalizeNumber(summary?.total),
        byPackage:
          summary?.byPackage && typeof summary.byPackage === "object"
            ? summary.byPackage
            : {},
      };
    }
  }
  const bookings = await client.fetch(
    `*[_type == "booking"
        && status in ["captured", "completed"]
        && (
          referral._ref == $id
          || ($code != "" && coalesce(referral._ref, "") == ""
            && !(referralAttributionVersion in [2, "2"])
            && defined(referralCode) && lower(referralCode) == $code)
        )
      ]{
        _id,
        packageTitle,
        commissionAmount,
        commissionPercent,
        netAmount,
        grossAmount,
        couponDiscountAmount,
        commissionBaseAmount,
        commissionCalculationVersion,
        dodoOriginalCommissionAmount
      }`,
    { id: referralId, code }
  );
  for (const booking of bookings || []) {
    if (String(booking.commissionCalculationVersion) !== '2' && booking._id &&
        booking.commissionAmount != null && Number(booking.commissionAmount) === 0) {
      const source = await client.fetch('*[_id == $id][0]', { id: booking._id });
      if (!source) throw new Error('Historical commission source is unavailable.');
      booking.legacyCommissionZeroIsFrozen = Object.hasOwn(source, 'dodoOriginalCommissionAmount');
    }
  }
  return computeEarningsFromBookings(bookings || []);
}

export function sumPayments(payments = []) {
  const total = payments.reduce(
    (sum, p) => sum + normalizeNumber(p?.amount),
    0
  );

  return +total.toFixed(2);
}

function roundMoney(value) {
  return +normalizeNumber(value).toFixed(2);
}

function positiveMoney(value) {
  return Math.max(0, roundMoney(value));
}

export function buildBalance(earnings = {}, paidXoc = 0, paidVertex = 0, referral = {}) {
  const earnedXoc = roundMoney(earnings.xoc);
  const earnedVertex = roundMoney(earnings.vertex);
  const earnedTotal = roundMoney(earnings.total || earnedXoc + earnedVertex);
  const paidXocTotal = roundMoney(paidXoc);
  const paidVertexTotal = roundMoney(paidVertex);
  const paidTotal = roundMoney(paidXocTotal + paidVertexTotal);
  const protectedXoc = normalizeNumber(referral.emptyCodeProtectedPaidXoc);
  const protectedVertex = normalizeNumber(referral.emptyCodeProtectedPaidVertex);
  const remainingXoc = roundMoney(earnedXoc - paidXocTotal + protectedXoc);
  const remainingVertex = roundMoney(earnedVertex - paidVertexTotal + protectedVertex);
  const remainingTotal = roundMoney(earnedTotal - paidTotal + protectedXoc + protectedVertex);
  const pending = referral.registrationStatus === 'pending_email';
  const reviewXoc = positiveMoney(normalizeNumber(referral.emptyCodeReviewXoc) - protectedXoc);
  const reviewVertex = positiveMoney(normalizeNumber(referral.emptyCodeReviewVertex) - protectedVertex);

  return {
    payments: {
      xoc: paidXocTotal,
      vertex: paidVertexTotal,
      total: paidTotal,
    },
    remaining: {
      xoc: remainingXoc,
      vertex: remainingVertex,
      total: remainingTotal,
    },
    owed: {
      xoc: pending ? 0 : positiveMoney(remainingXoc),
      vertex: pending ? 0 : positiveMoney(remainingVertex),
      total: pending ? 0 : positiveMoney(remainingTotal),
    },
    underReview: {
      xoc: roundMoney(reviewXoc + (pending ? positiveMoney(remainingXoc) : 0)),
      vertex: roundMoney(reviewVertex + (pending ? positiveMoney(remainingVertex) : 0)),
      total: roundMoney(reviewXoc + reviewVertex + (pending ? positiveMoney(remainingTotal) : 0)),
    },
    overpaid: {
      xoc: positiveMoney(-remainingXoc),
      vertex: positiveMoney(-remainingVertex),
      total: positiveMoney(-remainingTotal),
    },
  };
}

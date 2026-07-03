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
  const totals = {xoc: 0, vertex: 0, total: 0};
  const byPackage = {};

  bookings.forEach((booking) => {
    const packageTitle = normalizePackageTitle(booking?.packageTitle);
    const pkg = classifyPackage(packageTitle);
    const commissionAmount = normalizeNumber(booking?.commissionAmount);
    const commissionPercent = normalizeNumber(booking?.commissionPercent);
    const base =
      normalizeNumber(booking?.netAmount) ||
      normalizeNumber(booking?.grossAmount);

    const earned =
      commissionAmount ||
      +(base * ((commissionPercent || 0) / 100 || 0)).toFixed(2);

    if (packageTitle) {
      byPackage[packageTitle] =
        normalizeNumber(byPackage[packageTitle]) + normalizeNumber(earned);
    }

    totals[pkg] += earned;
    totals.total += earned;
  });

  return {
    xoc: +totals.xoc.toFixed(2),
    vertex: +totals.vertex.toFixed(2),
    total: +totals.total.toFixed(2),
    byPackage: Object.keys(byPackage).reduce((acc, key) => {
      acc[key] = +byPackage[key].toFixed(2);
      return acc;
    }, {}),
  };
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

export function buildBalance(earnings = {}, paidXoc = 0, paidVertex = 0) {
  const earnedXoc = roundMoney(earnings.xoc);
  const earnedVertex = roundMoney(earnings.vertex);
  const earnedTotal = roundMoney(earnings.total || earnedXoc + earnedVertex);
  const paidXocTotal = roundMoney(paidXoc);
  const paidVertexTotal = roundMoney(paidVertex);
  const paidTotal = roundMoney(paidXocTotal + paidVertexTotal);
  const remainingXoc = roundMoney(earnedXoc - paidXocTotal);
  const remainingVertex = roundMoney(earnedVertex - paidVertexTotal);
  const remainingTotal = roundMoney(earnedTotal - paidTotal);

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
      xoc: positiveMoney(remainingXoc),
      vertex: positiveMoney(remainingVertex),
      total: positiveMoney(remainingTotal),
    },
    overpaid: {
      xoc: positiveMoney(-remainingXoc),
      vertex: positiveMoney(-remainingVertex),
      total: positiveMoney(-remainingTotal),
    },
  };
}

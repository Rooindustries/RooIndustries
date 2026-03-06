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

  if (normalized.includes('xoc') || normalized.includes('extreme overclock')) {
    return 'xoc';
  }

  if (
    normalized.includes('vertex') ||
    normalized.includes('performance vertex') ||
    normalized.includes('pvo')
  ) {
    return 'vertex';
  }

  // default fallback
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

export function buildBalance(earnings, paidXoc, paidVertex) {
  const remainingXoc = +(earnings.xoc - paidXoc).toFixed(2);
  const remainingVertex = +(earnings.vertex - paidVertex).toFixed(2);
  const remainingTotal = +(remainingXoc + remainingVertex).toFixed(2);

  return {
    payments: {
      xoc: paidXoc,
      vertex: paidVertex,
      total: +(paidXoc + paidVertex).toFixed(2),
    },
    remaining: {
      xoc: remainingXoc,
      vertex: remainingVertex,
      total: remainingTotal,
    },
  };
}

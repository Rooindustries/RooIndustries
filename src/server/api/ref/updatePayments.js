import {createDataClient as createClient} from '../../data/documentClient.js';
import {createHash} from 'crypto';
import {requireAdminKey} from './auth.js';
import {logSafeError} from '../../safeErrorLog.js';
import {calculateCreatorCommission} from '../../referrals/commissionMoney.js';
import {
  buildBalance,
  fetchReferralEarnings,
  sumPayments,
} from './payoutUtils.js';

const readClient = createClient({}, {domain: 'commerce'});

const writeClient = createClient({}, {domain: 'commerce'});

const MAX_PAYMENT_UPDATE_ATTEMPTS = 3;

const isRevisionConflict = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const fetchReferral = (referralId) =>
  writeClient.fetch(
    `*[_type == "referral" && _id == $id][0]{
      _id,
      _rev,
      name,
      slug,
      paypalEmail,
      contactDiscord,
      contactTelegram,
      contactPhone,
      xocPayments,
      vertexPayments
    }`,
    {id: referralId}
  );

const buildPaymentUpdate = ({
  referral,
  packageType,
  entry,
  entryId,
  earnings,
}) => {
  const payments =
    packageType === 'xoc'
      ? [...(referral.xocPayments || [])]
      : [...(referral.vertexPayments || [])];
  const existingIndex = payments.findIndex(
    (payment) => payment?._key === entryId
  );

  if (entryId && existingIndex >= 0) {
    payments[existingIndex] = {...payments[existingIndex], ...entry};
  } else {
    payments.push(entry);
  }

  const xocPayments =
    packageType === 'xoc' ? payments : referral.xocPayments || [];
  const vertexPayments =
    packageType === 'vertex' ? payments : referral.vertexPayments || [];
  const paidXoc = sumPayments(xocPayments);
  const paidVertex = sumPayments(vertexPayments);
  const balance = buildBalance(earnings, paidXoc, paidVertex);

  return {
    xocPayments,
    vertexPayments,
    paidXoc,
    paidVertex,
    balance,
  };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ok: false, error: 'Method not allowed'});
  }

  try {
    const {
      referralId,
      packageType,
      amount,
      paidOn,
      note = '',
      entryId,
      payoutId,
      internalNotes,
    } = req.body || {};

    if (!requireAdminKey(req, res)) return;

    if (!referralId) {
      return res
        .status(400)
        .json({ok: false, error: 'Missing referral creator id'});
    }

    if (!packageType || !['xoc', 'vertex'].includes(packageType)) {
      return res
        .status(400)
        .json({ok: false, error: 'packageType must be "xoc" or "vertex"'});
    }

    const numericAmount = Number(amount);
    const roundedAmount = calculateCreatorCommission({commissionAmount: numericAmount}).amount;
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || roundedAmount !== numericAmount || !Number.isSafeInteger(Math.round(numericAmount * 100))) {
      return res
        .status(400)
        .json({ok: false, error: 'Amount must be a positive number'});
    }

    const paymentDate = paidOn ? new Date(paidOn) : new Date();
    if (isNaN(paymentDate.getTime())) {
      return res
        .status(400)
        .json({ok: false, error: 'Invalid payment date supplied'});
    }

    const suppliedKeys = [payoutId, req.headers?.['idempotency-key'], entryId].filter(value => value != null && value !== '');
    const key = suppliedKeys[0];
    if (typeof key !== 'string' || !key.trim() || key.length > 256 || suppliedKeys.some(value => value !== key)) {
      return res.status(400).json({ok: false, error: 'Supply the same stable payoutId for every attempt to record a transfer.'});
    }

    let referral = await fetchReferral(referralId);

    if (!referral) {
      return res.status(404).json({ok: false, error: 'Referral not found'});
    }

    const entry = {
      _key: key,
      _type: packageType === 'xoc' ? 'paymentLogXoc' : 'paymentLogVertex',
      amount: roundedAmount,
      paidOn: paymentDate.toISOString(),
      ...(note ? {note: String(note)} : {}),
    };
    const receiptId = `creatorPayout.${createHash('sha256').update(key).digest('hex')}`;
    const requestHash = createHash('sha256').update(JSON.stringify({
      referralId, packageType, amount: roundedAmount,
      paidOn: paidOn ? paymentDate.toISOString() : null,
      note: String(note || ''), internalNotes: typeof internalNotes === 'string' ? internalNotes : null,
    })).digest('hex');

    const code = (referral?.slug?.current || '').toLowerCase();
    const [earnings, packages] = await Promise.all([
      fetchReferralEarnings({
        client: readClient,
        referralId,
        referralCode: code,
      }),
      readClient.fetch(
        `*[_type == "package"] | order(coalesce(order, 999) asc, title asc){
          title,
          order
        }`
      ),
    ]);

    const earningsByPackage = earnings.byPackage || {};
    const packageBreakdown = (Array.isArray(packages) ? packages : []).map(
      (pkg) => ({
        title: pkg?.title || 'Package',
        amount: earningsByPackage[pkg?.title] || 0,
      })
    );

    if (earningsByPackage) {
      Object.keys(earningsByPackage).forEach((title) => {
        const exists = packageBreakdown.some((item) => item.title === title);
        if (!exists) {
          packageBreakdown.push({
            title,
            amount: earningsByPackage[title],
          });
        }
      });
    }

    let committedUpdate = null;
    for (let attempt = 0; attempt <= MAX_PAYMENT_UPDATE_ATTEMPTS; attempt += 1) {
      const receipt = await writeClient.getDocument(receiptId);
      if (receipt && receipt.requestHash !== requestHash) {
        return res.status(409).json({ok: false, error: 'This payoutId already records a different transfer.'});
      }
      if (receipt) {
        referral = await fetchReferral(referralId);
        committedUpdate = buildPaymentUpdate({referral, packageType, entry: receipt.paymentEntry, entryId: key, earnings});
        break;
      }
      if (attempt === MAX_PAYMENT_UPDATE_ATTEMPTS) break;
      if ([...(referral.xocPayments || []), ...(referral.vertexPayments || [])].some(payment => payment?._key === key)) {
        return res.status(409).json({ok: false, error: 'This key belongs to an existing payment log. Use a new payoutId for a new transfer.'});
      }
      const update = buildPaymentUpdate({
        referral,
        packageType,
        entry,
        entryId: key,
        earnings,
      });
      const {payments: paymentsTotal, owed} = update.balance;
      const patch = writeClient
        .patch(referralId)
        .ifRevisionId(referral._rev)
        .set({
          xocPayments: update.xocPayments,
          vertexPayments: update.vertexPayments,
          earnedXoc: earnings.xoc,
          earnedVertex: earnings.vertex,
          earnedTotal: earnings.total,
          paidXoc: update.paidXoc,
          paidVertex: update.paidVertex,
          paidTotal: paymentsTotal.total,
          owedXoc: owed.xoc,
          owedVertex: owed.vertex,
          owedTotal: owed.total,
        });

      if (typeof internalNotes === 'string') {
        patch.set({notes: internalNotes});
      }

      try {
        await writeClient.transaction().create({
          _id: receiptId, _type: 'creatorPayout', referralId, packageType, amount: roundedAmount,
          creator: {_type: 'reference', _ref: referralId}, paidAt: entry.paidOn,
          requestHash, paymentEntry: entry,
        }).patch(referralId, () => patch).commit();
        committedUpdate = update;
        break;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;

        referral = await fetchReferral(referralId);
        if (!referral) {
          return res.status(404).json({ok: false, error: 'Referral not found'});
        }
      }
    }

    if (!committedUpdate) {
      return res.status(409).json({
        ok: false,
        error: 'Payment data changed while saving. Please try again.',
      });
    }

    const {
      xocPayments: nextXocPayments,
      vertexPayments: nextVertexPayments,
      balance: {payments: paymentsTotal, remaining, owed, overpaid},
    } = committedUpdate;

    return res.status(200).json({
      ok: true,
      referral: {
        _id: referral._id,
        name: referral.name,
        slug: referral.slug,
        paypalEmail: referral.paypalEmail,
        contactDiscord: referral.contactDiscord || '',
        contactTelegram: referral.contactTelegram || '',
        contactPhone: referral.contactPhone || '',
      },
      earnings,
      packageBreakdown,
      payments: paymentsTotal,
      remaining,
      owed,
      overpaid,
      logs: {
        xoc: nextXocPayments,
        vertex: nextVertexPayments,
      },
    });
  } catch (err) {
    if (isRevisionConflict(err)) {
      return res.status(409).json({ok: false, error: 'Payment data changed while saving. Please try again.'});
    }
    logSafeError('Referral payment update failed', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
}

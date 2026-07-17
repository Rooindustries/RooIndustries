import {createDataClient as createClient} from '../../data/documentClient.js';
import {randomUUID} from 'crypto';
import {requireAdminKey} from './auth.js';
import {logSafeError} from '../../safeErrorLog.js';
import {
  buildBalance,
  fetchReferralEarnings,
  sumPayments,
} from './payoutUtils.js';

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: process.env.SANITY_API_VERSION || '2023-10-01',
  token: process.env.SANITY_READ_TOKEN || process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  perspective: 'published',
}, {domain: 'commerce'});

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: process.env.SANITY_API_VERSION || '2023-10-01',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, {domain: 'commerce'});

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
      entryId = '',
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
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
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

    let referral = await fetchReferral(referralId);

    if (!referral) {
      return res.status(404).json({ok: false, error: 'Referral not found'});
    }

    const key = entryId || randomUUID();
    const entry = {
      _key: key,
      _type: packageType === 'xoc' ? 'paymentLogXoc' : 'paymentLogVertex',
      amount: +numericAmount.toFixed(2),
      paidOn: paymentDate.toISOString(),
      ...(note ? {note: String(note)} : {}),
    };

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
    for (let attempt = 0; attempt < MAX_PAYMENT_UPDATE_ATTEMPTS; attempt += 1) {
      const update = buildPaymentUpdate({
        referral,
        packageType,
        entry,
        entryId,
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
        await patch.commit();
        committedUpdate = update;
        break;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        if (attempt === MAX_PAYMENT_UPDATE_ATTEMPTS - 1) break;

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
    logSafeError('Referral payment update failed', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
}

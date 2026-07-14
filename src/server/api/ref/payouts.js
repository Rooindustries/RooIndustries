import {
  createCommerceReadClient,
  createCommerceWriteClient,
} from './sanity.js';
import {requireReferralSession} from './auth.js';
import {getSafeErrorCode, logSafeError} from '../../safeErrorLog.js';
import {
  buildBalance,
  fetchReferralEarnings,
  sumPayments,
} from './payoutUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ok: false, error: 'Method not allowed'});
  }

  try {
    const session = await requireReferralSession(req, res);
    if (!session) return;
    const id = session.referralId;
    const readClient = createCommerceReadClient();

    const referral = await readClient.fetch(
      `*[_type == "referral" && _id == $id][0]{
        _id,
        name,
        slug,
        paypalEmail,
        contactDiscord,
        contactTelegram,
        contactPhone,
        xocPayments,
        vertexPayments
      }`,
      {id}
    );

    if (!referral) {
      return res.status(404).json({ok: false, error: 'Referral not found'});
    }

    const code = (referral.slug?.current || '').toLowerCase();

    const earnings = await fetchReferralEarnings({
      client: readClient,
      referralId: id,
      referralCode: code,
    });

    const packages = await readClient.fetch(
      `*[_type == "package"] | order(coalesce(order, 999) asc, title asc){
        title,
        order
      }`
    );

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

    const xocPayments = referral.xocPayments || [];
    const vertexPayments = referral.vertexPayments || [];

    const paidXoc = sumPayments(xocPayments);
    const paidVertex = sumPayments(vertexPayments);

    const {payments, remaining, owed, overpaid} = buildBalance(
      earnings,
      paidXoc,
      paidVertex
    );

    let syncStatus = {attempted: false, success: false, error: ''};

    if (referral._id) {
      syncStatus.attempted = true;
      try {
        const writeClient = createCommerceWriteClient();
        await writeClient
          .patch(referral._id)
          .set({
            earnedXoc: earnings.xoc,
            earnedVertex: earnings.vertex,
            earnedTotal: earnings.total,
            paidXoc,
            paidVertex,
            paidTotal: payments.total,
            owedXoc: owed.xoc,
            owedVertex: owed.vertex,
            owedTotal: owed.total,
          })
          .commit({autoGenerateArrayKeys: true});
        syncStatus.success = true;
      } catch (err) {
        logSafeError('Referral payout auto-sync failed', err);
        syncStatus.error = getSafeErrorCode(err, 'sync_failed');
      }
    }

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
      payments,
      remaining,
      owed,
      overpaid,
      logs: {
        xoc: xocPayments,
        vertex: vertexPayments,
      },
      sync: syncStatus,
    });
  } catch (err) {
    logSafeError('Referral payout read failed', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
}

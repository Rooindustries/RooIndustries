import {createClient} from '@sanity/client';
import {
  buildBalance,
  computeEarningsFromBookings,
  sumPayments,
} from './payoutUtils.js';

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: process.env.SANITY_API_VERSION || '2023-10-01',
  useCdn: false,
  perspective: 'published',
});

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: process.env.SANITY_API_VERSION || '2023-10-01',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const ADMIN_KEY = process.env.REF_ADMIN_KEY || process.env.REFERRAL_ADMIN_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ok: false, error: 'Method not allowed'});
  }

  try {
    const {referralId, adminKey} = req.body || {};

    // Admin key is now optional to simplify local usage. If you set one, we still enforce it.
    if (ADMIN_KEY && adminKey !== ADMIN_KEY) {
      return res
        .status(403)
        .json({ok: false, error: 'Invalid admin key'});
    }

    if (!process.env.SANITY_WRITE_TOKEN) {
      return res
        .status(500)
        .json({ok: false, error: 'SANITY_WRITE_TOKEN missing on server'});
    }

    if (!referralId) {
      return res
        .status(400)
        .json({ok: false, error: 'Missing referral creator id'});
    }

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
      {id: referralId}
    );

    if (!referral) {
      return res.status(404).json({ok: false, error: 'Referral not found'});
    }

    const code = (referral?.slug?.current || '').toLowerCase();
    const bookings = await readClient.fetch(
      `*[_type == "booking"
          && status in ["captured", "completed"]
          && (
            referral._ref == $id
            || (defined(referralCode) && lower(referralCode) == $code)
          )
        ]{
          packageTitle,
          commissionAmount,
          commissionPercent,
          netAmount,
          grossAmount
        }`,
      {id: referralId, code}
    );

    const earnings = computeEarningsFromBookings(bookings || []);

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

    const paidXoc = sumPayments(referral?.xocPayments || []);
    const paidVertex = sumPayments(referral?.vertexPayments || []);

    const {payments, remaining} = buildBalance(earnings, paidXoc, paidVertex);

    await writeClient
      .patch(referralId)
      .set({
        earnedXoc: earnings.xoc,
        earnedVertex: earnings.vertex,
        earnedTotal: earnings.total,
        paidXoc,
        paidVertex,
        paidTotal: payments.total,
        owedXoc: remaining.xoc,
        owedVertex: remaining.vertex,
        owedTotal: remaining.total,
      })
      .commit();

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
      logs: {
        xoc: referral?.xocPayments || [],
        vertex: referral?.vertexPayments || [],
      },
    });
  } catch (err) {
    console.error('SYNC PAYOUTS API ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Server error',
    });
  }
}

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

export default async function handler(req, res) {
  // Vercel Cron sends GET requests with authorization header
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ok: false, error: 'Unauthorized'});
  }

  try {
    const referrals = await readClient.fetch(
      `*[_type == "referral"]{
        _id, name, slug, xocPayments, vertexPayments,
        earnedTotal, paidTotal, owedTotal
      }`
    );

    if (!referrals || referrals.length === 0) {
      return res.status(200).json({ok: true, synced: 0, message: 'No referrals found'});
    }

    const results = [];

    for (const referral of referrals) {
      const code = (referral?.slug?.current || '').toLowerCase();
      const bookings = await readClient.fetch(
        `*[_type == "booking"
            && status in ["captured", "completed"]
            && (
              referral._ref == $id
              || (defined(referralCode) && lower(referralCode) == $code)
            )
          ]{
            packageTitle, commissionAmount, commissionPercent, netAmount, grossAmount
          }`,
        {id: referral._id, code}
      );

      const earnings = computeEarningsFromBookings(bookings || []);
      const paidXoc = sumPayments(referral?.xocPayments || []);
      const paidVertex = sumPayments(referral?.vertexPayments || []);
      const {payments, remaining} = buildBalance(earnings, paidXoc, paidVertex);

      // Only write if values actually changed
      const changed =
        referral.earnedTotal !== earnings.total ||
        referral.paidTotal !== payments.total ||
        referral.owedTotal !== remaining.total;

      if (changed) {
        await writeClient
          .patch(referral._id)
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

        results.push({id: referral._id, name: referral.name, updated: true});
      } else {
        results.push({id: referral._id, name: referral.name, updated: false});
      }
    }

    const updatedCount = results.filter((r) => r.updated).length;
    return res.status(200).json({
      ok: true,
      total: referrals.length,
      synced: updatedCount,
      results,
    });
  } catch (err) {
    console.error('CRON SYNC ERROR:', err);
    return res.status(500).json({ok: false, error: err?.message || 'Server error'});
  }
}

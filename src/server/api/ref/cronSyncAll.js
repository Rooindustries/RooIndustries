import {createDataClient as createClient} from '../../data/documentClient.js';
import crypto from 'crypto';
import {requireSecret} from './auth.js';
import {logSafeError} from '../../safeErrorLog.js';
import {
  buildBalance,
  computeEarningsFromBookings,
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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ok: false, error: 'Method not allowed'});
  }

  if (
    !requireSecret(
      res,
      'CRON_SECRET',
      'Access is temporarily unavailable.'
    )
  ) {
    return;
  }

  const authHeader = String(req.headers.authorization || '');
  const expected = `Bearer ${String(process.env.CRON_SECRET || '').trim()}`;
  const providedBuffer = Buffer.from(authHeader);
  const expectedBuffer = Buffer.from(expected);
  const authorized =
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  if (!authorized) {
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
      const {payments, owed} = buildBalance(earnings, paidXoc, paidVertex);

      const changed =
        referral.earnedTotal !== earnings.total ||
        referral.paidTotal !== payments.total ||
        referral.owedTotal !== owed.total;

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
            owedXoc: owed.xoc,
            owedVertex: owed.vertex,
            owedTotal: owed.total,
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
    logSafeError('Referral cron sync failed', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
}

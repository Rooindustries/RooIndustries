import {createClient} from '@sanity/client';
import crypto from 'crypto';
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

const WEBHOOK_SECRET = process.env.SANITY_WEBHOOK_SECRET;

function isValidSignature(body, signature) {
  if (!WEBHOOK_SECRET) return true; // no secret configured = skip validation
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(typeof body === 'string' ? body : JSON.stringify(body));
  const digest = hmac.digest('hex');
  return signature === digest;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ok: false, error: 'Method not allowed'});
  }

  // Validate webhook signature if secret is configured
  const signature = req.headers['sanity-webhook-signature'] || '';
  if (WEBHOOK_SECRET && !isValidSignature(req.body, signature)) {
    return res.status(401).json({ok: false, error: 'Invalid signature'});
  }

  try {
    const body = req.body || {};

    // Sanity webhook sends the document (or projection) as the body
    const referralId = body._id;

    if (!referralId) {
      return res.status(400).json({ok: false, error: 'No _id in webhook payload'});
    }

    // Fetch fresh referral data
    const referral = await readClient.fetch(
      `*[_type == "referral" && _id == $id][0]{
        _id, name, slug, xocPayments, vertexPayments
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
          packageTitle, commissionAmount, commissionPercent, netAmount, grossAmount
        }`,
      {id: referralId, code}
    );

    const earnings = computeEarningsFromBookings(bookings || []);
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
      synced: referralId,
      payments,
      remaining,
    });
  } catch (err) {
    console.error('WEBHOOK SYNC ERROR:', err);
    return res.status(500).json({ok: false, error: err?.message || 'Server error'});
  }
}

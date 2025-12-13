import {createClient} from '@sanity/client';
import {randomUUID} from 'crypto';
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
    const {
      referralId,
      packageType,
      amount,
      paidOn,
      note = '',
      entryId = '',
      internalNotes,
      adminKey,
    } = req.body || {};

    // Admin key is now optional to simplify usage. If one is set, enforce it; if none is set, allow.
    if (ADMIN_KEY && adminKey !== ADMIN_KEY) {
      return res
        .status(403)
        .json({ok: false, error: 'Invalid admin key'});
    }

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

    const referral = await writeClient.fetch(
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

    const payments =
      packageType === 'xoc'
        ? [...(referral.xocPayments || [])]
        : [...(referral.vertexPayments || [])];

    const key = entryId || randomUUID();
    const entry = {
      _key: key,
      _type: packageType === 'xoc' ? 'paymentLogXoc' : 'paymentLogVertex',
      amount: +numericAmount.toFixed(2),
      paidOn: paymentDate.toISOString(),
      ...(note ? {note: String(note)} : {}),
    };

    const existingIndex = payments.findIndex((p) => p?._key === entryId);

    if (entryId && existingIndex >= 0) {
      payments[existingIndex] = {...payments[existingIndex], ...entry};
    } else {
      payments.push(entry);
    }

    // Build next payment arrays for both package types
    const nextXocPayments = packageType === 'xoc' ? payments : referral.xocPayments || [];
    const nextVertexPayments = packageType === 'vertex' ? payments : referral.vertexPayments || [];

    // Compute earnings + balances using all captured/completed bookings
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

    const paidXoc = sumPayments(nextXocPayments);
    const paidVertex = sumPayments(nextVertexPayments);

    const {payments: paymentsTotal, remaining} = buildBalance(earnings, paidXoc, paidVertex);

    // Persist payment logs + computed totals
    const patch = writeClient
      .patch(referralId)
      .set({
        xocPayments: nextXocPayments,
        vertexPayments: nextVertexPayments,
        earnedXoc: earnings.xoc,
        earnedVertex: earnings.vertex,
        earnedTotal: earnings.total,
        paidXoc,
        paidVertex,
        paidTotal: paymentsTotal.total,
        owedTotal: remaining.total,
      });

    if (typeof internalNotes === 'string') {
      patch.set({notes: internalNotes});
    }

    await patch.commit();

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
      payments: paymentsTotal,
      remaining,
      logs: {
        xoc: nextXocPayments,
        vertex: nextVertexPayments,
      },
    });
  } catch (err) {
    console.error('UPDATE PAYMENTS API ERROR:', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
}

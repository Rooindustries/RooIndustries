import {createDataClient as createClient} from '../../data/documentClient.js';
import crypto from 'crypto';
import {requireSecret} from './auth.js';
import {logSafeError} from '../../safeErrorLog.js';
import {
  buildBalance,
  fetchReferralEarnings,
  sumPayments,
} from './payoutUtils.js';

const readClient = createClient({}, {domain: 'commerce'});

const writeClient = createClient({}, {domain: 'commerce'});

export const createCronSyncAll = ({now = Date.now, budgetMs = 45000} = {}) => async (req, res) => {
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
    const started = now();
    const results = [];
    const afterId = await readClient.referralSyncCursor();
    let complete = true;
    for await (const outcome of readClient.documentBatches({documentTypes: ['referral'], afterId})) {
      if (results.length && now() - started >= budgetMs) { complete = false; break; }
      if (outcome.status !== 'document') {
        logSafeError('Referral cron batch failed', outcome.error);
        results.push({
          id: outcome.id, updated: false, pending: true,
          errorCode: String(outcome.error.code || 'REFERRAL_SYNC_FAILED').slice(0, 128),
          ...(outcome.bytes && {bytes: outcome.bytes}),
        });
        await writeClient.referralSyncCursor(outcome.id);
        continue;
      }
      const referral = outcome.document;
      try {
        if (!referral._rev) {
          throw Object.assign(new Error('Referral source revision is missing'), {status: 409});
        }
        const code = (referral.slug?.current || '').toLowerCase();
        const earnings = await fetchReferralEarnings({
          client: readClient,
          referralId: referral._id,
          referralCode: code,
        });
        const paidXoc = sumPayments(referral.xocPayments || []);
        const paidVertex = sumPayments(referral.vertexPayments || []);
        const {payments, owed} = buildBalance(earnings, paidXoc, paidVertex);
        const changed =
          referral.earnedTotal !== earnings.total ||
          referral.paidTotal !== payments.total ||
          referral.owedTotal !== owed.total;
        if (changed) {
          await writeClient
            .patch(referral._id)
            .ifRevisionId(referral._rev)
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
        }
        results.push({id: referral._id, name: referral.name, updated: changed});
      } catch (error) {
        logSafeError('Referral cron item failed', error);
        results.push({
          id: referral._id, updated: false, pending: true,
          errorCode: String(error?.code || 'REFERRAL_SYNC_FAILED').slice(0, 128),
        });
      }
      await writeClient.referralSyncCursor(referral._id);
    }
    if (complete) await writeClient.referralSyncCursor('');
    if (!results.length) {
      return res.status(200).json({ok: true, synced: 0, message: 'No referrals found'});
    }

    const updatedCount = results.filter((r) => r.updated).length;
    return res.status(200).json({
      ok: true,
      complete: complete && !results.some(row => row.pending),
      total: results.length,
      synced: updatedCount,
      results,
    });
  } catch (err) {
    logSafeError('Referral cron sync failed', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
};

export default createCronSyncAll();

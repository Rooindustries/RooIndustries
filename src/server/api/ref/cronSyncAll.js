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
    const ids = await readClient.listDocumentIds('referral');
    if (ids.length === 0) {
      return res.status(200).json({ok: true, synced: 0, message: 'No referrals found'});
    }

    const results = [];
    let failure = null;
    try {
      for await (const outcome of readClient.documentBatches({documentType: 'referral', ids})) {
        if (outcome.status !== 'document') {
          logSafeError('Referral cron batch failed', outcome.error);
          results.push({
            id: outcome.id, updated: false, pending: true, errorCode: outcome.error.code,
            ...(outcome.bytes === undefined ? {} : {bytes: outcome.bytes}),
          });
          continue;
        }
        const referral = outcome.document;
        try {
          if (!referral._rev) throw Object.assign(new Error("Referral source revision is missing"), { status: 409 });
          const code = (referral?.slug?.current || '').toLowerCase();
          const earnings = await fetchReferralEarnings({
            client: readClient,
            referralId: referral._id,
            referralCode: code,
          });
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

            results.push({id: referral._id, name: referral.name, updated: true});
          } else {
            results.push({id: referral._id, name: referral.name, updated: false});
          }
        } catch (error) {
          logSafeError('Referral cron item failed',error);
          results.push({id:referral._id,updated:false,pending:true,errorCode:String(error?.code || 'REFERRAL_SYNC_FAILED').slice(0,128)});
        }
      }
    } catch (error) {
      failure = error;
      logSafeError('Referral cron sync failed', error);
      const reached = new Set(results.map((row) => row.id));
      for (const id of ids) {
        if (!reached.has(id)) results.push({id, updated: false, pending: true, errorCode: String(error?.code || 'REFERRAL_SYNC_FAILED').slice(0, 128)});
      }
    }

    const updatedCount = results.filter((r) => r.updated).length;
    return res.status(failure ? 500 : 200).json({
      ok: !failure,
      ...(failure ? {error: 'Server error'} : {}),
      total: ids.length,
      complete: !results.some((row) => row.pending),
      synced: updatedCount,
      results,
    });
  } catch (err) {
    logSafeError('Referral cron sync failed', err);
    return res.status(500).json({ok: false, error: 'Server error'});
  }
}

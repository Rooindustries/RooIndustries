import {createSupabaseAdminClient} from '../supabase/adminClient.js';

export async function historicalReferralAccounting(record, referralId) {
  const {data, error} = await createSupabaseAdminClient().rpc('roo_historical_referral_accounting', {
    p_booking_id: record.bookingId || '', p_referral_id: referralId,
  });
  if (error) throw error;
  if (typeof data === 'boolean') return data;
  if (typeof record.referralAccountingApplied === 'boolean') return record.referralAccountingApplied;
  throw new Error('Historical referral accounting evidence is missing.');
}

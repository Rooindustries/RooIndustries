import { authorizeCronRequest } from '@/src/server/api/cronAuth';
import { createSupabaseAdminClient } from '@/src/server/supabase/adminClient';
import { refreshRamPrice, reportRamPriceFailure } from '@/src/server/content/refreshRamPrice';
import { refreshPublicContent } from '@/src/server/content/refreshPublicContent';
import { logSafeError } from '@/src/server/safeErrorLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'dub1';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };

export async function GET(request) {
  try {
    authorizeCronRequest(request);
  } catch (error) {
    return Response.json({ ok: false }, { status: error.status || 403, headers });
  }
  let committed = false;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    const result = await refreshRamPrice({
      client: createSupabaseAdminClient({ signal }), signal,
      onCommit: () => { committed = true; },
    });
    return Response.json(
      { ok: result.state !== 'limited', ...result },
      {
        status: result.state === 'limited' ? 429 : 200,
        headers: { ...headers, ...(result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}) },
      },
    );
  } catch (error) {
    reportRamPriceFailure(error);
    return Response.json({ ok: false, code: 'RAM_PRICE_REFRESH_FAILED' }, { status: 503, headers });
  } finally {
    if (committed) {
      try {
        await refreshPublicContent(true);
      } catch (error) {
        logSafeError('RAM price content refresh failed', error);
      }
    }
  }
}

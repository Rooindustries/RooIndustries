import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import {
  listTourneyPayoutsForSession,
  upsertTourneyPayout,
} from "../../../../src/server/tourney/appealPayoutStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const getSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  return readTourneySessionFromStore({ token });
};

const readPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return request.json().catch(() => ({}));
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
};

const getPayoutsResponse = async (session) =>
  NextResponse.json({
    ok: true,
    payouts: await listTourneyPayoutsForSession({ session }),
  });

export async function GET(request) {
  const session = await getSession(request);
  if (!session || !["owner", "caster", "player"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }
  return getPayoutsResponse(session);
}

export async function POST(request) {
  const session = await getSession(request);
  if (!session || !["owner", "caster"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = checkTourneyRateLimit({
    key: `tourney-payouts:${clientAddress}:${session.username}`,
    max: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many payout changes. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    await upsertTourneyPayout({
      payload: await readPayload(request),
      session,
    });
    return getPayoutsResponse(session);
  } catch (error) {
    return jsonError(error?.message || "Unable to update payouts.", error?.status || 500, {
      errors: error?.errors || undefined,
    });
  }
}

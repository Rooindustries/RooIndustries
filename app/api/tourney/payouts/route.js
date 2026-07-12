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
import { enqueueTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  executeTourneyCommand,
  readTourneyCommandId,
} from "../../../../src/server/tourney/store";

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

const getPayoutsBody = async (session) => ({
    ok: true,
    payouts: await listTourneyPayoutsForSession({ session }),
  });
const getPayoutsResponse = async (session) => NextResponse.json(await getPayoutsBody(session));

export async function GET(request) {
  const session = await getSession(request);
  if (!session || !["owner", "caster", "player"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }
  return getPayoutsResponse(session);
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getSession(request);
  if (!session || !["owner", "caster"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-payouts:${clientAddress}:${session.username}`,
    max: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many payout changes. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readPayload(request);
    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: "payouts:upsert",
      requestPayload: payload,
      callback: async () => {
        const existing = payload.payoutId
          ? (await listTourneyPayoutsForSession({ session })).find(
              (payout) => payout.id === payload.payoutId
            )
          : null;
        const payout = await upsertTourneyPayout({ payload, session });
        const transitioned = ["ready", "paid", "void"].includes(payout?.status) &&
          existing?.status !== payout.status;
        if (transitioned && payout?.payoutEmail) {
          await enqueueTourneyEmailDispatch({
            commandId,
            dispatchKind: "payout",
            recipient: payout.payoutEmail,
            entityType: "payout",
            entityId: payout.id,
            entityVersion: payout.updatedAt,
            audience: payout.status,
            payload: {
              payout,
              to: payout.payoutEmail,
              transition: payout.status,
              baseUrl: new URL(request.url).origin,
            },
          });
        }
        return { body: await getPayoutsBody(session) };
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to update payouts.");
    const response = jsonError(failure.message, failure.status, {
      errors: failure.errors,
      code: failure.code,
    });
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

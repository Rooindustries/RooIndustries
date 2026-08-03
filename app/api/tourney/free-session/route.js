import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import {
  bookTourneyFreeSession,
  cancelTourneyFreeSessionBooking,
  getTourneyFreeSessionState,
} from "../../../../src/server/tourney/freeSessionStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
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

const getTargetPlayerId = ({ request, session }) => {
  if (session.role === "player") return String(session.playerId || "").trim();
  return String(new URL(request.url).searchParams.get("playerId") || "").trim();
};

export async function GET(request) {
  const session = await getSession(request);
  if (!session || !["owner", "caster", "player"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }
  const playerId = getTargetPlayerId({ request, session });
  if (!playerId) return jsonError("A player is required.", 400);

  try {
    return NextResponse.json(await getTourneyFreeSessionState({ playerId }));
  } catch (error) {
    const failure = buildTourneyPublicError(
      error,
      "Unable to load the free-session entitlement."
    );
    return jsonError(failure.message, failure.status, {
      errors: failure.errors,
      code: failure.code,
    });
  }
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return jsonError("Cross-origin request rejected.", 403);
  }
  const session = await getSession(request);
  if (!session || session.role !== "player" || !session.playerId) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-free-session:${clientAddress}:${session.username}`,
    max: 8,
    windowMs: 15 * 60 * 1000,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          rateLimit.error ||
          "Too many free-session booking attempts. Please try again later.",
      },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  let compensation = null;
  try {
    const payload = await readBoundedJson(request, { maxBytes: 16 * 1024 });
    const action = String(payload.action || "").trim().toLowerCase();
    if (action !== "book") {
      throw Object.assign(new Error("Unsupported free-session action."), {
        status: 400,
      });
    }
    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: "players:book-free-session",
      requestPayload: payload,
      callback: async () => {
        const booked = await bookTourneyFreeSession({
          session,
          payload,
          clientAddress,
        });
        compensation = booked.compensation;
        return { body: booked.body };
      },
    });
    compensation = null;
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    if (compensation?.bookingReference) {
      await cancelTourneyFreeSessionBooking(compensation).catch(() => null);
    }
    const failure = buildTourneyPublicError(
      error,
      "Unable to book the free session."
    );
    return jsonError(failure.message, failure.status, {
      errors: failure.errors,
      code: failure.code,
    });
  }
}

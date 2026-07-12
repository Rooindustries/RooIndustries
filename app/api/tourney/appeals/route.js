import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import {
  createTourneyAppeal,
  listTourneyAppealsForSession,
  updateTourneyAppeal,
} from "../../../../src/server/tourney/appealPayoutStore";
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

const getAppealsBody = async (session) => ({
    ok: true,
    appeals: await listTourneyAppealsForSession({ session }),
  });
const getAppealsResponse = async (session) => NextResponse.json(await getAppealsBody(session));

export async function GET(request) {
  const session = await getSession(request);
  if (!session || !["owner", "caster", "player"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }
  return getAppealsResponse(session);
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getSession(request);
  if (!session || !["owner", "caster", "player"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-appeals:${clientAddress}:${session.username}`,
    max: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many appeal changes. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readPayload(request);
    const action = String(payload.action || "create").toLowerCase();
    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: `appeals:${action}`,
      requestPayload: payload,
      callback: async () => {
        if (action === "create") {
          await createTourneyAppeal({ payload, session });
          return { body: await getAppealsBody(session) };
        }
        if (action === "update") {
          if (!["owner", "caster"].includes(session.role)) {
            throw Object.assign(new Error("Not found."), { status: 404 });
          }
          await updateTourneyAppeal({
            appealId: payload.appealId,
            payload,
            session,
          });
          return { body: await getAppealsBody(session) };
        }
        throw Object.assign(new Error("Unsupported appeal action."), { status: 400 });
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to update appeals.");
    const response = jsonError(failure.message, failure.status, {
      errors: failure.errors,
      code: failure.code,
    });
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

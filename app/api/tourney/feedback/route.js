import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import {
  createTourneyFeedback,
  listTourneyFeedbackForSession,
} from "../../../../src/server/tourney/feedbackStore";
import {
  isTourneyFeedbackSlugValid,
  TOURNEY_FEEDBACK_SLUG_HEADER,
} from "../../../../src/server/tourney/feedbackAccess";
import { enqueueTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  executeTourneyCommand,
  readTourneyCommandId,
} from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const getFeedbackRecipient = () =>
  String(
    process.env.TOURNEY_FEEDBACK_NOTIFICATION_EMAIL ||
      "serviroo@rooindustries.com"
  ).trim().toLowerCase();

const getSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  return readTourneySessionFromStore({ token });
};

const isAdminSession = (session) =>
  Boolean(session && ["owner", "caster"].includes(session.role));

const getFeedbackBody = async (session) => ({
  ok: true,
  feedback: await listTourneyFeedbackForSession({ session }),
});

export async function GET(request) {
  const session = await getSession(request);
  if (!isAdminSession(session)) return jsonError("Not found.", 404);
  return NextResponse.json(await getFeedbackBody(session));
}

export async function POST(request) {
  if (
    !isTourneyFeedbackSlugValid({
      slug: request.headers.get(TOURNEY_FEEDBACK_SLUG_HEADER),
    })
  ) {
    return jsonError("Not found.", 404);
  }
  if (
    process.env.VERCEL_ENV === "preview" &&
    process.env.TOURNEY_FEEDBACK_PREVIEW_MODE === "1"
  ) {
    return jsonError("Feedback submission is disabled in this preview.", 403);
  }
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-feedback:${clientAddress}`,
    max: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: rateLimit.error || "Too many feedback attempts. Please try again later.",
      },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readBoundedJson(request, { maxBytes: 16 * 1024 });
    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: "appeals:anonymous-feedback",
      requestPayload: payload,
      callback: async () => {
        const created = await createTourneyFeedback({ payload });
        const recipient = getFeedbackRecipient();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
          throw Object.assign(
            new Error("The Tourney feedback notification email is invalid."),
            { status: 503, code: "TOURNEY_FEEDBACK_EMAIL_INVALID" }
          );
        }
        await enqueueTourneyEmailDispatch({
          commandId,
          dispatchKind: "feedback",
          recipient,
          idempotencyKey: "anonymous-feedback-owner",
          entityType: "feedback",
          entityId: created.id,
          entityVersion: created.createdAt,
          audience: "owner",
          payload: {
            feedback: created,
            to: recipient,
          },
        });
        return {
          body: {
            ok: true,
            feedback: created,
            receiptId: created.id,
          },
        };
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to save feedback.");
    const response = jsonError(failure.message, failure.status, {
      errors: failure.errors,
      code: failure.code,
    });
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

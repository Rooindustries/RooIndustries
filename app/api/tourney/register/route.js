import { NextResponse } from "next/server";
import {
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  getTourneyApprovalRecipients,
} from "../../../../src/server/tourney/auth";
import { enqueueTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import {
  createPendingTourneyPlayer,
  getTourneyRegistrationCloseIso,
  isTourneyRegistrationClosed,
} from "../../../../src/server/tourney/playerStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { getNextSupabaseUser } from "../../../../src/server/supabase/serverSession";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { resolveSupabaseAccountByUserId } from "../../../../src/server/supabase/accounts";
import {
  executeTourneyCommand,
  readTourneyCommandId,
} from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const readPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return readBoundedJson(request, { maxBytes: 32 * 1024 });
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 32 * 1024) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }

  const form = await request.formData();
  return {
    username: form.get("username"),
    email: form.get("email"),
    password: form.get("password"),
    passwordConfirm: form.get("passwordConfirm"),
    discord: form.get("discord"),
    displayName: form.get("displayName"),
    battlenet: form.get("battlenet"),
    rank: form.get("rank"),
    rolePlay: form.get("rolePlay"),
    secondaryRolePlay: form.get("secondaryRolePlay"),
    acceptSubstitutePool: form.get("acceptSubstitutePool"),
    timezone: form.get("timezone"),
    twitchUsername: form.get("twitchUsername"),
    availableAug12: form.get("availableAug12"),
    acceptedRules: form.get("acceptedRules"),
    acceptedCreatorEligibility: form.get("acceptedCreatorEligibility"),
    acceptedRooVisibility: form.get("acceptedRooVisibility"),
    notes: form.get("notes"),
  };
};

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  if (isTourneyRegistrationClosed()) {
    return jsonError("Registration is closed.", 403, {
      code: "REGISTRATION_CLOSED",
      registrationClosesAt: getTourneyRegistrationCloseIso(),
    });
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-register:${clientAddress}`,
    max: 8,
    windowMs: 30 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many registrations. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readPayload(request);
    const recipients = await getTourneyApprovalRecipients();
    if (recipients.length === 0) {
      return jsonError("Approvers are not configured.", 503);
    }

    const successResponse = NextResponse.json({
      ok: true,
      message: "Registration submitted. Wait for approval before logging in.",
    });
    const socialUser = await getNextSupabaseUser({
      request,
      response: successResponse,
    }).catch(() => null);
    const submittedEmail = String(payload?.email || "").trim().toLowerCase();
    const socialAccount = socialUser?.id
      ? await resolveSupabaseAccountByUserId({ userId: socialUser.id })
      : null;
    if (
      socialUser &&
      String(socialAccount?.verified_real_email || "").trim().toLowerCase() !== submittedEmail
    ) {
      return jsonError("Your verified sign-in email does not match this registration.", 409);
    }

    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: "registration:create",
      requestPayload: payload,
      callback: async () => {
        const created = await createPendingTourneyPlayer({
          payload,
          recipients,
          authUserId: socialUser?.id || "",
        });
        const baseUrl = new URL(request.url).origin;
        for (const recipient of recipients) {
          const recipientTokens = created.tokens.filter(
            (token) => token.recipient_email === recipient.email
          );
          await enqueueTourneyEmailDispatch({
            commandId,
            dispatchKind: "registration",
            recipient: recipient.email,
            payload: {
              player: created.player,
              tokens: recipientTokens,
              baseUrl,
            },
          });
        }
        return {
          body: {
            ok: true,
            message: "Registration submitted. Wait for approval before logging in.",
          },
        };
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to submit registration.");
    const response = jsonError(failure.message, failure.status, {
      code: failure.code,
      capacity: failure.status < 500 ? error?.capacity : undefined,
      capacitySnapshot: failure.status < 500 ? error?.capacitySnapshot : undefined,
      errors: failure.errors,
    });
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

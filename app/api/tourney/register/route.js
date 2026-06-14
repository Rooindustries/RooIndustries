import { NextResponse } from "next/server";
import {
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  getTourneyApprovalRecipients,
} from "../../../../src/server/tourney/auth";
import { sendTourneyRegistrationApprovalEmails } from "../../../../src/server/tourney/email";
import {
  createPendingTourneyPlayer,
  getTourneyRegistrationCloseIso,
  isTourneyRegistrationClosed,
} from "../../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const readPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return request.json().catch(() => ({}));
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
    acceptedRooVisibility: form.get("acceptedRooVisibility"),
    notes: form.get("notes"),
  };
};

export async function POST(request) {
  if (isTourneyRegistrationClosed()) {
    return jsonError("Registration is closed.", 403, {
      code: "REGISTRATION_CLOSED",
      registrationClosesAt: getTourneyRegistrationCloseIso(),
    });
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = checkTourneyRateLimit({
    key: `tourney-register:${clientAddress}`,
    max: 8,
    windowMs: 30 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many registrations. Please try again later." },
      {
        status: 429,
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

    const created = await createPendingTourneyPlayer({ payload, recipients });
    const baseUrl = new URL(request.url).origin;
    try {
      await sendTourneyRegistrationApprovalEmails({
        player: created.player,
        tokens: created.tokens,
        baseUrl,
      });
    } catch (emailError) {
      console.error("TOURNEY_REGISTRATION_EMAIL_ERROR:", emailError);
    }

    return NextResponse.json({
      ok: true,
      message: "Registration submitted. Wait for approval before logging in.",
    });
  } catch (error) {
    return jsonError(error?.message || "Unable to submit registration.", error?.status || 500, {
      code: error?.code || undefined,
      capacity: error?.capacity || undefined,
      capacitySnapshot: error?.capacitySnapshot || undefined,
      errors: error?.errors || undefined,
    });
  }
}

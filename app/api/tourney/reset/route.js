import { NextResponse } from "next/server";
import {
  getTourneyAccountsCanonicalHash,
  writePersistedTourneyAccountsJson,
} from "../../../../src/server/tourney/accountStore";
import {
  buildUpdatedTourneyAccounts,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readEffectiveTourneyAccounts,
  readTourneyPasswordReset,
  renderTourneyAccountsJson,
  TOURNEY_ADMIN_ROLES,
} from "../../../../src/server/tourney/auth";
import {
  hashTourneyToken,
  createTourneyPasswordHash,
  resetTourneyPlayerPassword,
} from "../../../../src/server/tourney/playerStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { executeTourneyCommand } from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-reset:${clientAddress}`,
    max: 10,
    windowMs: 30 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many reset attempts. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }
  let payload;
  try {
    payload = await readBoundedJson(request, { maxBytes: 8 * 1024 });
  } catch (error) {
    return jsonError(error?.message || "Invalid reset request.", Number(error?.status || 400));
  }

  try {
    const tokenHash = hashTourneyToken(payload.token);
    const accounts = await readEffectiveTourneyAccounts();
    const adminAccount = readTourneyPasswordReset({
      token: payload.token,
      accounts,
    });
    // Must accept the same roles the forgot route mints tokens for, viewer included.
    // A narrower list here would validate a viewer's token, decline the admin branch,
    // then fall through to the player reset and reject a token it had just accepted.
    const nextAdminAccounts = adminAccount && TOURNEY_ADMIN_ROLES.includes(adminAccount.role)
      ? await buildUpdatedTourneyAccounts({
          action: "change-password",
          username: adminAccount.username,
          actorUsername: adminAccount.username,
          password: payload.password,
          accounts,
        })
      : null;
    const expectedCurrentHash = getTourneyAccountsCanonicalHash(accounts);
    const preparedPlayerPasswordHash = nextAdminAccounts
      ? ""
      : await createTourneyPasswordHash({ password: payload.password });
    const command = await executeTourneyCommand({
      commandId: `token:${tokenHash}:reset`,
      purpose: "tokens:reset",
      requestPayload: { tokenHash, passwordHash: hashTourneyToken(payload.password) },
      requiredExternalOperationKinds: [
        "supabase_admin_auth",
        "supabase_player_auth",
      ],
      externalCompletionPendingMessage:
        "Password setup is still finishing. Select Update password again shortly to confirm sign-in is ready.",
      externalCompletionFailureMessage:
        "Password setup could not be completed. Request a new reset link and try again.",
      callback: async () => {
        if (nextAdminAccounts) {
          await writePersistedTourneyAccountsJson({
            accountsJson: renderTourneyAccountsJson(nextAdminAccounts),
            actorUsername: adminAccount.username,
            // buildUpdatedTourneyAccounts returns the bcrypt digest only, and Auth
            // discards a digest when updating an existing user. Without the plaintext
            // the reset would report success and leave the old password working.
            credentialUsername: adminAccount.username,
            credentialPassword: payload.password,
            expectedCurrentHash,
          });
        } else {
          await resetTourneyPlayerPassword({
            token: payload.token,
            password: payload.password,
            preparedPasswordHash: preparedPlayerPasswordHash,
          });
        }
        return { body: { ok: true, message: "Password updated." } };
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to reset password.");
    const response = jsonError(failure.message, failure.status, {
      code: failure.code,
    });
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

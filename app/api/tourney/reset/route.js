import { NextResponse } from "next/server";
import { writePersistedTourneyAccountsJson } from "../../../../src/server/tourney/accountStore";
import {
  buildUpdatedTourneyAccounts,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readEffectiveTourneyAccounts,
  readTourneyPasswordReset,
  renderTourneyAccountsJson,
} from "../../../../src/server/tourney/auth";
import {
  hashTourneyToken,
  resetTourneyPlayerPassword,
} from "../../../../src/server/tourney/playerStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { executeTourneyCommand } from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const payload = await request.json().catch(() => ({}));
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

  try {
    const tokenHash = hashTourneyToken(payload.token);
    const command = await executeTourneyCommand({
      commandId: `token:${tokenHash}:reset`,
      purpose: "tokens:reset",
      requestPayload: { tokenHash, passwordHash: hashTourneyToken(payload.password) },
      callback: async () => {
        const accounts = await readEffectiveTourneyAccounts();
        const adminAccount = readTourneyPasswordReset({
          token: payload.token,
          accounts,
        });
        if (adminAccount && ["owner", "caster"].includes(adminAccount.role)) {
          const nextAccounts = await buildUpdatedTourneyAccounts({
            action: "change-password",
            username: adminAccount.username,
            actorUsername: adminAccount.username,
            password: payload.password,
            accounts,
          });
          await writePersistedTourneyAccountsJson({
            accountsJson: renderTourneyAccountsJson(nextAccounts),
            actorUsername: adminAccount.username,
          });
        } else {
          await resetTourneyPlayerPassword({
            token: payload.token,
            password: payload.password,
          });
        }
        return { body: { ok: true, message: "Password updated." } };
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to reset password.");
    const response = jsonError(failure.message, failure.status);
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

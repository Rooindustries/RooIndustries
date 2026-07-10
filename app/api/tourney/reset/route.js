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
import { resetTourneyPlayerPassword } from "../../../../src/server/tourney/playerStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";

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
      return NextResponse.json({ ok: true, message: "Password updated." });
    }

    await resetTourneyPlayerPassword({
      token: payload.token,
      password: payload.password,
    });
    return NextResponse.json({ ok: true, message: "Password updated." });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to reset password.");
    return jsonError(failure.message, failure.status);
  }
}

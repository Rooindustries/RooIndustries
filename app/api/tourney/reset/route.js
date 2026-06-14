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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = checkTourneyRateLimit({
    key: `tourney-reset:${clientAddress}`,
    max: 10,
    windowMs: 30 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many reset attempts. Please try again later." },
      {
        status: 429,
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
    return jsonError(error?.message || "Unable to reset password.", error?.status || 500);
  }
}

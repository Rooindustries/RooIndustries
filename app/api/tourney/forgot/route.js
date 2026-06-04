import { NextResponse } from "next/server";
import {
  checkTourneyRateLimit,
  createTourneyPasswordResetToken,
  findTourneyAccount,
  findTourneyAccountByEmail,
  getTourneyAdminEmail,
  getClientAddressFromHeaders,
  readEffectiveTourneyAccounts,
} from "../../../../src/server/tourney/auth";
import { sendTourneyResetEmail } from "../../../../src/server/tourney/email";
import { createTourneyResetToken } from "../../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const payload = contentType.includes("application/json")
    ? await request.json().catch(() => ({}))
    : Object.fromEntries((await request.formData()).entries());
  const login = String(payload.login || payload.email || payload.username || "").trim();
  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = checkTourneyRateLimit({
    key: `tourney-forgot:${clientAddress}:${login.toLowerCase() || "unknown"}`,
    max: 5,
    windowMs: 30 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many reset requests. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const accounts = await readEffectiveTourneyAccounts();
    const adminAccount =
      findTourneyAccount(login, accounts) || findTourneyAccountByEmail(login, accounts);
    const adminEmail =
      adminAccount?.active && ["owner", "caster"].includes(adminAccount.role)
        ? getTourneyAdminEmail(adminAccount)
        : "";

    if (adminAccount && adminEmail) {
      const token = createTourneyPasswordResetToken({ account: adminAccount });
      await sendTourneyResetEmail({
        player: {
          username: adminAccount.username,
          email: adminEmail,
        },
        token,
        baseUrl: new URL(request.url).origin,
      });
    } else {
      const reset = await createTourneyResetToken({ login });
      if (reset) {
        await sendTourneyResetEmail({
          player: reset.player,
          token: reset.token,
          baseUrl: new URL(request.url).origin,
        });
      }
    }
  } catch (error) {
    console.error("TOURNEY_FORGOT_ERROR:", error);
  }

  return NextResponse.json({
    ok: true,
    message: "If that account exists, a reset link was sent.",
  });
}

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
import { enqueueTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import { createTourneyResetToken } from "../../../../src/server/tourney/playerStore";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  executeTourneyCommand,
  readTourneyCommandId,
} from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ ok: false, error: "Cross-origin request rejected." }, { status: 403 });
  }
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const payload = contentType.includes("application/json")
    ? await request.json().catch(() => ({}))
    : Object.fromEntries((await request.formData()).entries());
  const login = String(payload.login || payload.email || payload.username || "").trim();
  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-forgot:${clientAddress}:${login.toLowerCase() || "unknown"}`,
    max: 5,
    windowMs: 30 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many reset requests. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  let syncPending = false;
  try {
    const commandId = readTourneyCommandId({ request });
    const accounts = await readEffectiveTourneyAccounts();
    const adminAccount =
      findTourneyAccount(login, accounts) || findTourneyAccountByEmail(login, accounts);
    const adminEmail =
      adminAccount?.active && ["owner", "caster"].includes(adminAccount.role)
        ? getTourneyAdminEmail(adminAccount)
        : "";
    const command = await executeTourneyCommand({
      commandId,
      purpose: "tokens:reset-request",
      requestPayload: { login: login.toLowerCase() },
      callback: async () => {
        if (adminAccount && adminEmail) {
          const token = createTourneyPasswordResetToken({ account: adminAccount });
          await enqueueTourneyEmailDispatch({
            commandId,
            dispatchKind: "reset",
            recipient: adminEmail,
            payload: {
              player: { username: adminAccount.username, email: adminEmail },
              token,
              baseUrl: new URL(request.url).origin,
            },
          });
        } else {
          const reset = await createTourneyResetToken({ login });
          if (reset) {
            await enqueueTourneyEmailDispatch({
              commandId,
              dispatchKind: "reset",
              recipient: reset.player.email,
              payload: {
                player: reset.player,
                token: reset.token,
                baseUrl: new URL(request.url).origin,
              },
            });
          }
        }
        return { body: { ok: true } };
      },
    });
    syncPending = Boolean(command.syncPending);
  } catch (error) {
    logSafeError("Tournament forgot-password failed", error);
    if ([
      "TOURNEY_IDEMPOTENCY_KEY_REQUIRED",
      "TOURNEY_IDEMPOTENCY_KEY_RESERVED",
      "TOURNEY_WRITES_PAUSED",
    ].includes(error?.code)) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        {
          status: Number(error.status || 400),
          headers: error.retryAfter ? { "Retry-After": String(error.retryAfter) } : undefined,
        }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    message: "If that account exists, a reset link was sent.",
    ...(syncPending ? { syncPending: true } : {}),
  });
}

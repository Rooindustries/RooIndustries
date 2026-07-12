import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  buildUpdatedTourneyAccounts,
  checkTourneyRateLimit,
  createTourneySessionToken,
  getClientAddressFromHeaders,
  getTourneyCookieOptions,
  findTourneyAccount,
  readEffectiveTourneyAccounts,
  readTourneySessionFromStore,
  renderTourneyAccountsJson,
  summarizeTourneyAccounts,
} from "../../../../src/server/tourney/auth";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import {
  getTourneyAccountsCanonicalHash,
  writePersistedTourneyAccountsJson,
} from "../../../../src/server/tourney/accountStore";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  executeTourneyCommand,
  readTourneyCommandId,
} from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const getOwnerSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token });
  return session?.role === "owner" ? session : null;
};

const readAccountPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return request.json().catch(() => ({}));
  }

  const form = await request.formData();
  return {
    action: form.get("action"),
    username: form.get("username"),
    email: form.get("email"),
    role: form.get("role"),
    password: form.get("password"),
  };
};

export async function GET(request) {
  if (!(await getOwnerSession(request))) {
    return jsonError("Not found.", 404);
  }

  const accounts = await readEffectiveTourneyAccounts();
  return NextResponse.json({
    ok: true,
    accounts: summarizeTourneyAccounts(accounts),
  });
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getOwnerSession(request);
  if (!session) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-owner:${clientAddress}:${session.username}`,
    max: 20,
    windowMs: 15 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many changes. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readAccountPayload(request);
    const currentAccounts = await readEffectiveTourneyAccounts();
    const accounts = await buildUpdatedTourneyAccounts({
      action: payload?.action,
      username: payload?.username,
      actorUsername: session.username,
      role: payload?.role,
      email: payload?.email,
      password: payload?.password,
      accounts: currentAccounts,
    });
    const accountsJson = renderTourneyAccountsJson(accounts);
    const expectedCurrentHash = getTourneyAccountsCanonicalHash(currentAccounts);
    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: `accounts:${String(payload?.action || "update").toLowerCase()}`,
      requestPayload: payload,
      callback: async () => {
        const persisted = await writePersistedTourneyAccountsJson({
          accountsJson,
          actorUsername: session.username,
          expectedCurrentHash,
        });
        return { body: {
          ok: true,
          accounts: summarizeTourneyAccounts(accounts),
          accountsJson,
          persisted: true,
          persistedAt: persisted.updatedAt,
        } };
      },
    });
    const response = NextResponse.json(command.body, { status: command.status });

    const updatedSessionAccount = findTourneyAccount(
      session.username,
      JSON.parse(command.body.accountsJson || "[]")
    );
    if (updatedSessionAccount) {
      const nextToken = createTourneySessionToken({
        account: {
          ...updatedSessionAccount,
          authBackend: session.authBackend || "sanity",
        },
      });
      if (nextToken) {
        response.cookies.set({
          name: TOURNEY_SESSION_COOKIE,
          value: nextToken,
          ...getTourneyCookieOptions(),
        });
      }
    }

    return response;
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to update account.");
    const response = jsonError(failure.message, failure.status);
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

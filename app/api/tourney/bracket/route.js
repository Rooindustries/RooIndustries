import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import {
  deleteTourneyBracketTeam,
  disqualifyTourneyBracketTeam,
  forfeitTourneyBracketMatch,
  generateTourneyBracket,
  getTourneyBracketSnapshot,
  reopenTourneyBracketMatch,
  resetTourneyBracket,
  scoreTourneyBracketMatch,
  seedTourneyBracketTeams,
  upsertTourneyBracketTeam,
} from "../../../../src/server/tourney/bracketStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OWNER_ACTIONS = new Set([
  "upsert-team",
  "delete-team",
  "seed-teams",
  "generate",
  "reset-bracket",
]);

const ADMIN_ACTIONS = new Set([
  "score-match",
  "forfeit-match",
  "disqualify-team",
  "reopen-match",
]);

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const getSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  return readTourneySessionFromStore({ token });
};

const readPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return request.json().catch(() => ({}));
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
};

export async function GET() {
  return NextResponse.json(await getTourneyBracketSnapshot());
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getSession(request);
  if (!session || !["owner", "caster"].includes(session.role)) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-bracket:${clientAddress}:${session.username}`,
    max: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many bracket changes. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readPayload(request);
    const action = String(payload.action || "").toLowerCase();
    if (!OWNER_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) {
      return jsonError("Unsupported bracket action.");
    }
    if (OWNER_ACTIONS.has(action) && session.role !== "owner") {
      return jsonError("Owner access required.", 403);
    }

    if (action === "upsert-team") {
      await upsertTourneyBracketTeam({
        teamId: payload.teamId,
        name: payload.name,
        seed: payload.seed,
        actorUsername: session.username,
      });
      return NextResponse.json(
        await getTourneyBracketSnapshot({ includeAudit: true })
      );
    }

    if (action === "delete-team") {
      await deleteTourneyBracketTeam({
        teamId: payload.teamId,
        actorUsername: session.username,
      });
      return NextResponse.json(
        await getTourneyBracketSnapshot({ includeAudit: true })
      );
    }

    if (action === "seed-teams") {
      const teamIds = Array.isArray(payload.teamIds)
        ? payload.teamIds
        : String(payload.teamIds || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
      await seedTourneyBracketTeams({
        teamIds,
        actorUsername: session.username,
      });
      return NextResponse.json(
        await getTourneyBracketSnapshot({ includeAudit: true })
      );
    }

    if (action === "generate") {
      return NextResponse.json(
        await generateTourneyBracket({ actorUsername: session.username })
      );
    }

    if (action === "reset-bracket") {
      return NextResponse.json(
        await resetTourneyBracket({ actorUsername: session.username })
      );
    }

    if (action === "score-match") {
      return NextResponse.json(
        await scoreTourneyBracketMatch({
          matchId: payload.matchId,
          opponent1Score: payload.opponent1Score,
          opponent2Score: payload.opponent2Score,
          actorUsername: session.username,
        })
      );
    }

    if (action === "forfeit-match") {
      return NextResponse.json(
        await forfeitTourneyBracketMatch({
          matchId: payload.matchId,
          losingSide: payload.losingSide,
          reason: payload.reason,
          actorUsername: session.username,
        })
      );
    }

    if (action === "disqualify-team") {
      return NextResponse.json(
        await disqualifyTourneyBracketTeam({
          teamId: payload.teamId,
          matchId: payload.matchId,
          reason: payload.reason,
          actorUsername: session.username,
        })
      );
    }

    if (action === "reopen-match") {
      const force = payload.force === true || payload.force === "true";
      if (force && session.role !== "owner") {
        return jsonError("Owner access required.", 403);
      }
      return NextResponse.json(
        await reopenTourneyBracketMatch({
          matchId: payload.matchId,
          force,
          actorUsername: session.username,
        })
      );
    }

    return jsonError("Unsupported bracket action.");
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to update bracket.");
    return jsonError(failure.message, failure.status);
  }
}

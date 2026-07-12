import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import { enqueueTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import {
  applyRegistrationDecision,
  createApprovedTourneyPlayer,
  getTourneyRoleCapacitySnapshot,
  kickTourneyPlayer,
  listManageTourneyPlayers,
  updateTourneyPlayerApprovedRole,
  updateTourneyRegistrationConfig,
  updateTourneyPlayerDetails,
  withdrawTourneyPlayer,
} from "../../../../src/server/tourney/playerStore";
import { buildTourneyPublicError } from "../../../../src/server/tourney/publicError";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  executeTourneyCommand,
  readTourneyCommandId,
} from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400, extra = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const getAdminSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token });
  return session && ["owner", "caster"].includes(session.role) ? session : null;
};

const readPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return request.json().catch(() => ({}));
  }

  const form = await request.formData();
  return Object.fromEntries(form.entries());
};

const getPlayersBody = async () => ({
    ok: true,
    players: await listManageTourneyPlayers(),
    capacity: await getTourneyRoleCapacitySnapshot(),
  });
const getPlayersResponse = async () => NextResponse.json(await getPlayersBody());

const queueApprovedPlayerEmail = ({ player, request, commandId }) =>
  enqueueTourneyEmailDispatch({
    commandId,
    dispatchKind: "approval",
    recipient: player.email,
    payload: { player, baseUrl: new URL(request.url).origin },
  });

export async function GET(request) {
  if (!(await getAdminSession(request))) {
    return jsonError("Not found.", 404);
  }

  return getPlayersResponse();
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getAdminSession(request);
  if (!session) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-player-manage:${clientAddress}:${session.username}`,
    max: 40,
    windowMs: 15 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: rateLimit.error || "Too many player changes. Please try again later." },
      {
        status: rateLimit.status || 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readPayload(request);
    const action = String(payload.action || "").toLowerCase();

    const commandId = readTourneyCommandId({ request });
    const command = await executeTourneyCommand({
      commandId,
      purpose: `players:${action}`,
      requestPayload: payload,
      callback: async () => {
      if (action === "approve" || action === "deny") {
        const player = await applyRegistrationDecision({
        tokenHash: "",
        playerId: payload.playerId,
        purpose: action,
        actorUsername: session.username,
        approvedRolePlay: payload.approvedRolePlay || payload.role || "",
      });
      if (action === "approve") {
        await queueApprovedPlayerEmail({ player, request, commandId });
      }
        return { body: await getPlayersBody() };
    }

    if (action === "kick") {
      await kickTourneyPlayer({
        playerId: payload.playerId,
        actorUsername: session.username,
      });
        return { body: await getPlayersBody() };
    }

    if (action === "withdraw") {
      await withdrawTourneyPlayer({
        playerId: payload.playerId,
        actorUsername: session.username,
      });
        return { body: await getPlayersBody() };
    }

    if (action === "add") {
      await createApprovedTourneyPlayer({
        payload,
        actorUsername: session.username,
      });
        return { body: await getPlayersBody() };
    }

    if (action === "update-details") {
      await updateTourneyPlayerDetails({
        playerId: payload.playerId,
        payload,
        actorUsername: session.username,
      });
        return { body: await getPlayersBody() };
    }

    if (action === "update-role") {
      await updateTourneyPlayerApprovedRole({
        playerId: payload.playerId,
        rolePlay: payload.rolePlay || payload.approvedRolePlay || payload.role || "",
        actorUsername: session.username,
      });
        return { body: await getPlayersBody() };
    }

    if (action === "update-capacity") {
      await updateTourneyRegistrationConfig({
        teamCount: payload.teamCount,
        actorUsername: session.username,
      });
        return { body: await getPlayersBody() };
    }

        throw Object.assign(new Error("Unsupported player action."), { status: 400 });
      },
    });
    return NextResponse.json(command.body, { status: command.status });
  } catch (error) {
    const failure = buildTourneyPublicError(error, "Unable to update players.");
    const response = jsonError(failure.message, failure.status, {
      errors: failure.errors,
      code: failure.code,
    });
    if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}

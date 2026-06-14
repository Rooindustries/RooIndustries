import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  checkTourneyRateLimit,
  getClientAddressFromHeaders,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import { sendTourneyPlayerApprovedEmail } from "../../../../src/server/tourney/email";
import {
  applyRegistrationDecision,
  createApprovedTourneyPlayer,
  getTourneyRoleCapacitySnapshot,
  kickTourneyPlayer,
  listManageTourneyPlayers,
  updateTourneyRegistrationConfig,
  updateTourneyPlayerDetails,
} from "../../../../src/server/tourney/playerStore";

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

const getPlayersResponse = async () =>
  NextResponse.json({
    ok: true,
    players: await listManageTourneyPlayers(),
    capacity: await getTourneyRoleCapacitySnapshot(),
  });

const notifyApprovedPlayer = async ({ player, request }) => {
  try {
    await sendTourneyPlayerApprovedEmail({
      player,
      baseUrl: new URL(request.url).origin,
    });
  } catch (emailError) {
    console.error("TOURNEY_PLAYER_APPROVED_EMAIL_ERROR:", emailError);
  }
};

export async function GET(request) {
  if (!(await getAdminSession(request))) {
    return jsonError("Not found.", 404);
  }

  return getPlayersResponse();
}

export async function POST(request) {
  const session = await getAdminSession(request);
  if (!session) {
    return jsonError("Not found.", 404);
  }

  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = checkTourneyRateLimit({
    key: `tourney-player-manage:${clientAddress}:${session.username}`,
    max: 40,
    windowMs: 15 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many player changes. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  try {
    const payload = await readPayload(request);
    const action = String(payload.action || "").toLowerCase();

    if (action === "approve" || action === "deny") {
      const player = await applyRegistrationDecision({
        tokenHash: "",
        playerId: payload.playerId,
        purpose: action,
        actorUsername: session.username,
        approvedRolePlay: payload.approvedRolePlay || payload.role || "",
      });
      if (action === "approve") {
        await notifyApprovedPlayer({ player, request });
      }
      return getPlayersResponse();
    }

    if (action === "kick") {
      await kickTourneyPlayer({
        playerId: payload.playerId,
        actorUsername: session.username,
      });
      return getPlayersResponse();
    }

    if (action === "add") {
      await createApprovedTourneyPlayer({
        payload,
        actorUsername: session.username,
      });
      return getPlayersResponse();
    }

    if (action === "update-details") {
      await updateTourneyPlayerDetails({
        playerId: payload.playerId,
        payload,
        actorUsername: session.username,
      });
      return getPlayersResponse();
    }

    if (action === "update-capacity") {
      await updateTourneyRegistrationConfig({
        teamCount: payload.teamCount,
        actorUsername: session.username,
      });
      return getPlayersResponse();
    }

    return jsonError("Unsupported player action.");
  } catch (error) {
    return jsonError(error?.message || "Unable to update players.", error?.status || 500, {
      errors: error?.errors || undefined,
    });
  }
}

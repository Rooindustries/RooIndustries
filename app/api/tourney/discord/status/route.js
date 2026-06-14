import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import {
  getApprovedTourneyPlayerById,
} from "../../../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const sessionToken = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token: sessionToken });
  if (session?.role !== "player" || !session.playerId) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const player = await getApprovedTourneyPlayerById({ playerId: session.playerId });
  if (!player) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    discord: {
      linked: Boolean(player.discordUserId),
      roleAssigned: Boolean(player.discordRoleAssignedAt),
      linkedAt: player.discordLinkedAt || "",
      roleAssignedAt: player.discordRoleAssignedAt || "",
      lastError: player.discordRoleLastError || "",
    },
  });
}

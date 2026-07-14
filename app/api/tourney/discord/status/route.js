import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import {
  getApprovedTourneyPlayerById,
} from "../../../../../src/server/tourney/playerStore";
import { getTourneyDiscordStatusForPlayer } from "../../../../../src/server/tourney/discordDesiredState";
import { logSafeError } from "../../../../../src/server/safeErrorLog";

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

  let durableStatus;
  try {
    durableStatus = await getTourneyDiscordStatusForPlayer({
      playerId: session.playerId,
    });
  } catch (error) {
    logSafeError("Tournament Discord status failed", error);
    return NextResponse.json(
      { ok: false, error: "Discord role status is temporarily unavailable." },
      { status: 503 }
    );
  }
  const linked = durableStatus?.linked ?? Boolean(player.discordUserId);
  return NextResponse.json({
    ok: true,
    discord: {
      linked,
      roleAssigned: durableStatus?.roleAssigned === true,
      linkedAt: player.discordLinkedAt || "",
      roleAssignedAt: durableStatus?.roleAssignedAt || "",
      lastError: durableStatus?.lastError || player.discordRoleLastError || "",
      state: durableStatus?.state || (linked ? "pending" : "unlinked"),
    },
  });
}

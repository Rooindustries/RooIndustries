import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import {
  getApprovedTourneyPlayerById,
} from "../../../../../src/server/tourney/playerStore";
import { listTourneyDiscordDesiredState } from "../../../../../src/server/tourney/discordDesiredState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const sessionToken = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token: sessionToken });
  if (session?.role !== "player" || !session.playerId) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const [player, assignments] = await Promise.all([
    getApprovedTourneyPlayerById({ playerId: session.playerId }),
    listTourneyDiscordDesiredState().catch(() => []),
  ]);
  if (!player) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const assignment = assignments.find(
    (entry) => entry.player_id === session.playerId
  );
  return NextResponse.json({
    ok: true,
    discord: {
      linked: Boolean(player.discordUserId),
      roleAssigned: assignment?.status === "applied",
      linkedAt: player.discordLinkedAt || "",
      roleAssignedAt: assignment?.applied_at || "",
      lastError: assignment?.last_error || "",
      state: assignment?.status || (player.discordUserId ? "pending" : "unlinked"),
    },
  });
}

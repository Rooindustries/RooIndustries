import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import { getTourneyDiscordOAuthConfig } from "../../../../../src/server/tourney/discordConfig";
import {
  listTourneyDiscordDesiredState,
  recordTourneyDiscordDesiredState,
} from "../../../../../src/server/tourney/discordDesiredState";
import { enqueueTourneyExternalOperation } from "../../../../../src/server/tourney/externalOperations";
import { listManageTourneyPlayers } from "../../../../../src/server/tourney/playerStore";
import { executeTourneyCommand } from "../../../../../src/server/tourney/store";
import { isSameOriginMutation } from "../../../../../src/server/request/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const getAdminSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token });
  return session && ["owner", "caster"].includes(session.role) ? session : null;
};

const readMember = async ({ player, config, fetchImpl = fetch }) => {
  const response = await fetchImpl(
    `${config.apiBaseUrl}/guilds/${config.guildId}/members/${player.discordUserId}`,
    { headers: { Authorization: `Bot ${config.botToken}` } }
  );
  if (response.status === 404) return { membership: "absent", managedRoles: [] };
  if (!response.ok) return { membership: "unknown", managedRoles: [], errorCode: `discord_http_${response.status}` };
  const member = await response.json();
  const roles = new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
  return {
    membership: "present",
    managedRoles: [
      ...(roles.has(config.participantRoleId) ? ["participant"] : []),
      ...(roles.has(config.hostRoleId) ? ["host"] : []),
    ],
  };
};

const inventory = async ({ config }) => {
  const [players, assignments] = await Promise.all([
    listManageTourneyPlayers(),
    listTourneyDiscordDesiredState().catch(() => []),
  ]);
  const assignmentByPlayer = new Map(
    assignments.map((assignment) => [assignment.player_id, assignment])
  );
  const linked = players.filter(
    (player) => player.status === "approved" && player.discordUserId
  );
  const rows = [];
  for (const player of linked) {
    const current = await readMember({ player, config });
    const desiredRole = "participant";
    rows.push({
      playerId: player.id,
      discordUserId: player.discordUserId,
      principalMapped: Boolean(assignmentByPlayer.get(player.id)?.principal_id),
      membership: current.membership,
      desiredRole,
      currentManagedRoles: current.managedRoles,
      conflict: current.managedRoles.length > 1,
      needsRepair:
        current.membership === "present" &&
        (current.managedRoles.length !== 1 || current.managedRoles[0] !== desiredRole),
      ...(current.errorCode ? { errorCode: current.errorCode } : {}),
    });
  }
  return {
    rows,
    counts: {
      linked: rows.length,
      present: rows.filter((row) => row.membership === "present").length,
      blockedReauth: rows.filter((row) => row.membership === "absent").length,
      conflicts: rows.filter((row) => row.conflict).length,
      needsRepair: rows.filter((row) => row.needsRepair).length,
    },
  };
};

export async function GET(request) {
  const session = await getAdminSession(request);
  if (!session) return jsonError("Not found.", 404);
  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) return jsonError("Discord OAuth is not configured.", 503);
  return NextResponse.json({ ok: true, dryRun: true, ...(await inventory({ config })) });
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getAdminSession(request);
  if (!session) return jsonError("Not found.", 404);
  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) return jsonError("Discord OAuth is not configured.", 503);
  const payload = await request.json().catch(() => ({}));
  if (String(payload.action || "dry-run").toLowerCase() !== "apply") {
    return NextResponse.json({ ok: true, dryRun: true, ...(await inventory({ config })) });
  }

  const players = (await listManageTourneyPlayers()).filter(
    (player) => player.status === "approved" && player.discordUserId
  );
  let queued = 0;
  for (const player of players) {
    const commandId = `discord-backfill:${player.id}:${player.discordUserId}`;
    await executeTourneyCommand({
      commandId,
      purpose: "discord:backfill",
      requestPayload: { playerId: player.id, discordUserId: player.discordUserId },
      attemptExternalWork: false,
      callback: async () => {
        const assignment = await recordTourneyDiscordDesiredState({
          player,
          discordUser: { id: player.discordUserId },
          guildId: config.guildId,
        });
        await enqueueTourneyExternalOperation({
          commandId,
          operationKind: "discord_role_reconcile",
          entityType: "player",
          entityId: player.id,
          desiredState: {
            assignment: {
              principalId: assignment.principal_id,
              discordUserId: assignment.discord_user_id,
              previousDiscordUserId: assignment.previous_discord_user_id || "",
              desiredRole: assignment.desired_role,
              generation: Number(assignment.generation),
            },
          },
        });
        return { body: { ok: true } };
      },
    });
    queued += 1;
  }
  return NextResponse.json({ ok: true, dryRun: false, queued, contactedDiscord: false });
}

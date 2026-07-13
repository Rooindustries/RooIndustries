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
import { logSafeError } from "../../../../../src/server/safeErrorLog";
import { buildTourneyPublicError } from "../../../../../src/server/tourney/publicError";

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
  try {
    const response = await fetchImpl(
      `${config.apiBaseUrl}/guilds/${config.guildId}/members/${player.discordUserId}`,
      {
        headers: { Authorization: `Bot ${config.botToken}` },
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (response.status === 404) return { membership: "absent", managedRoles: [] };
    if (!response.ok) {
      return { membership: "unknown", managedRoles: [], errorCode: `discord_http_${response.status}` };
    }
    const member = await response.json();
    const roles = new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
    return {
      membership: "present",
      managedRoles: [
        ...(roles.has(config.participantRoleId) ? ["participant"] : []),
        ...(roles.has(config.hostRoleId) ? ["host"] : []),
      ],
    };
  } catch (error) {
    return {
      membership: "unknown",
      managedRoles: [],
      errorCode: error?.name === "TimeoutError" ? "discord_timeout" : "discord_unavailable",
    };
  }
};

const mapInBatches = async (items, callback, batchSize = 5) => {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.all(items.slice(offset, offset + batchSize).map(callback)));
  }
  return results;
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
  const rows = await mapInBatches(linked, async (player) => {
    const current = await readMember({ player, config });
    const desiredRole = "participant";
    return {
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
    };
  });
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
  try {
    return NextResponse.json({ ok: true, dryRun: true, ...(await inventory({ config })) });
  } catch (error) {
    logSafeError("Tourney Discord inventory failed", error);
    return jsonError("Discord inventory is temporarily unavailable.", 503);
  }
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getAdminSession(request);
  if (!session) return jsonError("Not found.", 404);
  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) return jsonError("Discord OAuth is not configured.", 503);
  const payload = await request.json().catch(() => ({}));
  if (String(payload.action || "dry-run").toLowerCase() !== "apply") {
    try {
      return NextResponse.json({ ok: true, dryRun: true, ...(await inventory({ config })) });
    } catch (error) {
      logSafeError("Tourney Discord inventory failed", error);
      return jsonError("Discord inventory is temporarily unavailable.", 503);
    }
  }

  let players;
  try {
    players = (await listManageTourneyPlayers()).filter(
      (player) => player.status === "approved" && player.discordUserId
    );
  } catch (error) {
    logSafeError("Tourney Discord apply inventory failed", error);
    return jsonError("Discord desired-state inventory is temporarily unavailable.", 503);
  }
  let queued = 0;
  const failures = [];
  for (const player of players) {
    const commandId = `discord-backfill:${player.id}:${player.discordUserId}`;
    try {
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
    } catch (error) {
      if (error?.code === "TOURNEY_WRITES_PAUSED") {
        const failure = buildTourneyPublicError(
          error,
          "Tournament updates are temporarily unavailable."
        );
        return NextResponse.json(
          { ok: false, error: failure.message, code: failure.code },
          {
            status: failure.status,
            headers: { "Retry-After": String(error.retryAfter || 30) },
          }
        );
      }
      const failure = buildTourneyPublicError(
        error,
        "Unable to queue Discord role synchronization."
      );
      failures.push({
        playerId: player.id,
        status: failure.status,
        code: failure.code || "TOURNEY_DISCORD_ENQUEUE_FAILED",
      });
    }
  }
  return NextResponse.json({
    ok: failures.length === 0,
    dryRun: false,
    queued,
    failed: failures.length,
    ...(failures.length > 0 ? { failures } : {}),
    contactedDiscord: false,
  });
}

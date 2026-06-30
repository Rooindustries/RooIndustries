import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import {
  listManageTourneyPlayers,
  markTourneyPlayerDiscordRoleAssigned,
  markTourneyPlayerDiscordRoleFailed,
} from "../../../../../src/server/tourney/playerStore";
import {
  getTourneyDiscordOAuthConfig,
} from "../../../../../src/server/tourney/discordConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const getAdminSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token });
  return session && ["owner", "caster"].includes(session.role) ? session : null;
};

const parseDiscordBody = async (response) => {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const getDiscordError = async (response, fallback) => {
  const body = await parseDiscordBody(response);
  return (
    body?.message ||
    body?.error_description ||
    body?.error ||
    `${fallback} (${response.status})`
  );
};

const syncDiscordRole = async ({ player, config, fetchImpl = fetch } = {}) => {
  const headers = { Authorization: `Bot ${config.botToken}` };
  const memberUrl = `${config.apiBaseUrl}/guilds/${config.guildId}/members/${player.discordUserId}`;
  const memberResponse = await fetchImpl(memberUrl, { headers });

  if (memberResponse.status === 404) {
    return {
      status: "not-in-guild",
      errorMessage:
        "Discord member not found after OAuth; user must re-authorize after the join fix.",
    };
  }

  if (!memberResponse.ok) {
    return {
      status: "failed",
      errorMessage: await getDiscordError(
        memberResponse,
        "Unable to read Discord guild member"
      ),
    };
  }

  const member = await memberResponse.json();
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  if (roles.includes(config.participantRoleId)) {
    return { status: "already-had-role" };
  }

  const roleResponse = await fetchImpl(
    `${memberUrl}/roles/${config.participantRoleId}`,
    {
      method: "PUT",
      headers,
    }
  );
  if (roleResponse.ok || roleResponse.status === 204) {
    return { status: "role-added" };
  }

  return {
    status: "failed",
    errorMessage: await getDiscordError(
      roleResponse,
      "Unable to assign Discord role"
    ),
  };
};

export async function POST(request) {
  if (!(await getAdminSession(request))) {
    return jsonError("Not found.", 404);
  }

  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) {
    return jsonError("Discord OAuth is not configured.", 503);
  }

  const players = await listManageTourneyPlayers();
  const targets = players.filter(
    (player) =>
      player.status === "approved" &&
      player.discordUserId &&
      !player.discordRoleAssignedAt
  );
  const summary = {
    ok: true,
    checked: targets.length,
    alreadyHadRole: 0,
    roleAdded: 0,
    notInGuildNeedsReauth: 0,
    failed: 0,
  };

  for (const player of targets) {
    const result = await syncDiscordRole({ player, config });

    if (result.status === "already-had-role") {
      await markTourneyPlayerDiscordRoleAssigned({ playerId: player.id });
      summary.alreadyHadRole += 1;
      continue;
    }

    if (result.status === "role-added") {
      await markTourneyPlayerDiscordRoleAssigned({ playerId: player.id });
      summary.roleAdded += 1;
      continue;
    }

    await markTourneyPlayerDiscordRoleFailed({
      playerId: player.id,
      errorMessage: result.errorMessage || "Discord role assignment failed.",
    });

    if (result.status === "not-in-guild") {
      summary.notInGuildNeedsReauth += 1;
    } else {
      summary.failed += 1;
    }
  }

  return NextResponse.json(summary);
}

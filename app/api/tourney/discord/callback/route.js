import { NextResponse } from "next/server";
import {
  getApprovedTourneyPlayerById,
  recordTourneyPlayerDiscordLink,
} from "../../../../../src/server/tourney/playerStore";
import { recordTourneyDiscordDesiredState } from "../../../../../src/server/tourney/discordDesiredState";
import { enqueueTourneyExternalOperation } from "../../../../../src/server/tourney/externalOperations";
import { executeTourneyCommand } from "../../../../../src/server/tourney/store";
import {
  getTourneyDiscordOAuthConfig,
} from "../../../../../src/server/tourney/discordConfig";
import {
  exchangeDiscordOAuthCode,
  fetchDiscordCurrentUser,
  readTourneyDiscordOAuthStateToken,
} from "../../../../../src/server/tourney/discordOAuth";
import { logSafeError } from "../../../../../src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirectToTourneyStatus = (request, status, returnTo = "/tourney") => {
  const safeReturnTo =
    String(returnTo || "").startsWith("/") && !String(returnTo || "").startsWith("//")
      ? returnTo
      : "/tourney";
  const url = new URL(safeReturnTo, request.url);
  url.searchParams.set("discord", status);
  return NextResponse.redirect(url, { status: 303 });
};

export async function GET(request) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "").trim();
  const statePayload = readTourneyDiscordOAuthStateToken({
    token: url.searchParams.get("state") || "",
  });
  if (!code || !statePayload) {
    return redirectToTourneyStatus(request, "invalid");
  }

  const player = await getApprovedTourneyPlayerById(statePayload);
  if (!player) {
    return redirectToTourneyStatus(request, "not-approved", statePayload.returnTo);
  }

  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) {
    return redirectToTourneyStatus(request, "not-configured", statePayload.returnTo);
  }

  try {
    const token = await exchangeDiscordOAuthCode({ code, config });
    const discordUser = await fetchDiscordCurrentUser({
      accessToken: token.access_token,
      config,
    });
    const commandId = `discord-oauth:${player.id}:${discordUser.id}`;
    const command = await executeTourneyCommand({
      commandId,
      purpose: "discord:link",
      requestPayload: {
        playerId: player.id,
        discordUserId: discordUser.id,
      },
      postCommitContext: {
        discordAccessTokens: { [player.id]: token.access_token },
      },
      callback: async () => {
        const linkedPlayer = await recordTourneyPlayerDiscordLink({
          playerId: player.id,
          discordUser,
        });
        const assignment = await recordTourneyDiscordDesiredState({
          player: linkedPlayer || player,
          discordUser,
          guildId: config.guildId,
        });
        await enqueueTourneyExternalOperation({
          commandId,
          operationKind: "discord_membership",
          entityType: "player",
          entityId: player.id,
          desiredState: {
            assignment: {
              principalId: assignment.principal_id || assignment.principalId,
              discordUserId: assignment.discord_user_id || discordUser.id,
              previousDiscordUserId: assignment.previous_discord_user_id || "",
              desiredRole: assignment.desired_role || assignment.desiredRole,
              generation: Number(assignment.generation || 1),
            },
          },
        });
        return { body: { ok: true } };
      },
    });
    return redirectToTourneyStatus(
      request,
      command.syncPending ? "syncing" : "linked",
      statePayload.returnTo
    );
  } catch (error) {
    logSafeError("Tournament Discord role assignment failed", error);
    return redirectToTourneyStatus(request, "role-failed", statePayload.returnTo);
  }
}

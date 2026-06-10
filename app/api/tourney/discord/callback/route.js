import { NextResponse } from "next/server";
import {
  getApprovedTourneyPlayerById,
  markTourneyPlayerDiscordRoleAssigned,
  markTourneyPlayerDiscordRoleFailed,
  recordTourneyPlayerDiscordLink,
} from "../../../../../src/server/tourney/playerStore";
import {
  getTourneyDiscordOAuthConfig,
} from "../../../../../src/server/tourney/discordConfig";
import {
  assignTourneyDiscordParticipantRole,
  exchangeDiscordOAuthCode,
  fetchDiscordCurrentUser,
  readTourneyDiscordOAuthStateToken,
} from "../../../../../src/server/tourney/discordOAuth";

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
    await recordTourneyPlayerDiscordLink({
      playerId: player.id,
      discordUser,
    });
    await assignTourneyDiscordParticipantRole({
      accessToken: token.access_token,
      userId: discordUser.id,
      config,
    });
    await markTourneyPlayerDiscordRoleAssigned({ playerId: player.id });
    return redirectToTourneyStatus(request, "linked", statePayload.returnTo);
  } catch (error) {
    await markTourneyPlayerDiscordRoleFailed({
      playerId: player.id,
      errorMessage: error?.message || "Discord role assignment failed.",
    });
    return redirectToTourneyStatus(request, "role-failed", statePayload.returnTo);
  }
}

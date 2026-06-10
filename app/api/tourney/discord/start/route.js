import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import {
  getApprovedTourneyPlayerById,
} from "../../../../../src/server/tourney/playerStore";
import {
  getTourneyDiscordOAuthConfig,
} from "../../../../../src/server/tourney/discordConfig";
import {
  buildDiscordAuthorizationUrl,
  createTourneyDiscordOAuthStateToken,
  readTourneyDiscordEmailToken,
} from "../../../../../src/server/tourney/discordOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirectToTourneyStatus = (request, status) => {
  const url = new URL("/tourney", request.url);
  url.searchParams.set("discord", status);
  return NextResponse.redirect(url, { status: 303 });
};

const getPlayerFromSession = async (request) => {
  const sessionToken = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token: sessionToken });
  if (session?.role !== "player" || !session.playerId) return null;
  return getApprovedTourneyPlayerById({ playerId: session.playerId });
};

const getPlayerFromEmailToken = async (request) => {
  const url = new URL(request.url);
  const tokenPayload = readTourneyDiscordEmailToken({
    token: url.searchParams.get("token") || "",
  });
  if (!tokenPayload) return null;
  return getApprovedTourneyPlayerById(tokenPayload);
};

export async function GET(request) {
  const player =
    (await getPlayerFromSession(request)) || (await getPlayerFromEmailToken(request));
  if (!player) {
    const url = new URL("/tourney/login", request.url);
    url.searchParams.set("error", "discord-auth");
    url.searchParams.set("next", "/api/tourney/discord/start");
    return NextResponse.redirect(url, { status: 303 });
  }

  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) {
    return redirectToTourneyStatus(request, "not-configured");
  }

  const state = createTourneyDiscordOAuthStateToken({
    player,
    returnTo: "/tourney",
  });
  if (!state) {
    return redirectToTourneyStatus(request, "state-error");
  }

  return NextResponse.redirect(
    buildDiscordAuthorizationUrl({ state, config }),
    { status: 303 }
  );
}

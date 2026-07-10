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
import { isSameOriginMutation } from "../../../../../src/server/request/sameOrigin";

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

const getPlayerFromEmailToken = async (token) => {
  const tokenPayload = readTourneyDiscordEmailToken({
    token: String(token || "").trim(),
  });
  if (!tokenPayload) return null;
  return getApprovedTourneyPlayerById(tokenPayload);
};

export async function GET(request) {
  const url = new URL(request.url);
  const player =
    (await getPlayerFromSession(request)) ||
    (await getPlayerFromEmailToken(url.searchParams.get("token")));
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

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { ok: false, error: "Cross-origin request rejected." },
      { status: 403 }
    );
  }
  const payload = await request.json().catch(() => ({}));
  const player =
    (await getPlayerFromSession(request)) ||
    (await getPlayerFromEmailToken(payload.token));
  if (!player) {
    return NextResponse.json(
      {
        ok: false,
        error: "This Discord verification link is invalid or expired.",
        signInUrl: "/tourney/login?next=/tourney/discord",
      },
      { status: 401 }
    );
  }

  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) {
    return NextResponse.json(
      { ok: false, error: "Discord verification is not configured." },
      { status: 503 }
    );
  }
  const state = createTourneyDiscordOAuthStateToken({ player, returnTo: "/tourney" });
  if (!state) {
    return NextResponse.json(
      { ok: false, error: "Discord verification could not be started." },
      { status: 503 }
    );
  }
  return NextResponse.json({
    ok: true,
    authorizeUrl: buildDiscordAuthorizationUrl({ state, config }),
  });
}

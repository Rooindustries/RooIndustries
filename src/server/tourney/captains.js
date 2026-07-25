import { extractTwitchLogin } from "./twitch.js";

export const TOURNEY_CAPTAIN_IDENTITIES = Object.freeze([
  Object.freeze({ discord: "wsps", twitch: "wsps" }),
  Object.freeze({ discord: "blxckouttttt", twitch: "cookies_ow" }),
  Object.freeze({ discord: "heartonvenus", twitch: "tapnocap" }),
  Object.freeze({ discord: "imawolf", twitch: "imwolfixd" }),
  Object.freeze({ discord: "chosenow", twitch: "chosen_ow" }),
  Object.freeze({ discord: "herloaf", twitch: "herloaf" }),
  Object.freeze({ discord: "putter", twitch: "putterow" }),
  Object.freeze({ discord: "hampesurf", twitch: "hmp_ow" }),
  Object.freeze({ discord: "cheesenut.", twitch: "cheesenut16" }),
  Object.freeze({ discord: "loooky", twitch: "mintthiefow" }),
  Object.freeze({ discord: "r3nztu", twitch: "r3nztu" }),
  Object.freeze({ discord: "skinzow", twitch: "skinzow" }),
]);

const normalizeDiscordIdentity = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");

const captainDiscordIdentities = new Set(
  TOURNEY_CAPTAIN_IDENTITIES.map(({ discord }) =>
    normalizeDiscordIdentity(discord)
  )
);

const captainTwitchIdentities = new Set(
  TOURNEY_CAPTAIN_IDENTITIES.map(({ twitch }) => extractTwitchLogin(twitch))
);

export const isTourneyCaptainPlayer = (player = {}) => {
  const discordIdentities = [
    player.discord,
    player.discordOauthUsername,
    player.discord_oauth_username,
  ]
    .map(normalizeDiscordIdentity)
    .filter(Boolean);
  const twitchIdentity = extractTwitchLogin(
    player.twitchUsername || player.twitch_username
  );

  return (
    discordIdentities.some((identity) =>
      captainDiscordIdentities.has(identity)
    ) || captainTwitchIdentities.has(twitchIdentity)
  );
};

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
  Object.freeze({ discord: "apply", twitch: "apply" }),
  Object.freeze({ discord: "loooky", twitch: "mintthiefow" }),
  Object.freeze({ discord: "r3nztu", twitch: "r3nztu" }),
  Object.freeze({ discord: "skinzow", twitch: "skinzow" }),
]);

const normalizeDiscordIdentity = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");

const captainDiscordSeeds = new Map(
  TOURNEY_CAPTAIN_IDENTITIES.map(({ discord }, index) => [
    normalizeDiscordIdentity(discord),
    index + 1,
  ])
);

const captainTwitchSeeds = new Map(
  TOURNEY_CAPTAIN_IDENTITIES.map(({ twitch }, index) => [
    extractTwitchLogin(twitch),
    index + 1,
  ])
);

export const getTourneyCaptainSeed = (player = {}) => {
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

  for (const identity of discordIdentities) {
    const seed = captainDiscordSeeds.get(identity);
    if (seed) return seed;
  }

  return captainTwitchSeeds.get(twitchIdentity) || 0;
};

export const isTourneyCaptainPlayer = (player = {}) =>
  getTourneyCaptainSeed(player) > 0;

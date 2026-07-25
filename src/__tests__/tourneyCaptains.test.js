const {
  TOURNEY_CAPTAIN_IDENTITIES,
  isTourneyCaptainPlayer,
} = require("../server/tourney/captains.js");

describe("tourney captain identities", () => {
  test("contains exactly the twelve linked Discord and Twitch identities", () => {
    expect(TOURNEY_CAPTAIN_IDENTITIES).toHaveLength(12);
    expect(
      new Set(TOURNEY_CAPTAIN_IDENTITIES.map(({ discord }) => discord)).size
    ).toBe(12);
    expect(
      new Set(TOURNEY_CAPTAIN_IDENTITIES.map(({ twitch }) => twitch)).size
    ).toBe(12);
  });

  test("matches captains by Discord username or connected Twitch account", () => {
    expect(
      isTourneyCaptainPlayer({ discordOauthUsername: "heartonvenus" })
    ).toBe(true);
    expect(isTourneyCaptainPlayer({ twitchUsername: "twitch.tv/skinzow" })).toBe(
      true
    );
    expect(isTourneyCaptainPlayer({ twitchUsername: "Cookies_OW" })).toBe(true);
  });

  test("does not infer a captain from a display name", () => {
    expect(isTourneyCaptainPlayer({ displayName: "wsps" })).toBe(false);
    expect(
      isTourneyCaptainPlayer({
        discordOauthUsername: "not-a-captain",
        twitchUsername: "notacaptain",
      })
    ).toBe(false);
  });
});

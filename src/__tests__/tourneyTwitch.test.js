const loadTwitch = () => {
  jest.resetModules();
  return require("../server/tourney/twitch.js");
};

describe("tourney Twitch helpers", () => {
  afterEach(() => {
    jest.resetModules();
  });

  test("extracts Twitch logins from handles and channel URLs", () => {
    const twitch = loadTwitch();

    expect(twitch.extractTwitchLogin("@Player_One")).toBe("player_one");
    expect(twitch.extractTwitchLogin("https://www.twitch.tv/Player_One")).toBe(
      "player_one"
    );
    expect(twitch.extractTwitchLogin("twitch.tv/Player_One?ref=roster")).toBe(
      "player_one"
    );
    expect(twitch.extractTwitchLogin("https://www.twitch.tv/videos/123")).toBe("");
  });

  test("builds channel links and labels without exposing unrelated stream data", () => {
    const twitch = loadTwitch();

    expect(twitch.normalizeTwitchUsername("skinz_ow")).toBe("skinz_ow");
    expect(twitch.normalizeTwitchUsername("https://www.twitch.tv/skinz_ow")).toBe(
      ""
    );
    expect(twitch.buildTwitchChannelUrl("Player_One")).toBe(
      "https://www.twitch.tv/player_one"
    );
    expect(twitch.formatTwitchLabel("https://twitch.tv/Player_One")).toBe(
      "player_one"
    );
    expect(twitch.buildTwitchChannelUrl("https://kick.com/playerone")).toBe("");
  });
});

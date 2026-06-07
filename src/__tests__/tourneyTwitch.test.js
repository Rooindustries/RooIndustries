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

  test("extracts safe Twitch profile images from public channel metadata", () => {
    const twitch = loadTwitch();
    const imageUrl =
      "https://static-cdn.jtvnw.net/jtv_user_pictures/player-profile_image-300x300.png";

    expect(
      twitch.extractTwitchProfileImageFromHtml(
        `<meta property="og:image" content="${imageUrl}">`
      )
    ).toBe(imageUrl);
    expect(
      twitch.extractTwitchProfileImageFromHtml(
        '<meta property="og:image" content="https://example.com/avatar.png">'
      )
    ).toBe("");
  });

  test("resolves profile images through the public-page fallback when enabled", async () => {
    const twitch = loadTwitch();
    twitch.resetTwitchProfileCacheForTests();
    const imageUrl =
      "https://static-cdn.jtvnw.net/jtv_user_pictures/player-profile_image-300x300.png";
    const fetchImpl = jest.fn(async (url) => ({
      ok: true,
      text: async () => `<meta property="og:image" content="${imageUrl}">`,
      json: async () => ({}),
      url,
    }));

    const images = await twitch.getTwitchProfileImageMap(["Player_One"], {
      env: {
        NODE_ENV: "test",
        TOURNEY_TWITCH_PROFILE_LOOKUP: "1",
      },
      fetchImpl,
    });

    expect(images.get("player_one")).toBe(imageUrl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.twitch.tv/player_one",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/html" }),
      })
    );
  });
});

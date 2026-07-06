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

  test("resolves live stream status through Twitch streams", async () => {
    const twitch = loadTwitch();
    twitch.resetTwitchProfileCacheForTests();
    const fetchImpl = jest.fn(async (url) => {
      const href = String(url);
      if (href.startsWith("https://id.twitch.tv/oauth2/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "app-token",
            expires_in: 3600,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              user_login: "player_one",
              user_name: "Player_One",
              type: "live",
              title: "Ranked scrims",
              game_name: "Overwatch 2",
              viewer_count: 42,
              started_at: "2026-07-07T12:00:00Z",
            },
          ],
        }),
      };
    });

    const statuses = await twitch.getTwitchLiveStatusMap(
      ["Player_One", "Offline_Player"],
      {
        env: {
          NODE_ENV: "test",
          TOURNEY_TWITCH_LIVE_LOOKUP: "1",
          TWITCH_CLIENT_ID: "client-id",
          TWITCH_CLIENT_SECRET: "client-secret",
        },
        fetchImpl,
      }
    );

    expect(statuses.get("player_one")).toMatchObject({
      isLive: true,
      title: "Ranked scrims",
      gameName: "Overwatch 2",
      viewerCount: 42,
      startedAt: "2026-07-07T12:00:00Z",
    });
    expect(statuses.has("offline_player")).toBe(false);

    const streamsUrl = new URL(fetchImpl.mock.calls[1][0]);
    expect(streamsUrl.href).toContain("https://api.twitch.tv/helix/streams");
    expect(streamsUrl.searchParams.get("type")).toBe("live");
    expect(streamsUrl.searchParams.getAll("user_login")).toEqual([
      "player_one",
      "offline_player",
    ]);
  });
});

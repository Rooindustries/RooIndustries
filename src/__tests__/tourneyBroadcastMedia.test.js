const loadMedia = () => {
  jest.resetModules();
  return require("../server/tourney/broadcastMedia.js");
};

describe("tourney broadcast media", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("loads current hero portraits and map screenshots", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            key: "ana",
            name: "Ana",
            portrait: "https://cdn.example/ana.png",
            role: "support",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            key: "ilios",
            name: "Ilios",
            screenshot: "https://cdn.example/ilios.jpg",
            location: "Greece",
          },
        ],
      });

    const media = await loadMedia().readTourneyBroadcastMedia();

    expect(media).toEqual({
      heroes: [
        { key: "ana", name: "Ana", imageUrl: "https://cdn.example/ana.png" },
      ],
      maps: [
        { key: "ilios", name: "Ilios", imageUrl: "https://cdn.example/ilios.jpg" },
      ],
    });
  });

  test("keeps the remaining catalog when one media request fails", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("hero catalog unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            key: "ilios",
            name: "Ilios",
            screenshot: "https://cdn.example/ilios.jpg",
          },
        ],
      });

    await expect(loadMedia().readTourneyBroadcastMedia()).resolves.toEqual({
      heroes: [],
      maps: [
        { key: "ilios", name: "Ilios", imageUrl: "https://cdn.example/ilios.jpg" },
      ],
    });
  });
});

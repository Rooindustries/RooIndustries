const mockFetchPublicContent = jest.fn();

jest.mock("../server/content/publicContent.js", () => ({
  fetchPublicContent: (...args) => mockFetchPublicContent(...args),
}));

jest.mock("../server/supabase/runtime.js", () => ({
  resolveSupabaseRuntimePolicy: () => ({ primaryBackend: "supabase" }),
}));

const { fetchFaqQuestions, fetchHomePageData } = require("../lib/sanityServer.js");

describe("server-rendered public content authority", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchPublicContent.mockImplementation(({ resource }) => {
      if (resource === "packages-list") return [];
      if (resource === "faq-questions") {
        return [{ question: "Question", answer: "Answer" }];
      }
      if (resource === "supported-games") {
        return {
          featuredGames: [
            {
              title: "Game",
              coverImage: {
                asset: {
                  _ref: "image-fixture-100x100-png",
                  _supabaseUrl: "https://example.test/game.png",
                },
                dimensions: { width: 100, height: 100, aspectRatio: 1 },
              },
            },
          ],
          moreGames: [],
        };
      }
      return null;
    });
  });

  test("loads every home resource from the Supabase public-content adapter", async () => {
    const result = await fetchHomePageData();
    const calls = mockFetchPublicContent.mock.calls.map(([input]) => input);

    expect(calls.map(({ resource }) => resource).sort()).toEqual(
      [
        "reviews",
        "about",
        "services",
        "packages-list",
        "packages-settings",
        "how-it-works",
        "supported-games",
        "faq-settings",
        "faq-questions",
      ].sort()
    );
    expect(calls.every(({ backend }) => backend === "supabase")).toBe(true);
    expect(
      result.supportedGames.featuredGames[0].coverImage.asset._supabaseUrl
    ).toBe("https://example.test/game.png");
  });

  test("loads the standalone FAQ from the same Supabase adapter", async () => {
    await expect(fetchFaqQuestions()).resolves.toEqual([
      { question: "Question", answer: "Answer" },
    ]);
    expect(mockFetchPublicContent).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "faq-questions",
        backend: "supabase",
      })
    );
  });
});

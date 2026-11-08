jest.mock("../lib/publicContentClient", () => {
  const getPublicContent = jest.fn();
  return {
    getPublicContent,
    getPublicContentEntry: jest.fn(async (...args) => ({ data: await getPublicContent(...args), revision: null })),
  };
});

describe("shared content cache", () => {
  let now;
  let getPublicContent;
  let fetchHomeSectionData;

  beforeEach(() => {
    jest.resetModules();
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    ({ getPublicContent } = require("../lib/publicContentClient"));
    const home = require("../lib/homeSectionData");
    ({ fetchHomeSectionData } = home);
    getPublicContent.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("refreshing one expired section cannot revive another expired section", async () => {
    let published = false;
    getPublicContent.mockImplementation(async (key) => ({
      fixtureValue: key + (published ? " new" : " old"),
    }));
    await fetchHomeSectionData("reviews");
    await fetchHomeSectionData("about");
    sessionStorage.setItem("referral_session", "retained-referral");
    now += 61_000;
    published = true;

    expect(await fetchHomeSectionData("reviews")).toMatchObject({ fixtureValue: "reviews new" });
    expect(await fetchHomeSectionData("about")).toMatchObject({ fixtureValue: "about new" });
    expect(getPublicContent).toHaveBeenCalledTimes(4);
    expect(sessionStorage.getItem("referral_session")).toBe("retained-referral");
  });

  test("reuses fresh data and coalesces simultaneous requests", async () => {
    getPublicContent.mockResolvedValue({ reviews: [{ name: "Current review" }] });

    const [first, second] = await Promise.all([
      fetchHomeSectionData("reviews"),
      fetchHomeSectionData("reviews"),
    ]);

    expect(first).toEqual(second);
    expect(first.reviews).toEqual([{ name: "Current review" }]);
    expect(getPublicContent).toHaveBeenCalledTimes(1);
    now += 30_000;
    expect(await fetchHomeSectionData("reviews")).toEqual(first);
    expect(getPublicContent).toHaveBeenCalledTimes(1);
  });
});

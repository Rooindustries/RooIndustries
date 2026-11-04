jest.mock("../lib/publicContentClient", () => {
  const getPublicContent = jest.fn();
  return {
    getPublicContent,
    getPublicContentEntry: jest.fn(async (...args) => ({ data: await getPublicContent(...args), revision: null })),
  };
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("shared content cache", () => {
  let now;
  let getPublicContent;
  let getPublicContentEntry;
  let fetchHomeSectionData;
  let readHomeSectionData;

  beforeEach(() => {
    jest.resetModules();
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    ({ getPublicContent, getPublicContentEntry } = require("../lib/publicContentClient"));
    ({ fetchHomeSectionData, readHomeSectionData } = require("../lib/homeSectionData"));
    getPublicContent.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  test("refreshes after the window and an older response never replaces a newer one", async () => {
    const older = deferred();
    const newer = deferred();
    getPublicContent
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const first = fetchHomeSectionData("about");
    now += 61_000;
    const second = fetchHomeSectionData("about");
    expect(getPublicContent).toHaveBeenCalledTimes(2);

    newer.resolve({ recordTitle: "New record" });
    await expect(second).resolves.toMatchObject({ recordTitle: "New record" });
    older.resolve({ recordTitle: "Old record" });
    await expect(first).resolves.toMatchObject({ recordTitle: "New record" });
    expect(readHomeSectionData("about")).toMatchObject({ recordTitle: "New record" });
  });

  test("a failed refresh keeps the last good copy", async () => {
    getPublicContent
      .mockResolvedValueOnce({ recordTitle: "Last good record" })
      .mockRejectedValueOnce(new Error("Public content is temporarily unavailable."));

    await fetchHomeSectionData("about");
    now += 61_000;

    await expect(fetchHomeSectionData("about")).resolves.toMatchObject({
      recordTitle: "Last good record",
    });
    expect(getPublicContent).toHaveBeenCalledTimes(2);
    expect(readHomeSectionData("about")).toMatchObject({ recordTitle: "Last good record" });
  });

  test("a first load that fails reports the failure", async () => {
    getPublicContent.mockRejectedValueOnce(new Error("Public content is temporarily unavailable."));

    await expect(fetchHomeSectionData("about")).rejects.toThrow("temporarily unavailable");
    expect(readHomeSectionData("about")).toBeNull();
  });

  test("a response with an older CMS revision never replaces a newer copy", async () => {
    getPublicContentEntry
      .mockResolvedValueOnce({ data: { recordTitle: "Published record" }, revision: 5 })
      .mockResolvedValueOnce({ data: { recordTitle: "Pre-publish record" }, revision: 4 })
      .mockResolvedValueOnce({ data: { recordTitle: "Unlabelled record" }, revision: null })
      .mockResolvedValueOnce({ data: { recordTitle: "Next record" }, revision: 6 });

    await fetchHomeSectionData("about");
    now += 61_000;
    await expect(fetchHomeSectionData("about")).resolves.toMatchObject({ recordTitle: "Published record" });
    now += 61_000;
    await expect(fetchHomeSectionData("about")).resolves.toMatchObject({ recordTitle: "Published record" });
    now += 61_000;
    await expect(fetchHomeSectionData("about")).resolves.toMatchObject({ recordTitle: "Next record" });
    expect(getPublicContentEntry).toHaveBeenCalledTimes(4);
  });
});

jest.mock("../lib/publicContentClient", () => ({ getPublicContentEntry: jest.fn() }));

describe("shared content refreshes", () => {
  let loadContent;
  let getPublicContentEntry;
  let now;
  let report;

  beforeEach(() => {
    jest.resetModules();
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    report = jest.spyOn(console, "error").mockImplementation(() => {});
    ({ getPublicContentEntry } = require("../lib/publicContentClient"));
    ({ loadContent } = require("../lib/contentCache"));
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([false, true])("reports a failed shared request once with a cached copy: %s", async (cached) => {
    const data = { headingLine1: "Published copy" };
    if (cached) {
      getPublicContentEntry.mockResolvedValueOnce({ data, revision: 1 });
      await loadContent("hero");
      now += 61_000;
    }
    const error = new Error("Content refresh failed");
    getPublicContentEntry.mockRejectedValueOnce(error);
    const results = await Promise.allSettled([loadContent("hero"), loadContent("hero")]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error);
    expect(getPublicContentEntry).toHaveBeenCalledTimes(cached ? 2 : 1);
    expect(results).toEqual(cached
      ? [{ status: "fulfilled", value: data }, { status: "fulfilled", value: data }]
      : [{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
  });
});

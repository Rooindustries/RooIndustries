import { getPublicContent } from "../lib/publicContentClient";
import {
  fetchHomeSectionData,
  readHomeSectionData,
} from "../lib/homeSectionData";

jest.mock("../lib/publicContentClient", () => ({
  getPublicContent: jest.fn(),
}));

describe("home section cache", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    // Drop module memory through the same expiration path used by a new page.
    readHomeSectionData("reviews");
    getPublicContent.mockReset();
  });

  afterEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
  });

  test("refreshing one expired section cannot revive another expired section", async () => {
    sessionStorage.setItem("roo-home-data:__ts", "699999");
    sessionStorage.setItem(
      "roo-home-data:reviews",
      JSON.stringify({ reviews: [{ name: "Old review" }] })
    );
    sessionStorage.setItem(
      "roo-home-data:about",
      JSON.stringify({ recordTitle: "Old record" })
    );
    sessionStorage.setItem("referral_session", "retained-referral");
    getPublicContent.mockImplementation(async (key) =>
      key === "reviews"
        ? { reviews: [{ name: "Fresh review" }] }
        : { recordTitle: "Fresh record" }
    );

    await fetchHomeSectionData("reviews");
    const about = await fetchHomeSectionData("about");

    expect(about).toMatchObject({ recordTitle: "Fresh record" });
    expect(getPublicContent.mock.calls.map(([key]) => key)).toEqual([
      "reviews",
      "about",
    ]);
    expect(sessionStorage.getItem("referral_session")).toBe("retained-referral");
  });

  test("reuses fresh data and coalesces simultaneous requests", async () => {
    sessionStorage.setItem("roo-home-data:__ts", "700001");
    sessionStorage.setItem(
      "roo-home-data:about",
      JSON.stringify({ recordTitle: "Current record" })
    );
    getPublicContent.mockResolvedValue({ reviews: [{ name: "Current review" }] });

    expect(await fetchHomeSectionData("about")).toMatchObject({
      recordTitle: "Current record",
    });
    const [first, second] = await Promise.all([
      fetchHomeSectionData("reviews"),
      fetchHomeSectionData("reviews"),
    ]);

    expect(first).toEqual(second);
    expect(getPublicContent).toHaveBeenCalledTimes(1);
    expect(getPublicContent).toHaveBeenCalledWith("reviews");
    expect(await fetchHomeSectionData("reviews")).toEqual(first);
    expect(getPublicContent).toHaveBeenCalledTimes(1);
  });
});

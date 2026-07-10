import { isSameOriginMutation } from "../server/request/sameOrigin";

const requestFor = ({ origin = "", fetchSite = "", url } = {}) => ({
  url: url || "https://www.rooindustries.com/api/tourney/login",
  headers: {
    get(name) {
      const key = String(name || "").toLowerCase();
      if (key === "origin") return origin;
      if (key === "sec-fetch-site") return fetchSite;
      return "";
    },
  },
});

describe("same-origin mutation guard", () => {
  test("accepts matching browser origins and non-browser requests", () => {
    expect(
      isSameOriginMutation(requestFor({ origin: "https://www.rooindustries.com" }))
    ).toBe(true);
    expect(isSameOriginMutation(requestFor())).toBe(true);
  });

  test("rejects cross-origin and cross-site mutations", () => {
    expect(
      isSameOriginMutation(requestFor({ origin: "https://attacker.example" }))
    ).toBe(false);
    expect(isSameOriginMutation(requestFor({ fetchSite: "cross-site" }))).toBe(false);
  });
});

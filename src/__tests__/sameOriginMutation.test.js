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

  test("accepts the apex origin after Vercel redirects a form POST to www", () => {
    expect(
      isSameOriginMutation(
        requestFor({ origin: "https://rooindustries.com" })
      )
    ).toBe(true);
    expect(
      isSameOriginMutation(
        requestFor({
          origin: "https://www.rooindustries.com",
          url: "https://rooindustries.com/api/tourney/login",
        })
      )
    ).toBe(true);
  });

  test("accepts a canonical browser origin when Vercel exposes an internal request URL", () => {
    expect(
      isSameOriginMutation(
        requestFor({
          origin: "https://www.rooindustries.com",
          url: "https://rooindustries-git-main.vercel.app/api/tourney/login",
        })
      )
    ).toBe(true);
  });

  test("rejects cross-origin and cross-site mutations", () => {
    expect(
      isSameOriginMutation(requestFor({ origin: "https://attacker.example" }))
    ).toBe(false);
    expect(isSameOriginMutation(requestFor({ fetchSite: "cross-site" }))).toBe(false);
    expect(
      isSameOriginMutation(
        requestFor({ origin: "https://auth.rooindustries.com" })
      )
    ).toBe(false);
    expect(
      isSameOriginMutation(
        requestFor({ origin: "http://rooindustries.com" })
      )
    ).toBe(false);
  });
});

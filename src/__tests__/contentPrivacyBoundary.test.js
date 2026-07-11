const fs = require("fs");
const path = require("path");

const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({ fetch: mockFetch }));
const mockSupabaseFetch = jest.fn();
const mockCreateSupabaseDocumentClient = jest.fn(() => ({
  fetch: mockSupabaseFetch,
}));
const mockEnrichSupabaseContentAssets = jest.fn(async ({ data }) => data);

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

jest.mock("../server/supabase/documentClient", () => ({
  createSupabaseDocumentClient: (...args) =>
    mockCreateSupabaseDocumentClient(...args),
}));

jest.mock("../server/supabase/assets", () => ({
  enrichSupabaseContentAssets: (...args) =>
    mockEnrichSupabaseContentAssets(...args),
}));

describe("public content privacy boundary", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const { clearSupabasePublicContentCache } = require(
      "../server/content/publicContent"
    );
    clearSupabasePublicContentCache();
    process.env.SANITY_PROJECT_ID = "project-test";
    process.env.SANITY_DATASET = "production";
    process.env.SANITY_READ_TOKEN = "server-only-read-token";
    delete process.env.DATA_PRIMARY_BACKEND;
    delete process.env.SUPABASE_CONTENT_CANARY_PERCENT;
    mockFetch.mockResolvedValue({ title: "Public copy" });
    mockSupabaseFetch.mockReset();
    mockSupabaseFetch.mockResolvedValue([{ _id: "benchmark-one" }]);
    mockEnrichSupabaseContentAssets.mockReset();
    mockEnrichSupabaseContentAssets.mockImplementation(async ({ data }) => data);
  });

  test("uses a fixed server projection and never accepts caller GROQ", async () => {
    const { fetchPublicContent } = require("../server/content/publicContent");
    const data = await fetchPublicContent({
      resource: "hero",
      searchParams: new URLSearchParams(),
    });

    expect(data).toEqual({ title: "Public copy" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('_type == "hero"');
    expect(mockFetch.mock.calls[0][0]).not.toContain("booking");
    expect(mockFetch.mock.calls[0][1]).toEqual({});
    expect(mockCreateClient.mock.calls[0][0]).toMatchObject({
      token: "server-only-read-token",
      useCdn: true,
      perspective: "published",
    });
    await expect(
      fetchPublicContent({
        resource: "hero",
        searchParams: new URLSearchParams("query=*%5B_type%20%3D%3D%20'booking'%5D"),
      })
    ).rejects.toThrow(/unsupported content parameter/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("rejects unknown resources and non-allowlisted package parameters", async () => {
    const { fetchPublicContent } = require("../server/content/publicContent");
    await expect(
      fetchPublicContent({
        resource: "booking",
        searchParams: new URLSearchParams(),
      })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      fetchPublicContent({
        resource: "package",
        searchParams: new URLSearchParams(),
      })
    ).rejects.toThrow(/valid package title/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("server content outages return 503 instead of masquerading as caller errors", async () => {
    delete process.env.SANITY_READ_TOKEN;
    delete process.env.SANITY_PRIVATE_READ_TOKEN;
    delete process.env.SANITY_WRITE_TOKEN;
    mockFetch.mockRejectedValueOnce(new Error("Sanity unavailable"));
    const route = require("../../app/api/content/[resource]/route");
    const response = await route.GET(
      new Request("https://example.com/api/content/hero"),
      { params: Promise.resolve({ resource: "hero" }) }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Public content is temporarily unavailable.",
    });
  });

  test("caches a complete Supabase content rollout at the edge", async () => {
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    process.env.SUPABASE_CONTENT_CANARY_PERCENT = "100";
    const route = require("../../app/api/content/[resource]/route");
    const response = await route.GET(
      new Request("https://example.com/api/content/benchmarks"),
      { params: Promise.resolve({ resource: "benchmarks" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-roo-content-backend")).toBe("supabase");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300"
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=600, stale-if-error=86400"
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  test("deduplicates warm Supabase content reads", async () => {
    const { fetchPublicContent } = require("../server/content/publicContent");
    const request = () =>
      fetchPublicContent({
        resource: "benchmarks",
        searchParams: new URLSearchParams(),
        backend: "supabase",
      });

    await expect(Promise.all([request(), request()])).resolves.toEqual([
      [{ _id: "benchmark-one" }],
      [{ _id: "benchmark-one" }],
    ]);
    await expect(request()).resolves.toEqual([{ _id: "benchmark-one" }]);
    expect(mockSupabaseFetch).toHaveBeenCalledTimes(1);
    expect(mockEnrichSupabaseContentAssets).toHaveBeenCalledTimes(1);
    expect(mockCreateSupabaseDocumentClient).toHaveBeenCalledWith({
      documentTypes: ["benchmark"],
    });
  });

  test("serves recent content when a Supabase refresh fails", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    const { fetchPublicContent } = require("../server/content/publicContent");
    const request = () =>
      fetchPublicContent({
        resource: "benchmarks",
        searchParams: new URLSearchParams(),
        backend: "supabase",
      });

    await expect(request()).resolves.toEqual([{ _id: "benchmark-one" }]);
    now.mockReturnValue(62_000);
    mockSupabaseFetch.mockRejectedValueOnce(new Error("Temporary outage"));
    await expect(request()).resolves.toEqual([{ _id: "benchmark-one" }]);
    expect(mockSupabaseFetch).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  test("the arbitrary Sanity proxy is permanently gone", async () => {
    const route = require("../../app/api/sanity/[...path]/route");
    const getResponse = await route.GET();
    const postResponse = await route.POST();
    expect(getResponse.status).toBe(410);
    expect(postResponse.status).toBe(410);
    await expect(getResponse.json()).resolves.toMatchObject({ ok: false });
    expect(getResponse.headers.get("cache-control")).toMatch(/no-store/);
  });

  test("checkout browser modules contain no persistent customer or payment storage", () => {
    const files = [
      "components/BookingForm.jsx",
      "components/Payment.jsx",
      "components/ReservationBanner.jsx",
      "components/RefRegister.jsx",
      "components/ReferralBox.jsx",
    ];
    files.forEach((relativePath) => {
      const source = fs.readFileSync(
        path.join(__dirname, "..", relativePath),
        "utf8"
      );
      expect(source).not.toMatch(/localStorage\.setItem\s*\(/);
    });
  });

  test("browser content connections stay same-origin", async () => {
    const configModule = await import("../../next.config.mjs");
    const headerRules = await configModule.default.headers();
    const globalRule = headerRules.find((rule) => rule.source === "/:path*");
    const csp = globalRule.headers.find(
      (header) => header.key === "Content-Security-Policy"
    ).value;
    const connectPolicy = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("connect-src "));

    expect(connectPolicy).toBeTruthy();
    expect(connectPolicy).not.toContain("*");
    expect(connectPolicy).not.toMatch(/sanity\.io/i);
    expect(connectPolicy).toContain("https://www.paypal.com");
    expect(connectPolicy).toContain("https://lumberjack.razorpay.com");

    const framePolicy = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("frame-src "));
    expect(framePolicy).toBeTruthy();
    expect(framePolicy).not.toContain("*");
    expect(framePolicy).toContain("https://checkout.razorpay.com");
  });

  test("permits migrated images only from the configured Supabase project", async () => {
    const configModule = await import("../../next.config.mjs");
    const headerRules = await configModule.default.headers();
    const globalRule = headerRules.find((rule) => rule.source === "/:path*");
    const csp = globalRule.headers.find(
      (header) => header.key === "Content-Security-Policy"
    ).value;
    const imagePolicy = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("img-src "));

    expect(imagePolicy).toBeTruthy();
    expect(imagePolicy).toContain(
      "https://ntezmxzaibrrsgtujgxu.supabase.co"
    );
    expect(imagePolicy).not.toContain("https://*.supabase.co");
  });

  test("public marketing content does not require a paid Sanity read token", async () => {
    delete process.env.SANITY_READ_TOKEN;
    delete process.env.SANITY_PRIVATE_READ_TOKEN;
    delete process.env.SANITY_WRITE_TOKEN;
    mockFetch.mockResolvedValueOnce({ headingLine1: "More FPS." });

    const { fetchPublicContent } = require("../server/content/publicContent");
    const result = await fetchPublicContent({
      resource: "hero",
      searchParams: new URLSearchParams(),
    });

    expect(result).toEqual({ headingLine1: "More FPS." });
    expect(mockCreateClient).toHaveBeenLastCalledWith({
      projectId: "project-test",
      dataset: "production",
      apiVersion: "2026-06-09",
      useCdn: true,
      perspective: "published",
    });
  });
});

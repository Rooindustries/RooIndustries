const fs = require("fs");
const path = require("path");

const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({ fetch: mockFetch }));
const mockSupabaseFetch = jest.fn();
const mockCreateSupabaseDocumentClient = jest.fn(() => ({
  fetch: mockSupabaseFetch,
}));
const mockEnrichSupabaseContentAssets = jest.fn(async ({ data }) => data);

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: (...args) => mockCreateClient(...args),
}));

jest.mock("../server/supabase/documentClient", () => ({
  createSupabaseDocumentClient: (...args) =>
    mockCreateSupabaseDocumentClient(...args),
}));

jest.mock("../server/supabase/assets", () => ({
  clearSupabaseAssetManifestCache: jest.fn(),
  enrichSupabaseContentAssets: (...args) =>
    mockEnrichSupabaseContentAssets(...args),
}));

describe("public content privacy boundary", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const {
      clearSupabasePublicContentCache,
    } = require("../server/content/publicContent");
    clearSupabasePublicContentCache();
    process.env.SANITY_PROJECT_ID = "project-test";
    process.env.SANITY_DATASET = "production";
    process.env.SANITY_READ_TOKEN = "server-only-read-token";
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL_ENV;
    delete process.env.SANITY_PRIVATE_PROJECT_ID;
    delete process.env.SANITY_PRIVATE_DATASET;
    delete process.env.SANITY_PRIVATE_API_VERSION;
    delete process.env.SANITY_PRIVATE_READ_TOKEN;
    delete process.env.SANITY_PRIVATE_WRITE_TOKEN;
    delete process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_SANITY_DATASET;
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    delete process.env.SUPABASE_CONTENT_CANARY_PERCENT;
    mockFetch.mockResolvedValue({ title: "Public copy" });
    mockSupabaseFetch.mockReset();
    mockSupabaseFetch.mockResolvedValue([{ _id: "benchmark-one" }]);
    mockEnrichSupabaseContentAssets.mockReset();
    mockEnrichSupabaseContentAssets.mockImplementation(
      async ({ data }) => data,
    );
  });

  test("uses a fixed server projection and never accepts caller GROQ", async () => {
    const { fetchPublicContent } = require("../server/content/publicContent");
    mockSupabaseFetch.mockResolvedValueOnce({title:"Public copy"});
    const data = await fetchPublicContent({
      resource: "hero",
      searchParams: new URLSearchParams(),
    });

    expect(data).toEqual({ title: "Public copy" });
    expect(mockSupabaseFetch).toHaveBeenCalledTimes(1);
    expect(mockSupabaseFetch.mock.calls[0][0]).toContain('_type == "hero"');
    expect(mockSupabaseFetch.mock.calls[0][0]).not.toContain("booking");
    expect(mockSupabaseFetch.mock.calls[0][1]).toEqual({});
    expect(mockCreateClient).not.toHaveBeenCalled();

    await expect(
      fetchPublicContent({
        resource: "hero",
        searchParams: new URLSearchParams(
          "query=*%5B_type%20%3D%3D%20'booking'%5D",
        ),
      }),
    ).rejects.toThrow(/unsupported content parameter/i);
    expect(mockSupabaseFetch).toHaveBeenCalledTimes(1);
  });

  test("rejects unknown resources and non-allowlisted package parameters", async () => {
    const { fetchPublicContent } = require("../server/content/publicContent");
    await expect(
      fetchPublicContent({
        resource: "booking",
        searchParams: new URLSearchParams(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      fetchPublicContent({
        resource: "package",
        searchParams: new URLSearchParams(),
      }),
    ).rejects.toThrow(/valid package title/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("server content outages return 503 instead of masquerading as caller errors", async () => {
    delete process.env.SANITY_READ_TOKEN;
    delete process.env.SANITY_PRIVATE_READ_TOKEN;
    delete process.env.SANITY_WRITE_TOKEN;
    mockSupabaseFetch.mockRejectedValueOnce(new Error("Supabase unavailable"));
    const route = require("../../app/api/content/[resource]/route");
    const response = await route.GET(
      new Request("https://example.com/api/content/hero"),
      { params: Promise.resolve({ resource: "hero" }) },
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
      { params: Promise.resolve({ resource: "benchmarks" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-roo-content-backend")).toBe("supabase");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=600, stale-if-error=86400",
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

  ;

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
        "utf8",
      );
      expect(source).not.toMatch(/localStorage\.setItem\s*\(/);
    });
  });

  test("browser content connections stay same-origin", async () => {
    const configModule = await import("../../next.config.mjs");
    const headerRules = await configModule.default.headers();
    const globalRule = headerRules.find((rule) => rule.source === "/:path*");
    const csp = globalRule.headers.find(
      (header) => header.key === "Content-Security-Policy",
    ).value;
    const connectPolicy = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("connect-src "));

    expect(connectPolicy).toBeTruthy();
    expect(connectPolicy).not.toContain("*");
    expect(connectPolicy).not.toMatch(/sanity\.io/i);
    expect(connectPolicy).toContain("https://ntezmxzaibrrsgtujgxu.supabase.co");
    expect(connectPolicy).not.toContain("https://*.supabase.co");
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
      (header) => header.key === "Content-Security-Policy",
    ).value;
    const imagePolicy = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("img-src "));

    expect(imagePolicy).toBeTruthy();
    expect(imagePolicy).toContain("https://ntezmxzaibrrsgtujgxu.supabase.co");
    expect(imagePolicy).toContain("https://d15f34w2p8l1cc.cloudfront.net");
    expect(imagePolicy).toContain("https://overfast-api.tekrop.fr");
    expect(imagePolicy).not.toContain("https://*.supabase.co");
  });

  test("D1 public marketing reads only Supabase", async () => {
    delete process.env.SANITY_READ_TOKEN;
    delete process.env.SANITY_PRIVATE_READ_TOKEN;
    delete process.env.SANITY_WRITE_TOKEN;
    mockSupabaseFetch.mockResolvedValueOnce({ headingLine1: "More FPS." });

    const { fetchPublicContent } = require("../server/content/publicContent");
    const result = await fetchPublicContent({
      resource: "hero",
      searchParams: new URLSearchParams(),
    });

    expect(result).toEqual({ headingLine1: "More FPS." });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  ;

  ;

  ;
});

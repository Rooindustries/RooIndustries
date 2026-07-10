const fs = require("fs");
const path = require("path");

const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({ fetch: mockFetch }));

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

describe("public content privacy boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SANITY_PROJECT_ID = "project-test";
    process.env.SANITY_DATASET = "production";
    process.env.SANITY_READ_TOKEN = "server-only-read-token";
    mockFetch.mockResolvedValue({ title: "Public copy" });
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

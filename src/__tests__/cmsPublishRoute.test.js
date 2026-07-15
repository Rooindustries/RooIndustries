/** @jest-environment node */

const mockExecuteGlobalCmsCommand = jest.fn();
const mockSupabaseClient = { rpc: jest.fn() };
const { createSupabaseAdminClient: mockCreateSupabaseAdminClient } = jest.requireMock(
  "../server/supabase/adminClient.js",
);

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
  },
}));

jest.mock("../server/cms/publishCommand.js", () => ({
  executeGlobalCmsCommand: (...args) => mockExecuteGlobalCmsCommand(...args),
}));

jest.mock("../server/supabase/adminClient.js", () => ({
  createSupabaseAdminClient: jest.fn(() => mockSupabaseClient),
}));

jest.mock("../server/safeErrorLog.js", () => ({ logSafeError: jest.fn() }));

const studioOrigin = "https://rooindustries.sanity.studio";

describe("global CMS publish route", () => {
  const previousCmsWritesPaused = process.env.CMS_WRITES_PAUSED;
  const previousStudioCmsWritesPaused =
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CMS_WRITES_PAUSED = "0";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "0";
    mockExecuteGlobalCmsCommand.mockResolvedValue({
      commandId: `cms:${"a".repeat(64)}`,
      committed: true,
      documentId: "about.main",
      operation: "publish",
      replayed: false,
      syncPending: false,
    });
  });

  afterAll(() => {
    if (previousCmsWritesPaused === undefined) {
      delete process.env.CMS_WRITES_PAUSED;
    } else {
      process.env.CMS_WRITES_PAUSED = previousCmsWritesPaused;
    }
    if (previousStudioCmsWritesPaused === undefined) {
      delete process.env.SANITY_STUDIO_CMS_WRITES_PAUSED;
    } else {
      process.env.SANITY_STUDIO_CMS_WRITES_PAUSED =
        previousStudioCmsWritesPaused;
    }
  });

  test("accepts only the exact Studio origin and forwards the bearer token", async () => {
    const { POST } = await import("../../app/api/admin/cms-publish/route.js");
    const body = {
      projectId: "9g42k3ur",
      dataset: "production",
      operation: "publish",
      type: "about",
      documentId: "about.main",
      document: { _id: "about.main", _type: "about" },
      sourceRevision: "revision-1",
      assetManifest: [],
    };
    const response = await POST(
      new Request("https://www.rooindustries.com/api/admin/cms-publish", {
        method: "POST",
        headers: {
          Authorization: "Bearer studio-token",
          "Content-Type": "application/json",
          Origin: studioOrigin,
        },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      studioOrigin,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockExecuteGlobalCmsCommand).toHaveBeenCalledWith({
      body,
      authorization: "Bearer studio-token",
      supabaseClient: mockSupabaseClient,
    });
  });

  test("rejects a lookalike origin before creating a database client", async () => {
    const { POST } = await import("../../app/api/admin/cms-publish/route.js");
    const response = await POST(
      new Request("https://www.rooindustries.com/api/admin/cms-publish", {
        method: "POST",
        headers: { Origin: `${studioOrigin}.attacker.test` },
        body: "{}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("CMS_ORIGIN_DENIED");
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockExecuteGlobalCmsCommand).not.toHaveBeenCalled();
  });

  test("rejects an oversized request without running the command", async () => {
    const { POST } = await import("../../app/api/admin/cms-publish/route.js");
    const response = await POST(
      new Request("https://www.rooindustries.com/api/admin/cms-publish", {
        method: "POST",
        headers: { Origin: studioOrigin },
        body: "x".repeat(1024 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(mockExecuteGlobalCmsCommand).not.toHaveBeenCalled();
  });

  test("rejects commands before reading the body while CMS writes are paused", async () => {
    process.env.CMS_WRITES_PAUSED = "1";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "1";
    const { POST } = await import("../../app/api/admin/cms-publish/route.js");
    const response = await POST(
      new Request("https://www.rooindustries.com/api/admin/cms-publish", {
        method: "POST",
        headers: { Origin: studioOrigin },
        body: "{}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("CMS_WRITES_PAUSED");
    expect(mockExecuteGlobalCmsCommand).not.toHaveBeenCalled();
  });

  test("rejects mismatched API and Studio pause controls", async () => {
    process.env.CMS_WRITES_PAUSED = "0";
    process.env.SANITY_STUDIO_CMS_WRITES_PAUSED = "1";
    const { POST } = await import("../../app/api/admin/cms-publish/route.js");
    const response = await POST(
      new Request("https://www.rooindustries.com/api/admin/cms-publish", {
        method: "POST",
        headers: { Origin: studioOrigin },
        body: "{}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("CMS_WRITE_CONTROL_MISMATCH");
    expect(mockExecuteGlobalCmsCommand).not.toHaveBeenCalled();
  });
});

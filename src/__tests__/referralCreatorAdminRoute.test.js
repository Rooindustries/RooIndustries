const mockList = jest.fn();
const mockHistory = jest.fn();
const mockUpdate = jest.fn();
const mockFlush = jest.fn();
const mockClient = { rpc: jest.fn() };

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/referrals/creatorTerms", () => ({
  flushCreatorTermsMirror: (...args) => mockFlush(...args),
  getCreatorTermsHistory: (...args) => mockHistory(...args),
  listCreatorTerms: (...args) => mockList(...args),
  updateCreatorTerms: (...args) => mockUpdate(...args),
}));
jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => mockClient,
}));
jest.mock("../server/supabase/runtime", () => ({
  resolveSupabaseRuntimePolicy: () => ({ commerceFailoverGeneration: 1 }),
}));

const { GET, PATCH } = require("../../app/api/admin/referral-creators/route");
const originalAdminKey = process.env.REF_ADMIN_KEY;

const request = ({
  key = "admin-secret",
  body,
  creatorId = "",
  search = "",
  offset,
  limit,
} = {}) => {
  const parameters = new URLSearchParams();
  if (creatorId) parameters.set("creatorId", creatorId);
  if (search) parameters.set("search", search);
  if (offset !== undefined) parameters.set("offset", String(offset));
  if (limit !== undefined) parameters.set("limit", String(limit));
  return {
    url: `https://www.rooindustries.com/api/admin/referral-creators${
      parameters.size > 0 ? `?${parameters}` : ""
    }`,
    headers: { get: (name) => name === "x-admin-key" ? key : "" },
    text: async () => JSON.stringify(body),
  };
};

describe("referral creator admin route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REF_ADMIN_KEY = "admin-secret";
    mockList.mockResolvedValue([{ creator_id: "creator-1" }]);
    mockHistory.mockResolvedValue([{ id: "audit-1" }]);
    mockUpdate.mockResolvedValue({
      creator_id: "10000000-0000-4000-8000-000000000001",
      legacy_sanity_id: "referral.creator",
      terms_version: 2,
    });
    mockFlush.mockResolvedValue({ syncPending: false });
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = originalAdminKey;
  });

  test("hides the endpoint from requests without the admin key", async () => {
    const response = await GET(request({ key: "wrong" }));
    expect(response.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  test("returns creator terms and selected audit history", async () => {
    const creatorId = "10000000-0000-4000-8000-000000000001";
    const response = await GET(request({ creatorId }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      creators: [{ creator_id: "creator-1" }],
      history: [{ id: "audit-1" }],
      hasMore: false,
      nextOffset: 1,
    });
    expect(mockHistory).toHaveBeenCalledWith({ client: mockClient, creatorId });
  });

  test("searches and paginates on the server", async () => {
    mockList.mockResolvedValue(
      Array.from({ length: 26 }, (_, index) => ({ creator_id: `creator-${index}` }))
    );
    const response = await GET(request({
      search: "owsupa@example.com",
      offset: 100,
      limit: 25,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      creators: expect.arrayContaining([{ creator_id: "creator-0" }]),
      hasMore: true,
      nextOffset: 125,
    });
    expect((await response.json()).creators).toHaveLength(25);
    expect(mockList).toHaveBeenCalledWith({
      client: mockClient,
      search: "owsupa@example.com",
      limit: 26,
      offset: 100,
    });
  });

  test("updates Supabase before attempting the Sanity fallback mirror", async () => {
    const body = { creatorId: "10000000-0000-4000-8000-000000000001" };
    const response = await PATCH(request({ body }));
    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      client: mockClient,
      input: body,
      cutoverGeneration: 1,
    });
    expect(mockFlush).toHaveBeenCalledWith({
      client: mockClient,
      legacySanityId: "referral.creator",
    });
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockFlush.mock.invocationCallOrder[0]
    );
  });

  test("maps optimistic concurrency conflicts to a reload response", async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error("version conflict"), {
      code: "40001",
    }));
    const response = await PATCH(request({ body: {} }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Reload"),
    });
    expect(mockFlush).not.toHaveBeenCalled();
  });
});

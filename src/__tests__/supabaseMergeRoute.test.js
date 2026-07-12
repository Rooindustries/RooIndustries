const mockRpc = jest.fn();
const mockReadReauthToken = jest.fn();

const createResponse = (payload, init = {}) => {
  const headers = new Map();
  const cookies = [];
  return {
    status: init.status || 200,
    json: async () => payload,
    headers: {
      get: (name) => headers.get(String(name).toLowerCase()) || null,
      set: (name, value) => headers.set(String(name).toLowerCase(), String(value)),
    },
    cookies: {
      set: (...args) => cookies.push(args.length === 1 ? args[0] : args),
      values: cookies,
    },
  };
};

jest.mock("next/server", () => ({
  NextResponse: { json: (payload, init) => createResponse(payload, init) },
}));

jest.mock("../server/supabase/adminClient", () => ({
  createSupabaseAdminClient: () => ({ rpc: (...args) => mockRpc(...args) }),
}));

jest.mock("../server/supabase/reauth", () => ({
  clearReauthCookie: (slot) => ({
    name: `roo_reauth_${slot}`,
    value: "",
    maxAge: 0,
  }),
  hashReauthToken: (value) => `hash:${value}`,
  readReauthToken: (...args) => mockReadReauthToken(...args),
}));

const { POST } = require("../../app/api/auth/merge/route.js");

const request = {
  url: "https://www.rooindustries.com/api/auth/merge",
  headers: {
    get: (name) =>
      String(name).toLowerCase() === "origin"
        ? "https://www.rooindustries.com"
        : "",
  },
};

describe("Supabase account merge route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadReauthToken.mockImplementation((_request, slot) => `${slot}-grant`);
  });

  test("merges only from two HttpOnly proof cookies", async () => {
    mockRpc.mockResolvedValue({
      data: { principal_id: "11111111-1111-4111-8111-111111111111" },
      error: null,
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("roo_merge_account_principals", {
      p_primary_grant_hash: "hash:primary-grant",
      p_secondary_grant_hash: "hash:secondary-grant",
    });
    expect(response.cookies.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "roo_reauth_primary", maxAge: 0 }),
        expect.objectContaining({ name: "roo_reauth_secondary", maxAge: 0 }),
      ])
    );
  });

  test("returns an administrator-review conflict instead of merging domain records", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "23505" } });
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error).toContain("administrator");
  });

  test("requires both recent authentication proofs", async () => {
    mockReadReauthToken.mockImplementation((_request, slot) =>
      slot === "primary" ? "primary-grant" : ""
    );
    const response = await POST(request);
    expect(response.status).toBe(409);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

const mockReadSnapshot = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: Object.assign(
    function NextResponse(body, init = {}) {
      return { status: init.status || 200, body, headers: init.headers || {} };
    },
    {
      json: (body, init = {}) => ({
        status: init.status || 200,
        json: async () => body,
        headers: init.headers || {},
      }),
    }
  ),
}));

jest.mock("../server/tourney/publicBracketApi", () => {
  const actual = jest.requireActual("../server/tourney/publicBracketApi.js");
  return {
    ...actual,
    readPublicBracketApiSnapshot: (...args) => mockReadSnapshot(...args),
  };
});

const snapshot = {
  ok: true,
  generated: true,
  meta: { updatedAt: "2026-07-28T10:00:00.000Z", published: true },
  teams: [{ id: "team_1", name: "Alpha", seed: 1, status: "active" }],
  matches: [
    {
      id: 1,
      number: 1,
      roundNumber: 1,
      groupNumber: 1,
      groupName: "Winners",
      label: "Winners R1 M1",
      displayLabel: "Winners Quarterfinal 1",
      status: 3,
      statusLabel: "Running",
      bestOf: 5,
      targetScore: 3,
      opponent1: {
        side: "opponent1",
        participantId: 11,
        teamId: "team_1",
        name: "Alpha",
        score: 2,
        result: "",
        forfeit: false,
        status: "active",
      },
      opponent2: {
        side: "opponent2",
        participantId: 12,
        teamId: "team_2",
        name: "Bravo",
        score: 1,
        result: "",
        forfeit: false,
        status: "active",
      },
      nextLabels: [],
    },
  ],
  groups: [],
  audit: [],
};

const makeRequest = (url) => ({ url });

describe("tourney public API routes", () => {
  beforeEach(() => {
    mockReadSnapshot.mockReset();
    mockReadSnapshot.mockResolvedValue(snapshot);
  });

  test("GET /api/tourney/v1/bracket returns the bracket with open CORS and CDN caching", async () => {
    const { GET } = require("../../app/api/tourney/v1/bracket/route.js");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.apiVersion).toBe("1");
    expect(body.version).toMatch(/^[a-f0-9]{16}$/);
    expect(body.matches[0]).toMatchObject({ status: "running", live: true });
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(response.headers["Cache-Control"]).toContain("s-maxage=5");
  });

  test("GET /api/tourney/v1/bracket returns 503 with CORS headers when the store fails", async () => {
    mockReadSnapshot.mockRejectedValue(new Error("db down"));
    const { GET } = require("../../app/api/tourney/v1/bracket/route.js");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  test("GET /api/tourney/v1/matches filters by status and group", async () => {
    const { GET } = require("../../app/api/tourney/v1/matches/route.js");
    const response = await GET(
      makeRequest("https://www.rooindustries.com/api/tourney/v1/matches?status=running&group=winners")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.matches[0].status).toBe("running");
  });

  test("GET /api/tourney/v1/matches rejects bad filters with a 400", async () => {
    const { GET } = require("../../app/api/tourney/v1/matches/route.js");
    const badStatus = await GET(
      makeRequest("https://www.rooindustries.com/api/tourney/v1/matches?status=nope")
    );
    expect(badStatus.status).toBe(400);
    expect((await badStatus.json()).ok).toBe(false);

    const badGroup = await GET(
      makeRequest("https://www.rooindustries.com/api/tourney/v1/matches?group=playoffs")
    );
    expect(badGroup.status).toBe(400);
  });

  test("GET /api/tourney/v1/matches/live returns live and up-next sections", async () => {
    const { GET } = require("../../app/api/tourney/v1/matches/live/route.js");
    const response = await GET(
      makeRequest("https://www.rooindustries.com/api/tourney/v1/matches/live")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.live).toHaveLength(1);
    expect(body.live[0].status).toBe("running");
    expect(body.upNext).toHaveLength(0);
  });

  test("OPTIONS preflight answers 204 with CORS headers", async () => {
    const { OPTIONS } = require("../../app/api/tourney/v1/bracket/route.js");
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(response.headers["Access-Control-Allow-Methods"]).toContain("GET");
  });
});

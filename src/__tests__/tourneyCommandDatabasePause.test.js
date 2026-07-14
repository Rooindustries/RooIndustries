const mockRunTransaction = jest.fn();

jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySqlForBackend: jest.fn(),
  isSupabaseTourneyDatabase: (env) => env.TOURNEY_DATABASE_MODE === "supabase",
  runTourneyTransaction: (...args) => mockRunTransaction(...args),
}));

const { executeTourneyCommand } = require("../server/tourney/store");

const env = {
  NODE_ENV: "production",
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "0",
  TOURNEY_FAILOVER_GENERATION: "1",
};

const createSql = ({ writesPaused, controlExists = true }) => {
  const sql = jest.fn(async (strings) => {
    if (!Array.isArray(strings)) return strings;
    const query = strings.join(" ");
    if (query.includes("select primary_backend, generation, writes_paused")) {
      return controlExists ? [{
        primary_backend: "supabase",
        generation: 1,
        writes_paused: writesPaused,
      }] : [];
    }
    if (query.includes("insert into")) {
      return [{ command_id: "command-database-pause-0001" }];
    }
    return [];
  });
  sql.json = (value) => value;
  return sql;
};

describe("Tourney authoritative database write pause", () => {
  beforeEach(() => jest.clearAllMocks());

  test("keeps the deployment pause as a database-free fast rejection", async () => {
    const callback = jest.fn(async () => ({ body: { ok: true } }));

    await expect(executeTourneyCommand({
      commandId: "command-deployment-pause-0001",
      purpose: "players:update-role",
      requestPayload: {},
      env: { ...env, TOURNEY_WRITES_PAUSED: "1" },
      callback,
    })).rejects.toMatchObject({
      code: "TOURNEY_WRITES_PAUSED",
      status: 503,
      retryAfter: 30,
    });
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  test("rejects an ordinary command when only the database pause is active", async () => {
    const sql = createSql({ writesPaused: true });
    const callback = jest.fn(async () => ({ body: { ok: true } }));
    mockRunTransaction.mockImplementation(async ({ callback: transaction }) =>
      transaction(sql)
    );

    await expect(executeTourneyCommand({
      commandId: "command-database-pause-0001",
      purpose: "players:update-role",
      requestPayload: {},
      env,
      callback,
    })).rejects.toMatchObject({
      code: "TOURNEY_WRITES_PAUSED",
      status: 503,
      retryAfter: 30,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  test("fails closed when the database control row is unavailable", async () => {
    const sql = createSql({ writesPaused: false, controlExists: false });
    const callback = jest.fn(async () => ({ body: { ok: true } }));
    mockRunTransaction.mockImplementation(async ({ callback: transaction }) =>
      transaction(sql)
    );

    await expect(executeTourneyCommand({
      commandId: "command-database-pause-0001",
      purpose: "players:update-role",
      requestPayload: {},
      env,
      callback,
    })).rejects.toMatchObject({
      code: "TOURNEY_CONTROL_UNAVAILABLE",
      status: 503,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  test("preserves the explicit maintenance bypass inside the transaction", async () => {
    const sql = createSql({ writesPaused: true });
    const callback = jest.fn(async () => ({ body: { ok: true } }));
    mockRunTransaction.mockImplementation(async ({ callback: transaction }) =>
      transaction(sql)
    );

    await expect(executeTourneyCommand({
      commandId: "command-database-pause-0001",
      purpose: "accounts:seed",
      requestPayload: {},
      env,
      maintenanceWhilePaused: true,
      attemptExternalWork: false,
      callback,
    })).resolves.toMatchObject({ status: 200, syncPending: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

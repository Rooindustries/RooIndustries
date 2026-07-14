const crypto = require("node:crypto");

const mockRunTransaction = jest.fn();

jest.mock("../server/tourney/sqlClient", () => ({
  getTourneySqlForBackend: jest.fn(),
  isSupabaseTourneyDatabase: (env) => env.TOURNEY_DATABASE_MODE === "supabase",
  runTourneyTransaction: (...args) => mockRunTransaction(...args),
}));

const { stableTourneyJson } = require("../server/tourney/canonical");
const { executeTourneyCommand } = require("../server/tourney/store");

const baseEnv = {
  NODE_ENV: "production",
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_WRITES_PAUSED: "0",
  TOURNEY_FAILOVER_GENERATION: "1",
  TOURNEY_HARDENING_V4_ENABLED: "1",
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const hmacSha256 = (value, secret) =>
  crypto.createHmac("sha256", secret).update(value).digest("hex");
const requestMaterial = (purpose, requestPayload) =>
  stableTourneyJson({ purpose, requestPayload });

const createReceiptSql = ({ receipt = null } = {}) => {
  const state = {
    receipt: receipt ? { ...receipt } : null,
    insertedHashes: [],
  };
  const sql = jest.fn((strings, ...values) => {
    if (!Array.isArray(strings)) return strings;
    const query = strings.join(" ").replace(/\s+/g, " ");
    if (query.includes("select primary_backend, generation, writes_paused")) {
      return Promise.resolve([{
        primary_backend: "supabase",
        generation: 1,
        writes_paused: false,
      }]);
    }
    if (query.includes("insert into") && query.includes("command_id, purpose, request_hash")) {
      const [, commandId, purpose, requestHash] = values;
      state.insertedHashes.push(requestHash);
      if (state.receipt) return Promise.resolve([]);
      state.receipt = {
        command_id: commandId,
        purpose,
        request_hash: requestHash,
        status: "processing",
        result_status: null,
        result_body: null,
      };
      return Promise.resolve([{ command_id: commandId }]);
    }
    if (query.includes("select purpose, request_hash, status")) {
      return Promise.resolve(state.receipt ? [{ ...state.receipt }] : []);
    }
    if (query.includes("set status = 'committed'")) {
      const [, status, body] = values;
      state.receipt = {
        ...state.receipt,
        status: "committed",
        result_status: status,
        result_body: body,
      };
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  sql.json = (value) => value;
  return { sql, state };
};

const useSql = (sql) => {
  mockRunTransaction.mockImplementation(async ({ callback }) => callback(sql));
};

describe("Tourney command receipt request hashing", () => {
  beforeEach(() => jest.clearAllMocks());

  test("writes only a keyed HMAC for a new schema-v4 receipt", async () => {
    const secret = "dedicated-idempotency-secret-for-tests";
    const password = "correct horse battery staple";
    const requestPayload = { email: "player@example.com", password };
    const material = requestMaterial("registration:create", requestPayload);
    const { sql, state } = createReceiptSql();
    useSql(sql);

    await executeTourneyCommand({
      commandId: "command-hmac-registration-0001",
      purpose: "registration:create",
      requestPayload,
      env: {
        ...baseEnv,
        TOURNEY_IDEMPOTENCY_SECRET: secret,
        TOURNEY_SESSION_SECRET: "unused-session-secret",
      },
      attemptExternalWork: false,
      callback: async () => ({ status: 201, body: { ok: true } }),
    });

    expect(state.insertedHashes).toEqual([hmacSha256(material, secret)]);
    expect(state.insertedHashes[0]).not.toBe(sha256(material));
    expect(state.insertedHashes[0]).not.toBe(sha256(password));
    expect(JSON.stringify(state.receipt)).not.toContain(password);
    expect(state.receipt).not.toHaveProperty("requestPayload");
  });

  test("falls back to the Tourney session secret when no dedicated secret exists", async () => {
    const secret = "session-secret-for-idempotency-tests";
    const requestPayload = { playerId: "player_1", role: "host" };
    const material = requestMaterial("players:update-role", requestPayload);
    const { sql, state } = createReceiptSql();
    useSql(sql);

    await executeTourneyCommand({
      commandId: "command-hmac-session-fallback-0001",
      purpose: "players:update-role",
      requestPayload,
      env: { ...baseEnv, TOURNEY_SESSION_SECRET: secret },
      attemptExternalWork: false,
      callback: async () => ({ body: { ok: true } }),
    });

    expect(state.insertedHashes).toEqual([hmacSha256(material, secret)]);
  });

  test("fails closed before opening a transaction when schema v4 has no signing secret", async () => {
    const callback = jest.fn(async () => ({ body: { ok: true } }));

    await expect(executeTourneyCommand({
      commandId: "command-hmac-missing-secret-0001",
      purpose: "registration:create",
      requestPayload: { password: "not-stored" },
      env: baseEnv,
      callback,
    })).rejects.toMatchObject({
      code: "TOURNEY_IDEMPOTENCY_SECRET_REQUIRED",
      status: 503,
    });

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  test("replays the same password request and conflicts on a different password", async () => {
    const env = { ...baseEnv, TOURNEY_IDEMPOTENCY_SECRET: "replay-test-secret" };
    const callback = jest.fn(async () => ({ body: { ok: true, playerId: "player_1" } }));
    const { sql } = createReceiptSql();
    useSql(sql);
    const command = {
      commandId: "command-hmac-password-replay-0001",
      purpose: "registration:create",
      env,
      attemptExternalWork: false,
      callback,
    };

    const first = await executeTourneyCommand({
      ...command,
      requestPayload: { email: "player@example.com", password: "same-password" },
    });
    const replay = await executeTourneyCommand({
      ...command,
      requestPayload: { email: "player@example.com", password: "same-password" },
    });

    expect(first).toMatchObject({ replayed: false, status: 200 });
    expect(replay).toMatchObject({ replayed: true, status: 200 });
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(executeTourneyCommand({
      ...command,
      requestPayload: { email: "player@example.com", password: "different-password" },
    })).rejects.toMatchObject({
      code: "TOURNEY_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("replays an existing legacy unkeyed receipt during the schema-v4 rollout", async () => {
    const purpose = "registration:create";
    const requestPayload = { email: "legacy@example.com", password: "legacy-password" };
    const legacyHash = sha256(requestMaterial(purpose, requestPayload));
    const callback = jest.fn(async () => ({ body: { ok: false } }));
    const { sql, state } = createReceiptSql({
      receipt: {
        command_id: "command-legacy-hash-replay-0001",
        purpose,
        request_hash: legacyHash,
        status: "completed",
        result_status: 201,
        result_body: { ok: true, playerId: "legacy-player" },
      },
    });
    useSql(sql);

    const result = await executeTourneyCommand({
      commandId: "command-legacy-hash-replay-0001",
      purpose,
      requestPayload,
      env: { ...baseEnv, TOURNEY_IDEMPOTENCY_SECRET: "new-hmac-secret" },
      callback,
    });

    expect(result).toMatchObject({
      replayed: true,
      status: 201,
      body: { ok: true, playerId: "legacy-player", replayed: true },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(state.receipt.request_hash).toBe(legacyHash);
    expect(state.insertedHashes[0]).toBe(hmacSha256(
      requestMaterial(purpose, requestPayload),
      "new-hmac-secret"
    ));
  });
});
